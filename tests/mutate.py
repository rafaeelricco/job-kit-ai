#!/usr/bin/env python3
"""Mutate each shipped script, run its own suite, and report what survived.

A surviving mutant is a line the suite executes but does not pin: the code changed
and every test still passed. Operators are data — a tuple of frozen records pairing
a name with a pure ``ast.AST -> Optional[ast.AST]`` rewrite — so adding one is
appending to a tuple, not extending a branch.

Requires Python 3.9+ for ``ast.unparse``; below that the harness reports that it
skipped itself, because the shipped scripts must keep working on older interpreters.
"""

import argparse
import ast
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, FrozenSet, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import REPO, TARGETS, Target  # noqa: E402

Outcome = str  # one of OUTCOMES
Rewrite = Callable[[ast.AST], Optional[ast.AST]]

KILLED: Outcome = "killed"
SURVIVED: Outcome = "survived"
TIMEOUT: Outcome = "timeout"
ERROR: Outcome = "error"
OUTCOMES: Tuple[Outcome, ...] = (KILLED, SURVIVED, TIMEOUT, ERROR)

COMPARE_FLIP: Dict[type, type] = {
    ast.Gt: ast.GtE,
    ast.GtE: ast.Gt,
    ast.Lt: ast.LtE,
    ast.LtE: ast.Lt,
    ast.Eq: ast.NotEq,
    ast.NotEq: ast.Eq,
}
MEMBERSHIP_FLIP: Dict[type, type] = {ast.In: ast.NotIn, ast.NotIn: ast.In}
ARITH_FLIP: Dict[type, type] = {
    ast.Add: ast.Sub,
    ast.Sub: ast.Add,
    ast.Mult: ast.Div,
    ast.Div: ast.Mult,
}


@dataclass(frozen=True)
class Operator:
    name: str
    rewrite: Rewrite


@dataclass(frozen=True)
class Mutant:
    operator: str
    lineno: int
    line: str
    source: str

    def describe(self, target: Target) -> str:
        return f"{target.relative}:{self.lineno}  {self.operator}  {self.line.strip()}"


@dataclass(frozen=True)
class Verdict:
    mutant: Mutant
    outcome: Outcome


@dataclass(frozen=True)
class Report:
    target: Target
    verdicts: Tuple[Verdict, ...]

    @property
    def killed(self) -> int:
        """Mutants the suite caught. A hang the original did not have counts."""
        return sum(1 for v in self.verdicts if v.outcome in (KILLED, TIMEOUT))

    @property
    def survivors(self) -> Tuple[Verdict, ...]:
        return tuple(v for v in self.verdicts if v.outcome == SURVIVED)

    @property
    def errors(self) -> Tuple[Verdict, ...]:
        return tuple(v for v in self.verdicts if v.outcome == ERROR)

    @property
    def scored(self) -> int:
        return self.killed + len(self.survivors)

    @property
    def score(self) -> float:
        """Killed as a fraction of every non-error verdict; 1.0 when none apply."""
        return 1.0 if self.scored == 0 else self.killed / self.scored


def _flip_compare(node: ast.AST) -> Optional[ast.AST]:
    if not isinstance(node, ast.Compare) or len(node.ops) != 1:
        return None
    replacement = COMPARE_FLIP.get(type(node.ops[0]))
    if replacement is None:
        return None
    return ast.Compare(left=node.left, ops=[replacement()], comparators=node.comparators)


def _flip_membership(node: ast.AST) -> Optional[ast.AST]:
    if not isinstance(node, ast.Compare) or len(node.ops) != 1:
        return None
    replacement = MEMBERSHIP_FLIP.get(type(node.ops[0]))
    if replacement is None:
        return None
    return ast.Compare(left=node.left, ops=[replacement()], comparators=node.comparators)


def _flip_boolop(node: ast.AST) -> Optional[ast.AST]:
    if not isinstance(node, ast.BoolOp):
        return None
    replacement = ast.Or() if isinstance(node.op, ast.And) else ast.And()
    return ast.BoolOp(op=replacement, values=node.values)


def _toggle_not(node: ast.AST) -> Optional[ast.AST]:
    """Drop an existing ``not``, or negate an ``if`` test that has none."""
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return node.operand
    if isinstance(node, ast.If) and not (
        isinstance(node.test, ast.UnaryOp) and isinstance(node.test.op, ast.Not)
    ):
        return ast.If(
            test=ast.UnaryOp(op=ast.Not(), operand=node.test),
            body=node.body,
            orelse=node.orelse,
        )
    return None


def _swap_arith(node: ast.AST) -> Optional[ast.AST]:
    if not isinstance(node, ast.BinOp):
        return None
    replacement = ARITH_FLIP.get(type(node.op))
    if replacement is None:
        return None
    return ast.BinOp(left=node.left, op=replacement(), right=node.right)


def _shift_int(node: ast.AST) -> Optional[ast.AST]:
    if not isinstance(node, ast.Constant) or isinstance(node.value, bool):
        return None
    if not isinstance(node.value, int):
        return None
    return ast.Constant(value=node.value + 1)


def _blank_str(node: ast.AST) -> Optional[ast.AST]:
    if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
        return None
    if node.value == "":
        return None
    return ast.Constant(value="")


def _return_none(node: ast.AST) -> Optional[ast.AST]:
    if not isinstance(node, ast.Return) or node.value is None:
        return None
    if isinstance(node.value, ast.Constant) and node.value.value is None:
        return None
    return ast.Return(value=ast.Constant(value=None))


OPERATORS: Tuple[Operator, ...] = (
    Operator("compare", _flip_compare),
    Operator("membership", _flip_membership),
    Operator("boolop", _flip_boolop),
    Operator("unary_not", _toggle_not),
    Operator("arith", _swap_arith),
    Operator("const_int", _shift_int),
    Operator("const_str", _blank_str),
    Operator("return_none", _return_none),
)


def _docstring_nodes(tree: ast.AST) -> FrozenSet[int]:
    """Ids of Constant nodes that are docstrings — mutating them is a no-op."""
    found = set()
    for node in ast.walk(tree):
        if not isinstance(
            node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
        ):
            continue
        body = getattr(node, "body", ())
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            found.add(id(body[0].value))
    return frozenset(found)


class _Apply(ast.NodeTransformer):
    """Rewrite the ``target``-th applicable node; count them all when target is -1."""

    def __init__(self, rewrite: Rewrite, target: int, skip: FrozenSet[int]) -> None:
        self.rewrite = rewrite
        self.target = target
        self.skip = skip
        self.count = 0
        self.lineno: Optional[int] = None

    def generic_visit(self, node: ast.AST) -> ast.AST:
        node = super().generic_visit(node)
        if id(node) in self.skip:
            return node
        replacement = self.rewrite(node)
        if replacement is None:
            return node
        index = self.count
        self.count += 1
        if index != self.target:
            return node
        self.lineno = getattr(node, "lineno", None)
        return ast.fix_missing_locations(ast.copy_location(replacement, node))


def mutants(target: Target, operators: Sequence[Operator] = OPERATORS) -> Tuple[Mutant, ...]:
    """Every mutant for one module. Pure: parses text, touches no disk."""
    text = target.module.read_text(encoding="utf-8")
    lines = text.splitlines()
    found = []
    for operator in operators:
        counter = _Apply(operator.rewrite, -1, _docstring_nodes(ast.parse(text)))
        counter.visit(ast.parse(text))
        for index in range(counter.count):
            tree = ast.parse(text)
            applier = _Apply(operator.rewrite, index, _docstring_nodes(tree))
            mutated = applier.visit(tree)
            if applier.lineno is None:
                continue
            found.append(
                Mutant(
                    operator=operator.name,
                    lineno=applier.lineno,
                    line=lines[applier.lineno - 1] if applier.lineno <= len(lines) else "",
                    source=ast.unparse(ast.fix_missing_locations(mutated)),
                )
            )
    return tuple(found)


# A mutant must be caught by the whole pipeline, not only by the suite that ships
# beside the script. Copying these three trees gives a sandbox where both the
# skill's own suite and the repo-level stages run against the mutated module.
SANDBOX_TREES: Tuple[str, ...] = ("skill", "tests", "scripts")

# Repo-level stages the mutation run uses as executioners. test_fuzz is excluded
# by default: it is the slowest stage and would dominate 800+ sandbox runs.
# --with-fuzz puts it back.
STAGE_PATTERNS: Tuple[str, ...] = (
    "test_invariants.py",
    "test_golden.py",
)
FUZZ_PATTERN: str = "test_fuzz.py"

# Per-module floors, measured once this pipeline was in place and rounded DOWN to
# a 5% step. They are a ratchet, not a target: raise a floor when you raise a
# score, and never lower one to make a red run green. --min-score overrides them.
#
#   module                measured   floor
#   models.py               73.5%     70%
#   score.py                78.7%     75%
#   scaffold_guidance.py    90.9%     90%
#   validate_guidance.py    72.2%     70%
#   check_parse.py          54.5%     50%
#   typesafe_match.py       63.1%     60%
#
# typesafe_match.py was first recorded at 100%, but that run was vacuous: the
# invariants stage read a file outside the sandbox trees, failed on every mutant,
# and so killed them all. Its floor was reset to the score the suite really earns.
FLOORS: Dict[str, float] = {
    "models": 0.70,
    "score": 0.75,
    "scaffold_guidance": 0.90,
    "validate_guidance": 0.70,
    "check_parse": 0.50,
    "typesafe_match": 0.60,
}


@dataclass(frozen=True)
class Sandbox:
    """A throwaway copy of the repo a worker mutates and re-runs in."""

    root: Path

    def module(self, target: Target) -> Path:
        return self.root / target.relative

    def suite(self, target: Target) -> Path:
        return self.root / target.suite.relative_to(REPO)


def _sandbox(stack: ExitStack) -> Sandbox:
    directory = Path(stack.enter_context(tempfile.TemporaryDirectory()))
    for tree in SANDBOX_TREES:
        source = REPO / tree
        if source.is_dir():
            shutil.copytree(source, directory / tree)
    return Sandbox(directory)


def _run(command: Sequence[str], cwd: Path, timeout: int) -> Optional[int]:
    """Return the exit code, or None when the command ran out of time."""
    try:
        completed = subprocess.run(
            list(command),
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
        )
    except subprocess.TimeoutExpired:
        return None
    return completed.returncode


def verdict(
    target: Target,
    mutant: Mutant,
    sandbox: Sandbox,
    patterns: Sequence[str] = STAGE_PATTERNS,
    timeout: int = 120,
) -> Verdict:
    """Write the mutant into the sandbox, run every executioner, then restore."""
    module = sandbox.module(target)
    original = module.read_text(encoding="utf-8")
    try:
        module.write_text(mutant.source, encoding="utf-8")
    except OSError:
        return Verdict(mutant, ERROR)
    try:
        commands = [
            (
                [sys.executable, "-m", "unittest", "discover", "-p", "test_*.py"],
                sandbox.suite(target),
            )
        ] + [
            (
                [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", p],
                sandbox.root,
            )
            for p in patterns
        ]
        for command, cwd in commands:
            code = _run(command, cwd, timeout)
            if code is None:
                return Verdict(mutant, TIMEOUT)
            if code != 0:
                return Verdict(mutant, KILLED)
    finally:
        module.write_text(original, encoding="utf-8")
    return Verdict(mutant, SURVIVED)


def report(
    target: Target,
    operators: Sequence[Operator] = OPERATORS,
    jobs: int = 0,
    patterns: Sequence[str] = STAGE_PATTERNS,
) -> Report:
    """Run every mutant for one target, one sandbox per worker."""
    candidates = mutants(target, operators)
    workers = max(1, jobs if jobs > 0 else min(8, (os.cpu_count() or 2)))
    with ExitStack() as stack:
        sandboxes = [_sandbox(stack) for _ in range(workers)]
        queues: Tuple[Tuple[Mutant, ...], ...] = tuple(
            tuple(candidates[index::workers]) for index in range(workers)
        )

        def drain(pair: Tuple[Sandbox, Tuple[Mutant, ...]]) -> Tuple[Verdict, ...]:
            box, batch = pair
            return tuple(verdict(target, m, box, patterns) for m in batch)

        with ThreadPoolExecutor(max_workers=workers) as pool:
            batches = tuple(pool.map(drain, zip(sandboxes, queues)))
    return Report(target, tuple(v for batch in batches for v in batch))


def _targets(names: Sequence[str]) -> Tuple[Target, ...]:
    if not names:
        return TARGETS
    chosen = tuple(
        target
        for target in TARGETS
        if target.name in names or target.relative in names
    )
    if not chosen:
        raise SystemExit(f"no target matches {list(names)}")
    return chosen


def _operators(names: Sequence[str]) -> Tuple[Operator, ...]:
    if not names:
        return OPERATORS
    chosen = tuple(o for o in OPERATORS if o.name in names)
    if not chosen:
        raise SystemExit(f"no operator matches {list(names)}")
    return chosen


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", action="append", default=[])
    parser.add_argument("--operator", action="append", default=[])
    parser.add_argument("--min-score", type=float, default=None)
    parser.add_argument("--jobs", type=int, default=0)
    parser.add_argument("--list", action="store_true", help="count mutants, run none")
    parser.add_argument(
        "--with-fuzz",
        action="store_true",
        help="also let the fuzz stage kill mutants (slower)",
    )
    options = parser.parse_args()

    if sys.version_info < (3, 9):
        print("mutate: skipped, needs Python 3.9+ for ast.unparse")
        return 0

    targets = _targets(options.target)
    operators = _operators(options.operator)

    if options.list:
        for target in targets:
            print(f"{target.relative}: {len(mutants(target, operators))} mutants")
        return 0

    patterns = STAGE_PATTERNS + ((FUZZ_PATTERN,) if options.with_fuzz else ())

    failed = False
    for target in targets:
        result = report(target, operators, options.jobs, patterns)
        print(
            f"{target.relative}: {result.score:.1%} "
            f"({result.killed}/{result.scored} killed, "
            f"{len(result.survivors)} survived, {len(result.errors)} error)"
        )
        for survivor in result.survivors:
            print(f"  SURVIVED  {survivor.mutant.describe(target)}")
        floor = (
            options.min_score
            if options.min_score is not None
            else FLOORS.get(target.name, 0.0)
        )
        if result.score < floor:
            failed = True
            print(f"  BELOW FLOOR {floor:.0%} — {target.name} regressed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

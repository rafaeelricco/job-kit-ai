"""Pin the packaging contracts: what the installers must ship, and what they name.

Two lists decide whether a downloaded payload is usable — ``KIT_REQUIRED_FILES`` in
``scripts/remote.sh`` and ``$script:KitRequiredFiles`` in ``scripts/remote.ps1``. A
shipped script whose sibling import is absent from those lists still passes the
post-fetch check and then fails at run time on the operator's machine, so the lists
are compared against the real import closure of the scripts they name, not eyeballed.

Skill coverage is pinned the same way: every ``skill/<name>/`` on disk must be
named by a channel's install list, so a newly added skill actually ships.
"""

import ast
import re
import subprocess
import sys
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import FrozenSet, Iterable, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import REPO, read, skill_dirs  # noqa: E402

REMOTE_SH: Path = REPO / "scripts" / "remote.sh"
REMOTE_PS1: Path = REPO / "scripts" / "remote.ps1"
TEST_SH: Path = REPO / "scripts" / "test.sh"
ASIDE_LIB: Path = REPO / "scripts" / "aside" / "lib.sh"
AGENTS_LIB: Path = REPO / "scripts" / "agents" / "lib.sh"

SHELL_REQUIRED_VAR: str = "KIT_REQUIRED_FILES"
POWERSHELL_REQUIRED_VAR: str = "KitRequiredFiles"

SHELL_REFERENCE = re.compile(r"^\$\{(\w+)\}$")
POWERSHELL_TOKEN = re.compile(r"'([^']*)'|\$script:(\w+)")


@dataclass(frozen=True)
class Installer:
    """One installer and the required-file list it declares."""

    path: Path
    label: str

    @property
    def relative(self) -> str:
        return self.path.relative_to(REPO).as_posix()


INSTALLERS: Tuple[Installer, ...] = (
    Installer(REMOTE_SH, "remote.sh"),
    Installer(REMOTE_PS1, "remote.ps1"),
)


def _shell_assignment(text: str, name: str) -> Optional[str]:
    """The raw body of a ``NAME="…"`` assignment, or ``None`` when absent."""
    match = re.search(r'^' + re.escape(name) + r'="([^"]*)"', text, re.MULTILINE)
    return None if match is None else match.group(1)


def _shell_list(text: str, name: str, seen: FrozenSet[str] = frozenset()) -> Tuple[str, ...]:
    """Expand a whitespace-separated shell list, following ``${OTHER_VAR}`` refs."""
    if name in seen:
        return ()
    body = _shell_assignment(text, name)
    if body is None:
        return ()
    entries: Tuple[str, ...] = ()
    for token in body.split():
        reference = SHELL_REFERENCE.match(token)
        if reference is None:
            entries = entries + (token,)
        else:
            entries = entries + _shell_list(text, reference.group(1), seen | {name})
    return entries


def _powershell_expression(text: str, name: str) -> Optional[str]:
    """The right-hand side of a ``$script:Name = …`` assignment, parens balanced."""
    match = re.search(r"^\$script:" + re.escape(name) + r"\s*=\s*", text, re.MULTILINE)
    if match is None:
        return None
    depth = 0
    for index in range(match.end(), len(text)):
        char = text[index]
        if char == "(":
            depth = depth + 1
        elif char == ")":
            depth = depth - 1
        elif char == "\n" and depth <= 0:
            return text[match.end() : index]
    return text[match.end() :]


def _powershell_list(
    text: str, name: str, seen: FrozenSet[str] = frozenset()
) -> Tuple[str, ...]:
    """Expand a PowerShell array literal, following ``$script:Other`` refs."""
    if name in seen:
        return ()
    expression = _powershell_expression(text, name)
    if expression is None:
        return ()
    entries: Tuple[str, ...] = ()
    for match in POWERSHELL_TOKEN.finditer(expression):
        literal, reference = match.group(1), match.group(2)
        if reference is None:
            entries = entries + (literal,)
        else:
            entries = entries + _powershell_list(text, reference, seen | {name})
    return entries


def required_files(path: Path, text: Optional[str] = None) -> Tuple[str, ...]:
    """Every repo path one installer's required-file list declares, in order,
    normalized to forward slashes. Handles both the .sh and .ps1 forms.

    ``text`` overrides the file on disk, for reading an older revision."""
    if text is None:
        text = read(path)
    if path.suffix == ".ps1":
        entries = _powershell_list(text, POWERSHELL_REQUIRED_VAR)
    else:
        entries = _shell_list(text, SHELL_REQUIRED_VAR)
    return tuple(entry.replace("\\", "/") for entry in entries)


def local_imports(path: Path) -> FrozenSet[str]:
    """Sibling modules `path` imports, found with ast.parse — never by importing.

    Each is returned as a repo-relative posix path, so a closure can chain them.
    """
    tree = ast.parse(read(path))
    found = set()
    for node in ast.walk(tree):
        candidates: Tuple[str, ...] = ()
        if isinstance(node, ast.Import):
            candidates = tuple(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                candidates = (node.module.split(".")[0],)
            else:
                candidates = tuple(alias.name for alias in node.names)
        for candidate in candidates:
            sibling = path.parent / (candidate + ".py")
            if sibling.is_file():
                found.add(sibling.relative_to(REPO).as_posix())
    return frozenset(found)


def import_closure(roots: Iterable[str]) -> FrozenSet[str]:
    """Every repo path transitively reachable from `roots` through local imports.

    The roots themselves are part of the closure; non-Python roots contribute
    nothing further.
    """
    pending = list(roots)
    reached = set()
    while pending:
        current = pending.pop()
        if current in reached:
            continue
        reached.add(current)
        path = REPO / current
        if path.suffix == ".py" and path.is_file():
            pending.extend(local_imports(path))
    return frozenset(reached)


def frontmatter_name(text: str) -> Optional[str]:
    """The ``name:`` field of a SKILL.md YAML frontmatter block, or ``None``."""
    if not text.startswith("---"):
        return None
    _, _, rest = text.partition("\n")
    body, _, _ = rest.partition("\n---")
    for line in body.splitlines():
        if line.startswith("name:"):
            return line.split(":", 1)[1].strip().strip("'\"")
    return None


class RequiredFilesTests(unittest.TestCase):
    """The payload both installers verify after fetch."""

    @classmethod
    def setUpClass(cls):
        cls.declared = {
            installer.label: required_files(installer.path) for installer in INSTALLERS
        }

    def test_lists_are_parsed(self):
        for installer in INSTALLERS:
            with self.subTest(installer=installer.label):
                entries = self.declared[installer.label]
                self.assertTrue(
                    entries, "parsed no required files from %s" % installer.relative
                )
                self.assertIn("scripts/install.sh", entries)

    def test_declared_paths_exist(self):
        for installer in INSTALLERS:
            for entry in self.declared[installer.label]:
                with self.subTest(installer=installer.label, path=entry):
                    self.assertTrue(
                        (REPO / entry).is_file(),
                        "%s declares %s, which is not a regular file"
                        % (installer.relative, entry),
                    )

    def test_shell_installer_is_executable(self):
        self.assertTrue(
            REMOTE_SH.stat().st_mode & 0o111,
            "scripts/remote.sh must remain directly executable",
        )

    def test_installers_declare_the_same_sequence(self):
        shell, powershell = (self.declared[i.label] for i in INSTALLERS)
        difference = set(shell) ^ set(powershell)
        self.assertEqual(
            shell,
            powershell,
            "remote.sh and remote.ps1 required-file lists differ; "
            "symmetric difference: %s" % sorted(difference),
        )

    def test_previous_release_required_files_still_declared(self):
        # An installed remote.sh / remote.ps1 checks a newer bundle against its
        # own list, so dropping a path breaks updates from that release.
        described = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", "HEAD"],
            cwd=REPO,
            capture_output=True,
            text=True,
        )
        tag = described.stdout.strip()
        if described.returncode != 0 or not tag:
            self.skipTest("no release tag reachable from HEAD (shallow clone?)")
        for installer in INSTALLERS:
            shown = subprocess.run(
                ["git", "show", "%s:%s" % (tag, installer.relative)],
                cwd=REPO,
                capture_output=True,
                text=True,
            )
            if shown.returncode != 0:
                continue
            previous = required_files(installer.path, shown.stdout)
            with self.subTest(installer=installer.label, release=tag):
                dropped = sorted(set(previous) - set(self.declared[installer.label]))
                self.assertEqual(
                    dropped,
                    [],
                    "%s drops paths that %s's installer requires in a bundle; "
                    "keep a stub file at each and keep it listed: %s"
                    % (installer.relative, tag, dropped),
                )

    def test_required_scripts_are_import_closed(self):
        for installer in INSTALLERS:
            entries = self.declared[installer.label]
            declared = frozenset(entries)
            for entry in entries:
                if not entry.endswith(".py"):
                    continue
                with self.subTest(installer=installer.label, script=entry):
                    undeclared = sorted(import_closure((entry,)) - declared)
                    self.assertEqual(
                        undeclared,
                        [],
                        "%s ships %s but never declares what it imports: %s"
                        % (installer.relative, entry, undeclared),
                    )


class SkillLayoutTests(unittest.TestCase):
    """What a skill directory must look like, and what the installer may name."""

    def test_frontmatter_name_matches_directory(self):
        for directory in skill_dirs():
            with self.subTest(skill=directory.name):
                declared = frontmatter_name(read(directory / "SKILL.md"))
                self.assertEqual(
                    declared,
                    directory.name,
                    "skill/%s/SKILL.md declares name: %r" % (directory.name, declared),
                )

    def test_every_skill_dir_ships_on_a_channel(self):
        """A new skill/<name>/ must be installable, not just present."""
        aside = _shell_list(read(ASIDE_LIB), "SKILL_NAMES")
        agents = _shell_list(read(AGENTS_LIB), "ALL_SKILL_NAMES")
        on_disk = {p.name for p in (REPO / "skill").iterdir() if p.is_dir()}
        self.assertEqual(
            on_disk,
            set(aside) | set(agents),
            "skill/ and the channel name lists disagree",
        )


class TestRunnerTests(unittest.TestCase):
    def test_unknown_only_stage_is_rejected(self):
        completed = subprocess.run(
            ["sh", str(TEST_SH), "--only", "does-not-exist"],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("unknown stage 'does-not-exist'", completed.stderr)
        self.assertNotIn("all stages passed", completed.stdout)


if __name__ == "__main__":
    unittest.main()

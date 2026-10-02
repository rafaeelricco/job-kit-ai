"""Locate the shipped skill scripts and exercise them the way the flows do.

The scripts under ``skill/*/scripts`` are installed onto an operator's machine and
run through a bare ``python3``, so they import their siblings by plain module name
and read their payload from stdin. This module reproduces both conditions: it puts
a script's own directory on ``sys.path`` before importing it, and it runs the CLI
form from an unrelated working directory so a relative-path regression cannot pass.
"""

import importlib
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Optional, Sequence, Tuple

REPO: Path = Path(__file__).resolve().parents[1]
SKILL: Path = REPO / "skill"
MATCH: Path = SKILL / "job-match" / "scripts"
REFINE: Path = SKILL / "job-resume-refine" / "scripts"
STORE: Path = SKILL / "job-store" / "scripts"
HUMANIZE: Path = SKILL / "job-humanize" / "scripts"


@dataclass(frozen=True)
class Target:
    """A shipped module and the suite whose tests must pin it."""

    module: Path
    suite: Path

    @property
    def name(self) -> str:
        return self.module.stem

    @property
    def relative(self) -> str:
        return self.module.relative_to(REPO).as_posix()


TARGETS: Tuple[Target, ...] = (
    Target(MATCH / "models.py", MATCH),
    Target(MATCH / "score.py", MATCH),
    Target(MATCH / "scaffold_guidance.py", MATCH),
    Target(MATCH / "validate_guidance.py", MATCH),
    Target(MATCH / "typesafe_match.py", MATCH),
    Target(REFINE / "check_parse.py", REFINE),
    Target(STORE / "normalize_url.py", STORE),
    Target(STORE / "validate_extract.py", STORE),
    Target(STORE / "validate_dossier.py", STORE),
    Target(STORE / "normalize_source.py", STORE),
    Target(HUMANIZE / "detect.py", HUMANIZE),
)


@dataclass(frozen=True)
class CliResult:
    """One CLI invocation: its exit code, parsed stdout, and raw stderr."""

    exit_code: int
    stdout: object
    stderr: str
    raw_stdout: str

    @property
    def parsed(self) -> bool:
        """Whether stdout was valid JSON."""
        return self.stdout is not None or self.raw_stdout.strip() == "null"


def load(path: Path) -> ModuleType:
    """Import a shipped script by path, with its own directory on ``sys.path``."""
    directory = str(path.parent)
    if directory not in sys.path:
        sys.path.insert(0, directory)
    return importlib.import_module(path.stem)


def launcher() -> Tuple[str, ...]:
    """The skills' own rule: python3, then py -3, then python when major is 3."""
    for candidate in (("python3",), ("py", "-3"), ("python",)):
        try:
            probe = subprocess.run(
                list(candidate) + ["-c", "import sys; print(sys.version_info[0])"],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if probe.returncode == 0 and probe.stdout.strip() == "3":
            return candidate
    raise RuntimeError("no python 3 launcher found")


def run_cli(
    path: Path,
    payload: object = None,
    argv: Sequence[str] = (),
    cwd: str = "/",
    timeout: int = 60,
) -> CliResult:
    """Run a script as the flows do, from an unrelated working directory."""
    stdin = "" if payload is None else json.dumps(payload)
    completed = subprocess.run(
        list(launcher()) + [str(path)] + list(argv),
        input=stdin,
        capture_output=True,
        text=True,
        cwd=cwd,
        timeout=timeout,
    )
    return CliResult(
        exit_code=completed.returncode,
        stdout=_maybe_json(completed.stdout),
        stderr=completed.stderr,
        raw_stdout=completed.stdout,
    )


def _maybe_json(text: str) -> Optional[object]:
    try:
        return json.loads(text)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def skill_dirs() -> Tuple[Path, ...]:
    """Every ``skill/<name>`` directory, in sorted order."""
    return tuple(
        sorted(
            (child for child in SKILL.iterdir() if child.is_dir()),
            key=lambda child: child.name,
        )
    )


def markdown_files() -> Tuple[Path, ...]:
    """Every markdown file shipped inside a skill, in sorted order."""
    return tuple(sorted(SKILL.rglob("*.md")))


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")

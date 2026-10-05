"""Pin the prose: the paths a flow tells an agent to load must be real.

The skills route work by naming files in backticks — ``Load ./references/flow-x.md``
— so a renamed reference file is a broken flow, not a broken import. Nothing else
catches it: the markdown is read by an agent at runtime, never by an interpreter.

The difficulty is that only some of those backticked paths belong to this repo. A
flow also names files in the *operator's profile root* — ``data/job_search.yaml``,
``cv/en-us-resume.pdf``, a bare ``experiences.yml`` — which do not exist here and
must not exist here. A linter that checks every backticked path reports roughly one
false failure for every true one. So references are classified before they are
checked, and a profile-relative reference resolves to ``None`` by design.

Three anchored forms are checkable:

* skill-local — ``./references/x.md``, ``./scripts/x.py``, ``./templates/`` resolve
  under the *containing skill* directory, because a reference file that says
  ``./references/contract-x.md`` still means the skill's own references directory.
  Nested ``./references/flows/x.md`` resolves the same way, under the skill root.
* file-relative — ``./worker-validate.md`` and ``../SKILL.md`` resolve against the
  *containing file's* directory. Dropping this form makes the four job-match
  ``worker-*.md`` files look like orphans when the flow loads them by bare name.
* cross-skill — ``job-match/references/schema-state.md`` resolves under ``skill/``.

An unanchored bare name (``contract-match.md``, ``match-report.md``) is deliberately
not a reference: the same spelling is used for a sibling file, for another skill's
file, and for an output artifact the flow is about to write. Those are read as
loose mentions, which is enough to credit a reference file against orphanhood but
not enough to assert a path.
"""

import json
import re
import sys
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, FrozenSet, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import REPO, SKILL, markdown_files, read, skill_dirs  # noqa: E402

INLINE_CODE = re.compile(r"`([^`\n]+)`")
CROSS_SKILL = re.compile(r"^job-[a-z0-9-]+/(?:references|scripts|templates)/[^/].*$")
FILE_RELATIVE = re.compile(r"^\.\.?/")
BARE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*\.(?:md|py)$")
DECLARED_SCRIPT = re.compile(r"^(?:\./)?scripts/([a-z0-9_]+\.py)$")
FENCE = re.compile(r"^\s*(?:```|~~~)")
JSON_FENCE = re.compile(r"^\s*(?:```|~~~)json\s*$")
PLACEHOLDER = re.compile(r"<[^<>\n]+>|\.\.\.|…")
FRONTMATTER_KEY = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$")
PACK_ID = re.compile(r"^  - id:\s*(\S+)")

FILE_SUFFIXES: Tuple[str, ...] = (
    ".md",
    ".py",
    ".sh",
    ".yaml",
    ".yml",
    ".json",
    ".tex",
    ".cls",
    ".pdf",
    ".txt",
)

# A backticked token carrying any of these is a shell fragment, a glob, or a
# templated path (`{dir}/{stem}.tex`, `$KIT_ROOT/scripts/install.sh`), never a
# literal file this repo can be asked to hold.
REJECTED_CHARS: FrozenSet[str] = frozenset(" \t$*{}<>()[]|;,=?!~\"'`")

# Paths rooted in the operator's profile, which lives outside this repo.
PROFILE_PREFIXES: Tuple[str, ...] = (
    "data/",
    "cv/",
    "scout/",
    "./data/",
    "./cv/",
    "./scout/",
    "../data/",
    "../cv/",
    "../scout/",
)

# Profile files the prose also names bare, without their `data/` directory.
PROFILE_FILES: FrozenSet[str] = frozenset(
    (
        "answers.yaml",
        "basics.yaml",
        "cvs.yaml",
        "education.yaml",
        "en-us-resume.pdf",
        "experiences.yml",
        "job_search.yaml",
        "languages.yaml",
        "observations.yaml",
        "profile_card.yaml",
        "profiles.yaml",
        "projects.yaml",
        "projects.yml",
        "search_packs.yaml",
        "skills-by-company.yml",
        "skills.yaml",
    )
)

SKILL_LOCAL_PREFIXES: Tuple[str, ...] = ("./references/", "./scripts/", "./templates/")

PROFILE: str = "profile"
SKILL_LOCAL: str = "skill-local"
FILE_LOCAL: str = "file-relative"
CROSS: str = "cross-skill"
CHECKABLE_KINDS: Tuple[str, ...] = (SKILL_LOCAL, FILE_LOCAL, CROSS)

DECK: Path = SKILL / "job-profile" / "templates" / "data" / "search_packs.yaml"
ROUTE_FIELDS: Tuple[str, ...] = ("kind", "url", "pages", "items", "posting_url")
ROUTE_TOKENS: Tuple[str, ...] = ("{formulation}", "{page}")
BOARD_FIELDS: Tuple[str, ...] = ("kind", "ats", "url", "items", "posting_url", "title")
BOARD_TOKENS: Tuple[str, ...] = ("{slug}",)
# schema-dossier.md "ATS family" minus `other`: a board pack names a real family.
ATS_FAMILIES: Tuple[str, ...] = ("greenhouse", "lever", "ashby")


@dataclass(frozen=True)
class Reference:
    """One backticked path in one markdown file, with where it was written."""

    source: Path
    raw: str
    lineno: int

    @property
    def kind(self) -> str:
        """Which resolution rule applies: one of the module's kind constants."""
        return _kind(self.raw) or PROFILE

    @property
    def is_profile_relative(self) -> bool:
        """Whether the path is rooted in the operator's profile, not this repo."""
        return self.kind == PROFILE

    @property
    def where(self) -> str:
        return "{0}:{1}".format(self.source.relative_to(REPO).as_posix(), self.lineno)


def _is_path_like(token: str) -> bool:
    """Whether a backticked token is spelled like a literal file or directory."""
    if not token or any(character in REJECTED_CHARS for character in token):
        return False
    if "://" in token or token.startswith("/") or token.startswith("…"):
        return False
    if token.endswith("/"):
        return "/" in token.rstrip("/")
    if not token.endswith(FILE_SUFFIXES):
        return False
    # `.tex` and `.md` alone name a suffix, not a file.
    return not token.rstrip("/").split("/")[-1].startswith(".")


def _kind(raw: str) -> Optional[str]:
    """The resolution rule for a path-like token, or None when it names nothing."""
    if raw.startswith(PROFILE_PREFIXES) or raw in PROFILE_FILES:
        return PROFILE
    if raw.startswith(SKILL_LOCAL_PREFIXES):
        return SKILL_LOCAL
    if FILE_RELATIVE.match(raw):
        return FILE_LOCAL
    if CROSS_SKILL.match(raw):
        return CROSS
    return None


def _skill_root(source: Path) -> Path:
    """The ``skill/<name>`` directory containing a markdown file."""
    return SKILL / source.relative_to(SKILL).parts[0]


def tokens(path: Path) -> Tuple[Tuple[int, str], ...]:
    """Every backticked token in a markdown file, as (line number, text)."""
    found = []
    for lineno, line in enumerate(read(path).splitlines(), 1):
        for match in INLINE_CODE.finditer(line):
            found.append((lineno, match.group(1).strip()))
    return tuple(found)


def references(path: Path) -> Tuple[Reference, ...]:
    """Every inline file reference in one markdown file, in source order.

    A spelling is kept once per file, at its first mention: resolution depends only
    on the containing file and the raw text, so a repeat cannot resolve differently.
    """
    seen = set()
    found = []
    for lineno, raw in tokens(path):
        if raw in seen or not _is_path_like(raw) or _kind(raw) is None:
            continue
        seen.add(raw)
        found.append(Reference(source=path, raw=raw, lineno=lineno))
    return tuple(found)


def resolve(ref: Reference) -> Optional[Path]:
    """The repo path a reference names, or None when it is profile-relative."""
    kind = ref.kind
    if kind == PROFILE:
        return None
    if kind == SKILL_LOCAL:
        return _skill_root(ref.source) / ref.raw[len("./") :]
    if kind == FILE_LOCAL:
        return Path(ref.source.parent / ref.raw).resolve()
    return SKILL / ref.raw


def all_references() -> Tuple[Reference, ...]:
    """Every reference in every shipped markdown file, in file then source order."""
    found = []
    for path in markdown_files():
        found.extend(references(path))
    return tuple(found)


def of_kind(kind: str) -> Tuple[Reference, ...]:
    return tuple(ref for ref in all_references() if ref.kind == kind)


def shipped_scripts() -> FrozenSet[str]:
    """The file names of every script shipped under a skill."""
    return frozenset(path.name for path in SKILL.glob("*/scripts/*.py"))


def reference_files() -> Tuple[Path, ...]:
    """Every ``skill/<name>/references/**/*.md``, in sorted order."""
    return tuple(sorted(SKILL.glob("*/references/**/*.md")))


def loaded_reference_files() -> FrozenSet[Path]:
    """Reference files some prose file loads, by resolved path or by bare name."""
    loaded = set()
    by_name: Dict[Tuple[Path, str], Path] = {
        (_skill_root(path), path.name): path for path in reference_files()
    }
    for path in markdown_files():
        for ref in references(path):
            target = resolve(ref)
            if target is not None and target.is_file():
                loaded.add(target.resolve())
        root = _skill_root(path)
        for _, raw in tokens(path):
            sibling = by_name.get((root, raw)) if BARE_NAME.match(raw) else None
            if sibling is not None and sibling.resolve() != path.resolve():
                loaded.add(sibling.resolve())
    return frozenset(loaded)


def frontmatter(path: Path) -> Dict[str, str]:
    """The top-level scalar keys of a markdown file's YAML frontmatter."""
    lines = read(path).splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fields: Dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        match = FRONTMATTER_KEY.match(line)
        if match is not None:
            fields[match.group(1)] = match.group(2).strip().strip("\"'").strip()
    return fields


@dataclass(frozen=True)
class Block:
    """One fenced ``json`` block, and whether it is illustrative rather than literal."""

    source: Path
    lineno: int
    body: str

    @property
    def is_illustrative(self) -> bool:
        """Whether the block carries ``<placeholder>`` tokens or ``...`` elisions."""
        return PLACEHOLDER.search(self.body) is not None

    @property
    def where(self) -> str:
        return "{0}:{1}".format(self.source.relative_to(REPO).as_posix(), self.lineno)


def json_blocks(path: Path) -> Tuple[Block, ...]:
    """Every fenced ``json`` block in a markdown file, in source order."""
    found = []
    body: Tuple[str, ...] = ()
    start = 0
    open_at = None
    for lineno, line in enumerate(read(path).splitlines(), 1):
        if open_at is None:
            if JSON_FENCE.match(line):
                open_at, start, body = lineno, lineno, ()
            continue
        if FENCE.match(line):
            found.append(Block(source=path, lineno=start, body="\n".join(body)))
            open_at = None
            continue
        body = body + (line,)
    return tuple(found)


def contract_files() -> Tuple[Path, ...]:
    """Every schema or contract reference file, in sorted order."""
    return tuple(
        sorted(
            set(SKILL.glob("*/references/schemas/schema-*.md"))
            | set(SKILL.glob("*/references/contracts/contract-*.md"))
        )
    )


def report(line: str) -> None:
    """Write a coverage line where ``unittest -v`` shows it."""
    print(line, file=sys.stderr)


class ReferenceTests(unittest.TestCase):
    def test_skill_local_refs_resolve(self):
        for ref in of_kind(SKILL_LOCAL):
            with self.subTest(ref=ref.raw, source=ref.where):
                target = resolve(ref)
                self.assertTrue(
                    target is not None and target.exists(),
                    "{0} names `{1}`, which is not at {2}".format(
                        ref.where, ref.raw, target
                    ),
                )

    def test_bare_sibling_refs_resolve(self):
        for ref in of_kind(FILE_LOCAL):
            with self.subTest(ref=ref.raw, source=ref.where):
                target = resolve(ref)
                self.assertTrue(
                    target is not None and target.exists(),
                    "{0} names `{1}`, which is not at {2}".format(
                        ref.where, ref.raw, target
                    ),
                )

    def test_cross_skill_refs_resolve(self):
        for ref in of_kind(CROSS):
            with self.subTest(ref=ref.raw, source=ref.where):
                target = resolve(ref)
                self.assertTrue(
                    target is not None and target.exists(),
                    "{0} names `{1}`, which is not at {2}".format(
                        ref.where, ref.raw, target
                    ),
                )

    def test_declared_scripts_exist(self):
        shipped = shipped_scripts()
        self.assertTrue(shipped, "no scripts found under skill/*/scripts")
        declared = tuple(
            (path, lineno, DECLARED_SCRIPT.match(raw).group(1))
            for path in markdown_files()
            for lineno, raw in tokens(path)
            if DECLARED_SCRIPT.match(raw)
        )
        self.assertTrue(declared, "no `scripts/*.py` named in prose: regex regression")
        for path, lineno, name in declared:
            where = "{0}:{1}".format(path.relative_to(REPO).as_posix(), lineno)
            with self.subTest(script=name, source=where):
                self.assertIn(
                    name,
                    shipped,
                    "{0} names `scripts/{1}`, which no skill ships".format(where, name),
                )

    def test_no_orphan_reference_files(self):
        loaded = loaded_reference_files()
        present = reference_files()
        self.assertTrue(present, "no reference files found under skill/*/references")
        for path in present:
            with self.subTest(reference=path.relative_to(REPO).as_posix()):
                self.assertTrue(
                    path.resolve() in loaded,
                    "{0} is loaded by no prose file".format(
                        path.relative_to(REPO).as_posix()
                    ),
                )

    def test_checkable_reference_count(self):
        found = all_references()
        checkable = tuple(ref for ref in found if not ref.is_profile_relative)
        profile = tuple(ref for ref in found if ref.is_profile_relative)
        counts = tuple(
            (kind, len(of_kind(kind)))
            for kind in CHECKABLE_KINDS + (PROFILE,)
        )
        report(
            "\nreferences: {0} checkable, {1} profile-relative, across {2} files".format(
                len(checkable), len(profile), len(markdown_files())
            )
        )
        report("  " + ", ".join("{0} {1}".format(n, k) for k, n in counts))
        for kind, count in counts[:-1]:
            with self.subTest(kind=kind):
                self.assertGreater(count, 0, "no {0} references matched".format(kind))
        self.assertGreater(
            len(profile),
            0,
            "no profile-relative references matched; the classifier has regressed",
        )


class FrontmatterTests(unittest.TestCase):
    def test_description_is_present(self):
        for directory in skill_dirs():
            path = directory / "SKILL.md"
            with self.subTest(skill=directory.name):
                fields = frontmatter(path)
                self.assertTrue(
                    fields.get("description", "").strip(),
                    "{0} has an empty or missing `description:`".format(path),
                )


@dataclass(frozen=True)
class Pack:
    """One pack in the shipped search deck, with where it was written."""

    identifier: str
    lineno: int
    lines: Tuple[str, ...]

    @property
    def where(self) -> str:
        return "{0}:{1}".format(DECK.relative_to(REPO).as_posix(), self.lineno)

    def value(self, indent: int, key: str) -> Optional[str]:
        """The value written for ``key`` at exactly ``indent`` spaces, else None."""
        prefix = "{0}{1}:".format(" " * indent, key)
        for line in self.lines:
            if line.startswith(prefix):
                return line[len(prefix) :].strip()
        return None


def search_packs() -> Tuple[Pack, ...]:
    """Every pack in the shipped deck, in file order, with its own lines."""
    packs = []
    identifier = None
    lineno = 0
    body = []
    for number, line in enumerate(read(DECK).splitlines(), start=1):
        match = PACK_ID.match(line)
        if match:
            if identifier is not None:
                packs.append(Pack(identifier, lineno, tuple(body)))
            identifier, lineno, body = match.group(1).strip("\"'"), number, []
        elif identifier is not None and line.strip() and not line.startswith("  "):
            packs.append(Pack(identifier, lineno, tuple(body)))
            identifier = None
        elif identifier is not None:
            body.append(line)
    if identifier is not None:
        packs.append(Pack(identifier, lineno, tuple(body)))
    return tuple(packs)


def route_defect(pack: Pack) -> Optional[str]:
    """Why ``pack``'s route is not a complete json or board route, or None when it is."""
    block = pack.value(4, "route")
    if block is None:
        return "carries no route block"
    if block:
        return "writes route inline as {0!r}, not a block mapping".format(block)
    kind = pack.value(6, "kind")
    if kind == "json":
        fields, tokens = ROUTE_FIELDS, ROUTE_TOKENS
    elif kind == "board":
        fields, tokens = BOARD_FIELDS, BOARD_TOKENS
    else:
        return "declares route kind {0!r}, not json or board".format(kind)
    missing = [key for key in fields if not pack.value(6, key)]
    if missing:
        return "omits route " + ", ".join(missing)
    if kind == "board" and pack.value(6, "ats") not in ATS_FAMILIES:
        return "declares route ats {0!r}, not an ATS family".format(pack.value(6, "ats"))
    url = pack.value(6, "url") or ""
    absent = [token for token in tokens if token not in url]
    if absent:
        return "writes a route url without " + ", ".join(absent)
    return None


class SearchPackRouteTests(unittest.TestCase):
    """The shipped deck's routes, and the skill prose that consumes them."""

    @classmethod
    def setUpClass(cls):
        cls.deck = read(DECK)
        cls.packs = search_packs()

    def pack(self, identifier: str) -> Pack:
        for pack in self.packs:
            if pack.identifier == identifier:
                return pack
        self.fail(
            "no pack `{0}` in {1}".format(identifier, DECK.relative_to(REPO).as_posix())
        )

    def test_deck_parses(self):
        declared = len(re.findall(r"(?m)^  - id:", self.deck))
        identifiers = [pack.identifier for pack in self.packs]
        routed = [p for p in self.packs if p.value(4, "route") is not None]
        required = [p for p in self.packs if p.value(4, "route_required") == "true"]
        report(
            "\nsearch packs: {0} parsed, {1} routed, {2} route_required".format(
                len(self.packs), len(routed), len(required)
            )
        )
        self.assertEqual(
            declared,
            len(self.packs),
            "{0} `- id:` lines but {1} packs parsed; the pack scanner has "
            "regressed".format(declared, len(self.packs)),
        )
        self.assertEqual(
            sorted(set(identifiers)),
            sorted(identifiers),
            "duplicate pack id: {0}".format(
                sorted(i for i in set(identifiers) if identifiers.count(i) > 1)
            ),
        )
        self.assertGreater(
            len(required),
            0,
            "no pack declares `route_required: true`; the route tests pass vacuously",
        )

    def test_required_routes_are_complete_or_disabled(self):
        for pack in self.packs:
            defect = route_defect(pack)
            required = pack.value(4, "route_required")
            with self.subTest(pack=pack.identifier, source=pack.where):
                if pack.value(4, "route") is not None:
                    self.assertIsNone(
                        defect,
                        "{0} at {1} {2}".format(pack.identifier, pack.where, defect),
                    )
                if required is not None:
                    self.assertIn(
                        required,
                        ("true", "false"),
                        "{0} at {1} writes a non-boolean `route_required: "
                        "{2}`".format(pack.identifier, pack.where, required),
                    )
                if required == "true" and pack.value(4, "enabled") != "false":
                    self.assertIsNone(
                        defect,
                        "enabled pack {0} at {1} {2}".format(
                            pack.identifier, pack.where, defect
                        ),
                    )
                location = pack.value(4, "location")
                if location is not None:
                    self.assertEqual(
                        location,
                        "keep-only",
                        "{0} at {1} writes an unknown `location: {2}`".format(
                            pack.identifier, pack.where, location
                        ),
                    )

    def test_surfaces_without_a_location_control_declare_keep_only(self):
        for identifier in (
            "linkedin-posts",
            "hn-hiring",
            "work-at-a-startup",
            "we-work-remotely",
        ):
            pack = self.pack(identifier)
            with self.subTest(pack=identifier, source=pack.where):
                self.assertEqual(
                    pack.value(4, "location"),
                    "keep-only",
                    "{0} at {1} has no usable location control but does not "
                    "declare `location: keep-only`".format(identifier, pack.where),
                )
        for pack in self.packs:
            if pack.value(4, "surface") == "social":
                with self.subTest(pack=pack.identifier, source=pack.where):
                    self.assertEqual(pack.value(4, "location"), "keep-only")

    def test_shipped_route_dependent_packs(self):
        hiring_cafe = self.pack("hiring-cafe")
        self.assertEqual(hiring_cafe.value(4, "route_required"), "true")
        self.assertEqual(
            hiring_cafe.value(4, "enabled"),
            "false",
            "hiring-cafe at {0} carries no route, so it must ship "
            "disabled".format(hiring_cafe.where),
        )


class SchemaBlockTests(unittest.TestCase):
    def test_json_blocks_parse(self):
        checked = 0
        skipped = 0
        for path in contract_files():
            for block in json_blocks(path):
                if block.is_illustrative:
                    skipped += 1
                    continue
                checked += 1
                with self.subTest(block=block.where):
                    try:
                        json.loads(block.body)
                    except ValueError as error:
                        self.fail(
                            "{0}: fenced json does not parse: {1}".format(
                                block.where, error
                            )
                        )
        report(
            "\njson blocks: {0} parsed, {1} skipped as illustrative, "
            "across {2} schema/contract files".format(
                checked, skipped, len(contract_files())
            )
        )
        self.assertGreater(
            checked, 0, "no literal json blocks found; the fence scanner has regressed"
        )


if __name__ == "__main__":
    unittest.main()

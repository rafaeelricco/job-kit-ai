"""Pin agreements no single shipped script can assert about itself.

Weights, bands, guidance enums, duplicate-url wording, and scaffold error
scope are compared across the match modules. ``score._contains_token`` and
``check_parse.check`` are driven through the public ``check`` entry point so
the two skills cannot drift on whole-token matching. Tracker query keys in
schema-dossier.md must equal ``normalize_url.TRACKER_*``.
"""

import unittest
import re
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Dict, FrozenSet, Mapping, Optional, Sequence, Tuple, get_args
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

import harness  # noqa: E402

models = harness.load(harness.MATCH / "models.py")
score = harness.load(harness.MATCH / "score.py")
scaffold_guidance = harness.load(harness.MATCH / "scaffold_guidance.py")
validate_guidance = harness.load(harness.MATCH / "validate_guidance.py")
check_parse = harness.load(harness.REFINE / "check_parse.py")
normalize_url = harness.load(harness.STORE / "normalize_url.py")
normalize_source = harness.load(harness.STORE / "normalize_source.py")
validate_dossier = harness.load(harness.STORE / "validate_dossier.py")
FLOW_READ: Path = harness.SKILL / "job-store" / "references" / "flows" / "flow-read.md"
APP_TYPES: Path = harness.REPO / "packages" / "frontend" / "src" / "module" / "scout" / "types.ts"

DECK: Path = (
    harness.SKILL
    / "job-profile"
    / "templates"
    / "data"
    / "search_packs.yaml"
)

SCHEMA_DOSSIER: Path = (
    harness.SKILL / "job-store" / "references" / "schemas" / "schema-dossier.md"
)
FLOW_GATE: Path = (
    harness.SKILL / "job-scout" / "references" / "flows" / "flow-gate.md"
)
FLOW_SEARCH: Path = (
    harness.SKILL / "job-scout" / "references" / "flows" / "flow-search.md"
)
FLOW_EXTRACT: Path = (
    harness.SKILL / "job-scout" / "references" / "flows" / "flow-extract.md"
)
FLOW_RANK: Path = harness.SKILL / "job-scout" / "references" / "flows" / "flow-rank.md"
FLOW_MATCH_GATE: Path = (
    harness.SKILL / "job-scout" / "references" / "flows" / "flow-match-gate.md"
)
FLOW_PREP: Path = harness.SKILL / "job-prep" / "references" / "flows" / "flow-prep.md"


@dataclass(frozen=True)
class BoundaryCase:
    """One text/token pair both whole-token matchers must agree on."""

    text: str
    token: str
    expected: bool


BOUNDARY_CASES: Tuple[BoundaryCase, ...] = (
    BoundaryCase("reactñ stack", "react", False),
    BoundaryCase("ongoing work", "go", False),
    BoundaryCase("c# and .net", "c#", True),
    BoundaryCase("node.js dev", "node.js", True),
    BoundaryCase("gestão de café", "café", True),
    BoundaryCase("react native", "react", True),
)


@dataclass(frozen=True)
class ScaffoldCase:
    """One candidate/job pair to scaffold and hand to the validator."""

    name: str
    candidate: Mapping[str, object]
    job: Mapping[str, object]


# The two ResumeGuidance fields scaffold_guidance leaves for the worker to fill.
# Validation errors naming these are expected on a raw skeleton; anything else
# means the scaffold got a field it owns wrong.
WORKER_OWNED_FIELDS: Tuple[str, ...] = ("priority_roles", "warnings")


SCAFFOLD_CASES: Tuple[ScaffoldCase, ...] = (
    ScaffoldCase(
        name="empty candidate skills",
        candidate={"skills": [], "experience": []},
        job={
            "url": "https://example.test/a",
            "title": "Frontend Engineer",
            "required_skills": ["React"],
            "preferred_skills": [],
        },
    ),
    ScaffoldCase(
        name="empty required skills",
        candidate={"skills": ["React"], "experience": []},
        job={
            "url": "https://example.test/b",
            "title": "Frontend Engineer",
            "required_skills": [],
            "preferred_skills": ["TypeScript"],
        },
    ),
    ScaffoldCase(
        name="duplicate job terms",
        candidate={"skills": ["React", "React"], "experience": []},
        job={
            "url": "https://example.test/c",
            "title": "Frontend Engineer",
            "required_skills": ["React", "React"],
            "preferred_skills": ["React"],
        },
    ),
    ScaffoldCase(
        name="mixed case direct hold",
        candidate={"skills": ["React.js"], "experience": []},
        job={
            "url": "https://example.test/d",
            "title": "Frontend Engineer",
            "required_skills": ["react"],
            "preferred_skills": ["REACT"],
        },
    ),
    ScaffoldCase(
        name="matching candidate role",
        candidate={
            "skills": ["React"],
            "experience": [
                {
                    "company": "Acme",
                    "position": "Frontend Engineer",
                    "date": "2020-2024",
                }
            ],
        },
        job={
            "url": "https://example.test/e",
            "title": "Frontend Engineer",
            "required_skills": ["React"],
            "preferred_skills": [],
        },
    ),
)

DUPLICATE_URL: str = "https://example.test/duplicate"
DUPLICATE_MESSAGE: str = "duplicate JobProfile url"


def check_parse_contains(text: str, token: str) -> bool:
    """Run ``check_parse``'s own matcher by asking ``check`` for one identity token.

    ``check`` reports a token it never found under ``missing``; the out-of-order
    branch cannot fire for a single identity token, whose cursor is always 0. So an
    empty ``missing`` list is exactly "the real matcher found this token".
    """
    expected: Dict[str, object] = {
        "identity": [token],
        "roles": [],
        "skills": [],
    }
    verdict = check_parse.check(text, expected)
    return not verdict["missing"]


def instruction_text(path: Path) -> str:
    """Read shipped instructions with wrapping removed and case normalized."""
    return " ".join(harness.read(path).lower().split())


def instruction_section(path: Path, start: str, end: str) -> str:
    """Return one normalized markdown section, bounded by its next heading."""
    text = instruction_text(path)
    _before, marker, after = text.partition(start.lower())
    if not marker:
        raise AssertionError(f"missing instruction heading {start!r} in {path}")
    section, marker, _remainder = after.partition(end.lower())
    if not marker:
        raise AssertionError(f"missing instruction heading {end!r} in {path}")
    return section


def emittable_warnings() -> FrozenSet[str]:
    """Every code ``scaffold_guidance.source_warnings`` can return, derived by call.

    The four combinations of empty/non-empty candidate skills and job required
    skills cover both of the function's independent branches, so their union is the
    whole emittable set without any code being named here.
    """
    skill_choices: Tuple[Tuple[str, ...], ...] = ((), ("React",))
    required_choices: Tuple[Tuple[str, ...], ...] = ((), ("React",))
    found = set()
    for skills in skill_choices:
        for required in required_choices:
            candidate = models.CandidateProfile(skills=skills)
            job = models.JobProfile(url="https://example.test/w", required_skills=required)
            found.update(scaffold_guidance.source_warnings(candidate, job))
    return frozenset(found)


def scaffolded(case: ScaffoldCase) -> Dict[str, object]:
    """Return ``scaffold``'s output for one case, as JSON, worker untouched."""
    candidate = models.CandidateProfile.from_json(case.candidate)
    job = models.JobProfile.from_json(case.job)
    return scaffold_guidance.scaffold(candidate, job).to_json()


def identity_worker(guidance: Dict[str, object]) -> Dict[str, object]:
    """The no-op worker: guidance is handed to validation exactly as scaffolded."""
    return guidance


def guidance_payload(case: ScaffoldCase) -> Dict[str, object]:
    """Assemble the payload ``validate_guidance`` reads for one scaffolded case."""
    return {
        "candidate": dict(case.candidate),
        "jobs": [dict(case.job)],
        "guidance": [identity_worker(scaffolded(case))],
    }


def duplicate_sources() -> Tuple[Dict[str, object], Tuple[Dict[str, object], ...]]:
    """One candidate and one jobs list carrying the same url twice."""
    candidate: Dict[str, object] = {"skills": ["React"], "experience": []}
    job: Dict[str, object] = {
        "url": DUPLICATE_URL,
        "title": "Frontend Engineer",
        "required_skills": ["React"],
        "preferred_skills": [],
    }
    return candidate, (dict(job), dict(job))


def score_duplicate_message() -> Optional[str]:
    """Return the ``score_error`` ``score_all`` reports for the duplicated url."""
    candidate, jobs = duplicate_sources()
    payload = {
        "candidate": candidate,
        "jobs": [dict(job) for job in jobs],
        "matches": [{"url": DUPLICATE_URL, "score_breakdown": {"location": 10}}],
    }
    rows: Sequence[Dict[str, object]] = score.score_all(payload)
    errors = tuple(
        row["score_error"] for row in rows if isinstance(row.get("score_error"), str)
    )
    return str(errors[0]) if errors else None


def validate_duplicate_message() -> Optional[str]:
    """Return the validation error ``validate_guidance`` reports for the same urls."""
    candidate, jobs = duplicate_sources()
    payload = {
        "candidate": candidate,
        "jobs": [dict(job) for job in jobs],
        "guidance": [],
    }
    result = validate_guidance.validate_payload(payload)
    invalid = result["invalid"]
    messages = tuple(
        str(message)
        for row in invalid
        if row.get("url") == DUPLICATE_URL
        for message in row.get("errors", ())
    )
    return messages[0] if messages else None


class WeightTests(unittest.TestCase):
    def test_weights_sum_to_one_hundred(self):
        self.assertEqual(sum(score.WEIGHTS.values()), 100)

    def test_every_weight_is_a_breakdown_field(self):
        names = frozenset(field.name for field in fields(models.ScoreBreakdown))
        for name in score.WEIGHTS:
            with self.subTest(weight=name):
                self.assertIn(name, names)

    def test_source_is_the_only_extra_breakdown_field(self):
        names = frozenset(field.name for field in fields(models.ScoreBreakdown))
        self.assertEqual(names - frozenset(score.WEIGHTS), frozenset({"source"}))


class BandTests(unittest.TestCase):
    def test_floors_strictly_descend(self):
        floors = tuple(floor for floor, _decision in score.BANDS)
        for earlier, later in zip(floors, floors[1:]):
            with self.subTest(earlier=earlier, later=later):
                self.assertGreater(earlier, later)

    def test_band_names_are_decisions(self):
        decisions = frozenset(get_args(models.Decision))
        for _floor, decision in score.BANDS:
            with self.subTest(decision=decision):
                self.assertIn(decision, decisions)

    def test_skip_is_the_fallthrough(self):
        named = frozenset(decision for _floor, decision in score.BANDS)
        self.assertIn("skip", get_args(models.Decision))
        self.assertNotIn("skip", named)


class EnumDriftTests(unittest.TestCase):
    def test_allowed_status_matches_models(self):
        self.assertEqual(
            validate_guidance.ALLOWED_STATUS,
            frozenset(get_args(models.GuidanceStatus)),
        )

    def test_allowed_kind_matches_models(self):
        self.assertEqual(
            validate_guidance.ALLOWED_KIND,
            frozenset(get_args(models.RequirementKind)),
        )

    def test_allowed_warnings_matches_scaffold(self):
        self.assertEqual(
            validate_guidance.ALLOWED_WARNINGS,
            emittable_warnings() | frozenset({"no_relevant_role"}),
        )

    def test_alias_targets_are_shipped_pack_ids(self):
        """Every fold target must name a pack some deck declares.

        The aliases are policy, not derivation (a host cannot be mapped to an
        id by rule), so nothing else catches a target that was renamed out of
        the deck or typo'd — the fold would simply mint a new label.

        The runtime authority is the operator's own deck, which tests never
        read (`tests/test_prose.py` keeps the profile root out of the suite),
        so the shipped template stands in for it. OPERATOR_ONLY names the ids
        the template omits but an operator deck may declare; each one is a
        template gap, not an alias defect.
        """
        # The template ships the board-API pack for Ashby but not the DOM
        # `site:` pack, though it ships both for Greenhouse and Lever.
        operator_only = frozenset({"ashby"})
        declared = frozenset(
            re.findall(r"(?m)^  - id:\s*(\S+)", DECK.read_text(encoding="utf-8"))
        )
        self.assertTrue(declared, "parsed no pack ids from the shipped deck")
        for alias, target in sorted(normalize_source.ALIASES.items()):
            with self.subTest(alias=alias):
                self.assertIn(target, declared | operator_only)

    def test_no_alias_target_is_itself_an_alias(self):
        """A fold must land in one hop, or `canonical` would depend on order."""
        aliases = normalize_source.ALIASES
        self.assertEqual(frozenset(aliases.values()) & frozenset(aliases), frozenset())

    def test_alias_keys_are_not_themselves_pack_ids(self):
        """A deck id must never be an alias key, or a real source would fold away."""
        declared = frozenset(
            re.findall(r"(?m)^  - id:\s*(\S+)", DECK.read_text(encoding="utf-8"))
        )
        self.assertEqual(frozenset(normalize_source.ALIASES) & declared, frozenset())


class BoundaryAgreementTests(unittest.TestCase):
    def test_score_matcher_agrees_with_table(self):
        for case in BOUNDARY_CASES:
            with self.subTest(text=case.text, token=case.token):
                self.assertEqual(
                    score._contains_token(case.text, case.token), case.expected
                )

    def test_check_parse_matcher_agrees_with_table(self):
        for case in BOUNDARY_CASES:
            with self.subTest(text=case.text, token=case.token):
                self.assertEqual(
                    check_parse_contains(case.text, case.token), case.expected
                )


class PolicyAgreementTests(unittest.TestCase):
    def test_duplicate_url_message_is_shared(self):
        from_score = score_duplicate_message()
        from_validate = validate_duplicate_message()
        self.assertEqual(from_score, DUPLICATE_MESSAGE)
        self.assertEqual(from_validate, DUPLICATE_MESSAGE)
        self.assertEqual(from_score, from_validate)

    def test_scaffold_errors_are_confined_to_worker_fields(self):
        """A raw scaffold is a skeleton, so validation is expected to reject it —
        but only ever for the two fields the worker owns. Every field the
        scaffold itself fills (url, schema_version, and the requirement list's
        contents, kinds and order) must already be correct, for any pair."""
        for case in SCAFFOLD_CASES:
            with self.subTest(case=case.name):
                result = validate_guidance.validate_payload(guidance_payload(case))
                errors = tuple(
                    error
                    for row in result["invalid"]
                    for error in row["errors"]
                )
                scaffold_owned = tuple(
                    error
                    for error in errors
                    if not error.startswith(WORKER_OWNED_FIELDS)
                )
                self.assertEqual(
                    scaffold_owned,
                    (),
                    f"scaffold produced errors outside the worker's fields: {scaffold_owned}",
                )

    def test_direct_skill_hold_is_directional(self):
        cases = (
            ("React.js", "React", True),
            ("React", "React.js", False),
        )
        for candidate_term, job_term, expected in cases:
            with self.subTest(candidate=candidate_term, job=job_term):
                self.assertEqual(
                    models.direct_skill_hold(candidate_term, job_term), expected
                )


class JobScoutStoreInstructionTests(unittest.TestCase):
    def test_gate_reapplies_date_after_extract(self):
        gate = instruction_text(FLOW_GATE)
        self.assertIn("drop a `jd_date` older than the kit `date_posted` window", gate)
        self.assertIn("blank is not a drop", gate)
        self.assertIn(
            "printed work_model that does not intersect kit-true flags (unknown → not a drop; no kit-true flag → not a drop)",
            gate,
        )
        self.assertIn(
            "named onsite place with no shared work_model flag (no kit-true flag → not a drop)",
            gate,
        )

    def test_search_keep_skips_printed_unauthorized_hire_from(self):
        search = instruction_text(FLOW_SEARCH)
        self.assertIn(
            "remote or hybrid-with-remote that already prints a hire-from country",
            search,
        )
        self.assertIn("→ drop; `worldwide` → keep", search)
        self.assertIn(
            "legal_authorization.jurisdictions[]` row with `legally_allowed_to_work: yes",
            search,
        )
        self.assertIn("legally_allowed_to_work_in_us", search)
        self.assertIn("a `direct_regions` token", search)
        self.assertIn("under `listed` only", search)
        self.assertIn("defect: locations_unauthorized", search)
        self.assertIn("city tokens that name no country", search)
        self.assertIn("location unknown → keep", search)
        self.assertIn("no kit-true flag → keep", search)
        self.assertIn("still gets stored slugs (2)", search)
        self.assertIn("`/embed/job_app`", search)
        self.assertIn("the `for` query value", search)
        self.assertIn("jobs.eu.lever.co", search)

    def test_equivalent_posting_is_a_log_not_a_merge(self):
        schema = instruction_text(SCHEMA_DOSSIER)
        self.assertIn("equivalent of scout/jobs/{other}", schema)
        self.assertIn("scout writes four events", schema)
        self.assertNotIn("scout writes exactly three events", schema)
        scout = instruction_text(harness.SKILL / "job-scout" / "SKILL.md")
        self.assertIn("do not merge", scout)
        self.assertIn("neither file already has", scout)
        queue = instruction_text(
            harness.SKILL / "job-store" / "references" / "flows" / "flow-queue.md"
        )
        self.assertIn("possible duplicate of scout/jobs/{other}", queue)
        self.assertIn("`new` and not dead-by-log", queue)
        self.assertIn("`applied`, `interview`, or `offer`", queue)

    def test_zero_keep_runs_are_a_named_defect(self):
        search = instruction_text(FLOW_SEARCH)
        self.assertIn("`zero_result_runs` = runs that kept no card", search)
        self.assertIn("a routed run is one expanded formulation, or one board slug on a `kind: board` pack, with location applied only as a keep filter", search)
        self.assertIn("a dom run is one expanded formulation, per named location under `listed`, or once under `worldwide`", search)
        self.assertIn("for dom runs under `listed`, every run for one named location zero-keep", search)
        self.assertIn("→ `defect: zero_results`", search)
        self.assertIn("a pack with `location: keep-only` runs under `listed` as under `worldwide`", search)
        self.assertIn("a `location: keep-only` pack has no per-location runs", search)
        self.assertNotIn("empty and clean is `pass`", search)

    def test_surface_interrupt_is_neither_zero_nor_unsubmitted_fault(self):
        search = instruction_text(FLOW_SEARCH)
        self.assertIn("`pack | formulations_run | zero_result_runs | unsubmitted_runs | verdict`", search)
        self.assertIn("is an interrupt, never a zero and never `query_not_submitted`", search)
        self.assertIn("re-submit one formulation that kept cards earlier in this run", search)
        self.assertIn("a run that recovers on another engine counts as submitted", search)
        self.assertIn("an interrupted page is not a zero_result_run", search)
        self.assertIn("every built run after the interrupted one is unsubmitted", search)
        self.assertIn(
            "`unsubmitted_runs` = built runs never submitted, counted after the interrupted run",
            search,
        )
        self.assertNotIn("every built run from the first interrupted one on", search)
        self.assertNotIn("counted from the first interrupted run", search)
        self.assertIn("`unsubmitted_runs` above `0` is always `defect: surface_interrupted`", search)
        self.assertIn("`query_not_submitted` names a pack fault", search)

    def test_dead_rows_are_decided_on_apply_signals_and_never_refilled(self):
        extract = instruction_text(FLOW_EXTRACT)
        search = instruction_text(FLOW_SEARCH)
        self.assertIn("`dead` is decided at the first page read", extract)
        self.assertIn("a 200 with a short not-found body counts", extract)
        self.assertIn("an ats api that returns no payload for the id", extract)
        self.assertIn("read nothing further on that page", extract)
        self.assertIn(
            "keep search columns (at minimum `url`) with `status` and `status_reason`",
            extract,
        )
        self.assertIn("the row keeps its pre-redirect url", extract)
        self.assertIn("a posting that redirects to another posting", extract)
        self.assertIn("is `dead` below and is never canonicalized", extract)
        self.assertIn("owns no dossier under its pre-fold url", extract)
        self.assertNotIn("closure lookup still finds", extract)
        self.assertNotIn("a posting that redirects → replace", extract)
        self.assertIn("they are not refilled from the search surface", extract)
        self.assertIn("a row extract later marks `dead` is not refilled", search)
        self.assertIn("set its date control to the `date_posted` window when it has one", search)

    def test_dom_candidates_carry_a_proven_formulation(self):
        search = instruction_text(FLOW_SEARCH)
        schema = instruction_text(SCHEMA_DOSSIER)
        self.assertIn("a dom candidate's `matched_query` is the expanded formulation whose echo proved the run", search)
        self.assertIn("has no proven run and is not a candidate", search)
        self.assertIn("the pack declares its surfaces; a run never adds one", search)
        self.assertIn("an expanded pack formulation, or a `positions[]` entry on a `kind: board` route", schema)
        self.assertIn("is not a provenance and the row does not persist", schema)

    def test_board_slugs_are_discovered_new_first(self):
        search = instruction_text(FLOW_SEARCH)
        prep = instruction_text(FLOW_PREP)
        self.assertIn(
            "`site:` cards on a `kind: board` pack are slug sources, not candidates",
            search,
        )
        self.assertIn("get new first", search)
        self.assertIn("there is no board-registry file", search)
        self.assertNotIn("`data/boards.yaml` is an optional seed", search)
        self.assertNotIn(
            "slugs are the `data/boards.yaml` rows whose `ats` equals the pack's; none → `defect: no_boards`",
            search,
        )
        self.assertIn("then `first_seen` descending", prep)
        self.assertNotIn("then `first_seen` ascending", prep)

    def test_unscored_rows_are_reported_apart_from_low_scores(self):
        rank = instruction_text(FLOW_RANK)
        match_gate = instruction_text(FLOW_MATCH_GATE)
        self.assertIn("either list empty → unscored (`—`)", rank)
        self.assertIn("reports it as gaps `unscorable`, never as `score<=7`", rank)
        self.assertIn("never invent requirements from the profile", rank)
        self.assertIn("kit drop, unscorable, score≤7", rank)
        self.assertIn("`score` is `—` → `unscorable: no requirements printed` when `required_skills` is `—`", match_gate)
        self.assertIn("integer `score` ≤ 7 → `score<=7`", match_gate)
        self.assertNotIn("`score` is `—` or integer ≤ 7", match_gate)

    def test_normalizer_is_the_shipped_script(self):
        section = instruction_section(SCHEMA_DOSSIER, "## URL normalize", "## File format")
        self.assertIn("run `./scripts/normalize_url.py`", section)
        self.assertIn("never by hand", section)
        self.assertIn("`hiringcafe.com` `/job/{slug}-{id}` → `/job/{id}`", section)
        self.assertIn("compare normalized to normalized", section)

    def test_tracker_keys_match_prose(self):
        section = instruction_section(SCHEMA_DOSSIER, "## URL normalize", "## File format")
        rule = section.partition("3. drop tracker query keys")[2].partition("(case-insensitive)")[0]
        prose = frozenset(re.findall(r"`([^`]+)`", rule))
        script = frozenset(prefix + "*" for prefix in normalize_url.TRACKER_PREFIXES) | frozenset(
            key.lower() for key in normalize_url.TRACKER_KEYS
        )
        self.assertEqual(prose, script)

    def test_dossier_validator_matches_readers(self):
        rule = FLOW_READ.read_text(encoding="utf-8").partition("Required keys:")[2].partition(".")[0]
        self.assertEqual(tuple(re.findall(r"`([^`]+)`", rule)), validate_dossier.KEYS)
        types = APP_TYPES.read_text(encoding="utf-8")
        for name, script in (
            ("LIFECYCLES", validate_dossier.STATUS),
            ("BUCKETS", validate_dossier.BUCKET),
            ("CHANNELS", validate_dossier.CHANNEL),
        ):
            array = re.search(r"const {0} = \[(.*?)\]".format(name), types).group(1)
            self.assertEqual(frozenset(re.findall(r'"([^"]+)"', array)), frozenset(script))


if __name__ == "__main__":
    unittest.main()

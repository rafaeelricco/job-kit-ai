#!/usr/bin/env python3
"""Fuzz the job-match scripts with hostile input and assert invariants.

Properties are data: a tuple of frozen ``Property`` records pairing a name with a
pure ``Mapping[str, object] -> Optional[str]`` check that returns a failure detail
or ``None``. Adding a property is appending to a tuple, not extending a branch.

One generated payload carries a whole scoring job — ``candidate``, ``jobs``,
``matches`` — plus the small auxiliary inputs the arithmetic and guidance
properties need, so every property reads the same seeded value and one failure
shrinks to a single JSON blob that reproduces it. The generator aims at the
boundaries the scripts defend: wrong types in every ``score_breakdown`` cell,
``held > required``, zero and negative ``required``, very large integers,
booleans where integers are expected (``bool`` is an ``int``, and the scripts
reject it on purpose), empty lists, missing keys, unknown extra keys, duplicate
job urls, non-ASCII and combining-mark skill tokens, empty and blank strings.

Assertions are about invariants, never about a specific score: a hostile row is
allowed to fail, but it must fail the documented way — a per-row ``score_error``
or, for a whole payload the scripts cannot read at all, a ``ValueError``.
"""

import argparse
import copy
import json
import math
import random
import sys
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, localcontext
from pathlib import Path
from types import ModuleType
from typing import Callable, Dict, List, Mapping, Optional, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import MATCH, load  # noqa: E402

models: ModuleType = load(MATCH / "models.py")
score: ModuleType = load(MATCH / "score.py")
scaffold_guidance: ModuleType = load(MATCH / "scaffold_guidance.py")
validate_guidance: ModuleType = load(MATCH / "validate_guidance.py")

Check = Callable[[Mapping[str, object]], Optional[str]]

#: Ranked decision bands, weakest first, derived from the scoring module's data.
BAND_RANK: Dict[str, int] = dict(
    [("skip", 0)]
    + [
        (decision, len(score.BANDS) - index)
        for index, (_floor, decision) in enumerate(score.BANDS)
    ]
)

#: Enough precision to quantize any generated magnitude exactly.
DECIMAL_PRECISION: int = 1200

#: Skill and role tokens: plausible, blank, non-ASCII, and combining-mark forms.
TOKENS: Tuple[str, ...] = (
    "react",
    "React.js",
    "TypeScript",
    "node",
    "go",
    "c++",
    "n",
    "",
    " ",
    "\t\n ",
    "café",
    "cafe\u0301",  # combining acute
    "Reac\u0301t",  # combining acute
    "日本語",
    "señor backend",
    "REACT",
    " react ",
)
TITLES: Tuple[str, ...] = (
    "Senior Frontend Engineer",
    "Backend Developer",
    "staff engineer",
    "",
    "   ",
    "Engenheiro de Software Sênior",
    "Reaćt Developer",
    "日本語 Engineer",
)
ROLE_TOKENS: Tuple[str, ...] = TOKENS + (
    "engineer",
    "developer",
    "frontend engineer",
    "staff engineer",
    "Sênior",
)
POSITIONS: Tuple[str, ...] = (
    "Senior Frontend Engineer",
    "Frontend Engineer",
    "junior developer",
    "principal engineer",
    "Backend Developer",
    "",
    "  ",
    "Desenvolvedor Sênior",
)
COMPANIES: Tuple[str, ...] = ("Acme", "Acme", "", "  ", "Órbita", "Globex")
SENIORITIES: Tuple[object, ...] = (
    "senior",
    "Mid-level",
    "principal",
    "intern",
    "",
    "  ",
    None,
    "日本語",
)
JOB_YEARS: Tuple[object, ...] = (
    "3+ years",
    "5 anos",
    "10",
    "2-4 years",
    "no number",
    "",
    "   ",
    "日本語 6",
    None,
)
YEAR_VALUES: Tuple[int, ...] = (-5, 0, 1, 2, 3, 5, 8, 10, 99, 10 ** 12)

#: Values a worker might put in a score cell, most of them illegal.
BAD_CELLS: Tuple[object, ...] = (
    True,
    False,
    3.5,
    "4",
    "",
    "  ",
    [],
    {},
    [4],
    {"held": 1},
    -1,
    -(10 ** 18),
    10 ** 18,
    1e300,
    999,
)
#: Integers for held/required, including bools, zero, negatives, and huge values.
STACK_COUNTS: Tuple[object, ...] = (
    0,
    1,
    2,
    3,
    -1,
    -(10 ** 12),
    10 ** 18,
    10 ** 40,
    True,
    False,
    None,
    "2",
    2.0,
    [],
)
#: Claim shapes for strengths/gaps/blockers, quoted and unquoted.
CLAIMS: Tuple[object, ...] = (
    "Ships react at scale",
    "Deep café experience",
    "日本語 fluency",
    "invented credential nobody quoted",
    "",
    "   ",
    0,
    True,
    None,
    ["react"],
    {"claim": "react"},
)
URLS: Tuple[str, ...] = (
    "https://a.example/1",
    "https://b.example/2",
    "https://c.example/3",
    "",
)
UNKNOWN_KEYS: Tuple[str, ...] = ("notes", "_meta", "extra_field", "日本")
STRAY_URLS: Tuple[object, ...] = ("https://missing.example/9", "", 7, None)
NUMERIC_FACTORS: Tuple[str, ...] = (
    "experience",
    "seniority",
    "role_type",
    "location",
    "domain",
    "language",
    "preferences",
)


@dataclass(frozen=True)
class Mix:
    """How often one generated value is corrupted, and in which way.

    Corruption is a dial, not a constant: a payload drawn at ``PLAIN`` mostly
    reaches a real score, so the range, ordering and evidence properties have
    something to hold; one drawn at ``HOSTILE`` mostly does not, so the error
    paths are the ones under test. Every shape stays reachable at both levels.
    """

    drop_key: float
    unknown_key: float
    wrong_type: float
    wrong_shape: float
    bad_cell: float
    stray_url: float


PLAIN: Mix = Mix(
    drop_key=0.06,
    unknown_key=0.15,
    wrong_type=0.02,
    wrong_shape=0.01,
    bad_cell=0.08,
    stray_url=0.08,
)
HOSTILE: Mix = Mix(
    drop_key=0.3,
    unknown_key=0.3,
    wrong_type=0.15,
    wrong_shape=0.07,
    bad_cell=0.55,
    stray_url=0.4,
)
HOSTILE_SHARE: float = 0.45


@dataclass(frozen=True)
class Property:
    """One named invariant and the pure check that looks for its violation."""

    name: str
    check: Check


@dataclass(frozen=True)
class Failure:
    """A violated property, with the smallest payload still violating it."""

    property_name: str
    seed: int
    payload: object
    detail: str

    def describe(self) -> str:
        """Render the failure with a payload that can be pasted back in."""
        return (
            f"{self.property_name} failed (seed {self.seed}): {self.detail}\n"
            f"shrunk payload:\n{json.dumps(self.payload, indent=2, default=repr)}"
        )


def _stable(value: object) -> str:
    """A comparable rendering that separates ``True`` from ``1`` and keeps order."""
    return json.dumps(value, default=repr)


def _tokens(rng: random.Random) -> List[str]:
    return [rng.choice(TOKENS) for _ in range(rng.randrange(0, 4))]


def _roles(rng: random.Random) -> List[str]:
    """Candidate roles, drawn so that a whole-phrase title hit is reachable."""
    return [rng.choice(ROLE_TOKENS) for _ in range(rng.randrange(0, 4))]


def _experience(rng: random.Random) -> List[Dict[str, object]]:
    return [
        {
            "company": rng.choice(COMPANIES),
            "position": rng.choice(POSITIONS),
            "date": rng.choice(("2020-2024", "", "  ")),
        }
        for _ in range(rng.randrange(0, 3))
    ]


def _candidate(rng: random.Random, mix: Mix) -> object:
    """A CandidateProfile source, sometimes missing keys or carrying bad types."""
    candidate: Dict[str, object] = {
        "roles": _roles(rng),
        "skills": _tokens(rng),
        "years_experience": rng.choice(YEAR_VALUES + (None,)),
        "experience": _experience(rng),
    }
    if rng.random() < mix.drop_key:
        del candidate[rng.choice(tuple(candidate))]
    if rng.random() < mix.unknown_key:
        candidate[rng.choice(UNKNOWN_KEYS)] = rng.choice(CLAIMS)
    if rng.random() < mix.wrong_type:
        candidate[rng.choice(("roles", "skills", "years_experience"))] = rng.choice(
            (True, "react", 7.5, [1, 2], {"a": 1})
        )
    if rng.random() < mix.wrong_shape:
        return rng.choice((None, [], "candidate", 5))
    return candidate


def _job(rng: random.Random, mix: Mix, url: str) -> object:
    """A JobProfile source, sometimes missing keys or carrying bad types."""
    job: Dict[str, object] = {
        "url": url,
        "title": rng.choice(TITLES),
        "seniority": rng.choice(SENIORITIES),
        "years_experience": rng.choice(JOB_YEARS),
        "required_skills": _tokens(rng),
        "preferred_skills": _tokens(rng),
    }
    if rng.random() < mix.drop_key:
        del job[rng.choice(("title", "seniority", "years_experience", "url"))]
    if rng.random() < mix.unknown_key:
        job[rng.choice(UNKNOWN_KEYS)] = rng.choice(CLAIMS)
    if rng.random() < mix.wrong_type:
        job[rng.choice(("url", "title", "required_skills"))] = rng.choice(
            (7, True, ["ok", 3], {"a": 1})
        )
    if rng.random() < mix.wrong_shape:
        return rng.choice((None, [], "job", 5))
    return job


def _stack_cell(rng: random.Random, mix: Mix) -> object:
    """A primary_stack cell: plausible ratio, inverted counts, or wrong shape."""
    if rng.random() < mix.bad_cell:
        cell: Dict[str, object] = {
            "held": rng.choice(STACK_COUNTS),
            "required": rng.choice(STACK_COUNTS),
        }
        if rng.random() < mix.drop_key:
            del cell[rng.choice(tuple(cell))]
        if rng.random() < mix.unknown_key:
            cell[rng.choice(UNKNOWN_KEYS)] = "kept by to_json"
        return cell
    if rng.random() < mix.wrong_shape:
        return rng.choice(([], "3/5", 4, True, {}))
    if rng.random() < 0.15:
        return None
    required = rng.randint(1, 6)
    held = required if rng.random() < 0.35 else rng.randint(0, required)
    return {"held": held, "required": required}


def _breakdown(rng: random.Random, mix: Mix) -> object:
    """A score_breakdown whose every cell can carry a legal or an illegal value."""
    if rng.random() < mix.wrong_shape:
        return rng.choice((None, [], "breakdown", 5, True))
    breakdown: Dict[str, object] = {"primary_stack": _stack_cell(rng, mix)}
    ceilings: Mapping[str, int] = score.WEIGHTS
    for name in NUMERIC_FACTORS:
        if rng.random() < mix.bad_cell:
            breakdown[name] = rng.choice(BAD_CELLS)
        else:
            breakdown[name] = rng.choice(
                (
                    None,
                    0,
                    ceilings[name],
                    ceilings[name],
                    rng.randint(0, ceilings[name]),
                )
            )
    if rng.random() < mix.drop_key:
        del breakdown[rng.choice(tuple(breakdown))]
    if rng.random() < mix.unknown_key:
        breakdown[rng.choice(UNKNOWN_KEYS)] = rng.choice(CLAIMS)
    return breakdown


def _claims(rng: random.Random, mix: Mix) -> object:
    if rng.random() < mix.wrong_type:
        return rng.choice((None, "react", 5, {"a": 1}))
    return [rng.choice(CLAIMS) for _ in range(rng.randrange(0, 4))]


def _match(rng: random.Random, mix: Mix, urls: Sequence[str]) -> object:
    """A MatchResult source pointing at a known url, an unknown one, or nothing."""
    if rng.random() < mix.wrong_shape:
        return rng.choice((None, [], "match", 5, True))
    row: Dict[str, object] = {
        "url": rng.choice(STRAY_URLS)
        if not urls or rng.random() < mix.stray_url
        else rng.choice(tuple(urls)),
        "score_breakdown": _breakdown(rng, mix),
        "strengths": _claims(rng, mix),
        "gaps": _claims(rng, mix),
        "blockers": _claims(rng, mix),
    }
    if rng.random() < mix.drop_key:
        del row[rng.choice(tuple(row))]
    if rng.random() < mix.unknown_key:
        row[rng.choice(UNKNOWN_KEYS)] = rng.choice(CLAIMS)
    if rng.random() < mix.wrong_type:
        row["match_score"] = rng.choice((-40, 9999, "high", None))
        row["confidence"] = rng.choice((-1.0, 42.0, "sure"))
        row["decision"] = rng.choice(("excellent_match", "unknown_band", 3))
    return row


def _numbers(rng: random.Random) -> List[object]:
    """Rounding inputs across magnitudes and signs.

    Magnitude is drawn on a log scale so the range is genuinely wide rather than
    all sixteen-digit values. Integers stop at ``2 ** 53``, the last magnitude a
    ``float`` still holds exactly: past it ``float(value)`` is itself lossy, so a
    disagreement would report on the conversion instead of on the rounding rule.
    """
    values: List[object] = []
    for _ in range(6):
        kind = rng.randrange(5)
        if kind == 0:
            bound = 2 ** rng.randint(1, 53)
            values.append(rng.randint(-bound, bound))
        elif kind == 1:
            values.append(rng.randint(-1000, 1000) + 0.5)
        elif kind == 2:
            values.append(rng.uniform(-1e6, 1e6))
        elif kind == 3:
            values.append(rng.uniform(-1.0, 1.0) * 10 ** rng.randint(-6, 30))
        else:
            values.append(rng.randint(-(10 ** 12), 10 ** 12) / rng.randint(1, 10 ** 6))
    return values


def _years(rng: random.Random) -> Dict[str, object]:
    return {
        "job": rng.choice(JOB_YEARS),
        "candidate": sorted(rng.choice(YEAR_VALUES) for _ in range(5)),
    }


def _guidance_pair(rng: random.Random) -> Dict[str, object]:
    """A structurally valid candidate/job pair whose content is still hostile.

    ``validate_guidance`` rejects a malformed payload before it ever looks at a
    guidance row, so the scaffold property keeps the shapes legal and puts the
    hostility in the tokens: blank, whitespace, non-ASCII, combining marks, and
    duplicate company/position pairs.
    """
    return {
        "candidate": {
            "skills": _tokens(rng),
            "experience": _experience(rng),
        },
        "job": {
            "url": rng.choice(URLS),
            "title": rng.choice(TITLES),
            "seniority": rng.choice(
                tuple(item for item in SENIORITIES if isinstance(item, str)) + (None,)
            ),
            "required_skills": _tokens(rng),
            "preferred_skills": _tokens(rng),
        },
    }


def _urls(rng: random.Random, mix: Mix) -> Tuple[str, ...]:
    """Job urls, sometimes duplicated so the duplicate-url guard is exercised."""
    chosen = rng.sample(URLS, rng.randint(1, 3))
    if rng.random() < mix.stray_url:
        chosen.append(chosen[0])
    return tuple(chosen)


def payloads(rng: random.Random, count: int) -> Tuple[Dict[str, object], ...]:
    """Structurally plausible AND deliberately hostile score payloads."""
    return tuple(_payload(rng) for _ in range(count))


def _payload(rng: random.Random) -> Dict[str, object]:
    mix = HOSTILE if rng.random() < HOSTILE_SHARE else PLAIN
    urls = _urls(rng, mix)
    payload: Dict[str, object] = {
        "candidate": _candidate(rng, mix),
        "jobs": [_job(rng, mix, url) for url in urls],
        "matches": [_match(rng, mix, urls) for _ in range(rng.randint(1, 3))],
        "numbers": _numbers(rng),
        "years": _years(rng),
        "guidance_pair": _guidance_pair(rng),
    }
    if rng.random() < mix.wrong_shape:
        payload[rng.choice(("jobs", "matches"))] = rng.choice(
            (None, {}, "rows", 5, True)
        )
    if rng.random() < mix.drop_key:
        del payload[rng.choice(("candidate", "jobs", "matches"))]
    if rng.random() < mix.unknown_key:
        payload[rng.choice(UNKNOWN_KEYS)] = rng.choice(CLAIMS)
    return payload


def _rows(payload: Mapping[str, object]) -> Optional[Sequence[Dict[str, object]]]:
    """Score a copy of the payload; ``None`` when it is unreadable as a whole."""
    try:
        return score.score_all(copy.deepcopy(payload))
    except ValueError:
        return None


def _scored(payload: Mapping[str, object]) -> Tuple[Dict[str, object], ...]:
    """Rows the scripts actually scored: no per-row ``score_error``."""
    rows = _rows(payload)
    if not isinstance(rows, list):
        return ()
    return tuple(
        row for row in rows if isinstance(row, dict) and "score_error" not in row
    )


def _dicts(value: object) -> Tuple[Dict[str, object], ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, dict))


def _no_unhandled_exception(payload: Mapping[str, object]) -> Optional[str]:
    try:
        rows = score.score_all(copy.deepcopy(payload))
    except ValueError:
        return None
    except Exception as error:  # noqa: BLE001 - the point of the property
        return f"score_all raised {type(error).__name__}: {error}"
    if not isinstance(rows, list):
        return f"score_all returned {type(rows).__name__}, not a list"
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            return f"row {index} is {type(row).__name__}, not an object"
    return None


def _score_and_confidence_in_range(payload: Mapping[str, object]) -> Optional[str]:
    for index, row in enumerate(_scored(payload)):
        match_score = row.get("match_score")
        confidence = row.get("confidence")
        if isinstance(match_score, bool) or not isinstance(match_score, int):
            return f"row {index}: match_score is {match_score!r}"
        if not 0 <= match_score <= 100:
            return f"row {index}: match_score {match_score} outside 0..100"
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
            return f"row {index}: confidence is {confidence!r}"
        if not 0 < confidence <= 1:
            return f"row {index}: confidence {confidence} outside (0, 1]"
    return None


def _decision_monotone_in_score(payload: Mapping[str, object]) -> Optional[str]:
    graded: List[Tuple[int, str, int]] = []
    for row in _scored(payload):
        match_score = row.get("match_score")
        decision = row.get("decision")
        if isinstance(match_score, bool) or not isinstance(match_score, int):
            continue
        if not isinstance(decision, str) or decision not in BAND_RANK:
            return f"decision {decision!r} is not a known band"
        graded.append((match_score, decision, BAND_RANK[decision]))
    for low in graded:
        for high in graded:
            if high[0] > low[0] and high[2] < low[2]:
                return (
                    f"score {high[0]} gives {high[1]} but score {low[0]} "
                    f"gives the stronger {low[1]}"
                )
    return None


def _deterministic(payload: Mapping[str, object]) -> Optional[str]:
    first = _outcome(payload)
    second = _outcome(payload)
    if first != second:
        return f"first run {first}\nsecond run {second}"
    return None


def _outcome(payload: Mapping[str, object]) -> str:
    try:
        return "ok:" + _stable(score.score_all(copy.deepcopy(payload)))
    except Exception as error:  # noqa: BLE001 - compared, not judged, here
        return f"raised:{type(error).__name__}:{error}"


def _input_not_mutated(payload: Mapping[str, object]) -> Optional[str]:
    subject = copy.deepcopy(payload)
    snapshot = copy.deepcopy(subject)
    try:
        score.score_all(subject)
    except Exception:  # noqa: BLE001 - raising at all is another property's job
        pass
    if _stable(subject) != _stable(snapshot):
        return f"before {_stable(snapshot)}\nafter  {_stable(subject)}"
    return None


def _quoted_cases(
    payload: Mapping[str, object],
) -> Tuple[Tuple[object, object], ...]:
    """Pair every readable match source with every readable job source."""
    candidate_source = payload.get("candidate")
    if not isinstance(candidate_source, dict):
        return ()
    try:
        candidate = models.CandidateProfile.from_json(candidate_source)
    except ValueError:
        return ()
    cases = []
    for job_source in _dicts(payload.get("jobs")):
        try:
            job = models.JobProfile.from_json(job_source)
        except ValueError:
            continue
        for match_source in _dicts(payload.get("matches")):
            try:
                row = models.MatchResult.from_json(match_source)
            except ValueError:
                continue
            cases.append((row, score.keep_quoted(row, candidate, job)))
    return tuple(cases)


def _is_subsequence(kept: Sequence[object], original: Sequence[object]) -> bool:
    position = 0
    for item in kept:
        while position < len(original) and original[position] != item:
            position += 1
        if position == len(original):
            return False
        position += 1
    return True


def _keep_quoted_conserves_items(payload: Mapping[str, object]) -> Optional[str]:
    for row, result in _quoted_cases(payload):
        drops = result.evidence_dropped or ()
        for name in score.QUOTED_LISTS:
            original = getattr(row, name)
            kept = getattr(result, name)
            if original is None:
                if kept is not None:
                    return f"{name}: absent list became {kept!r}"
                continue
            if kept is None:
                return f"{name}: present list became None"
            dropped = tuple(drop.item for drop in drops if drop.list_name == name)
            if len(kept) + len(dropped) != len(original):
                return (
                    f"{name}: {len(kept)} kept + {len(dropped)} dropped "
                    f"!= {len(original)} original"
                )
            if not _is_subsequence(kept, original):
                return f"{name}: kept {kept!r} is not a subsequence of {original!r}"
            for item in dropped:
                if item not in list(original):
                    return f"{name}: dropped {item!r} was never in the list"
    return None


def _keep_quoted_never_invents(payload: Mapping[str, object]) -> Optional[str]:
    """A kept claim must literally contain a string from the raw sources.

    The tokens are recomputed from the raw candidate and job JSON rather than
    from the parsed profiles, and containment is plain substring containment, so
    the check shares no code with the whole-token rule it is guarding.
    """
    candidate_source = payload.get("candidate")
    if not isinstance(candidate_source, dict):
        return None
    for job_source in _dicts(payload.get("jobs")):
        tokens = models.evidence_tokens(candidate_source) | models.evidence_tokens(
            job_source
        )
        try:
            candidate = models.CandidateProfile.from_json(candidate_source)
            job = models.JobProfile.from_json(job_source)
        except ValueError:
            continue
        for match_source in _dicts(payload.get("matches")):
            try:
                row = models.MatchResult.from_json(match_source)
            except ValueError:
                continue
            result = score.keep_quoted(row, candidate, job)
            for name in score.QUOTED_LISTS:
                for item in getattr(result, name) or ():
                    text = str(item).lower()
                    if not any(token in text for token in tokens):
                        return f"{name}: kept {item!r}, which quotes no source token"
    return None


def _match_result_roundtrip_is_superset(
    payload: Mapping[str, object],
) -> Optional[str]:
    for match_source in _dicts(payload.get("matches")):
        try:
            output = models.MatchResult.from_json(match_source).to_json()
        except ValueError:
            continue
        lost = sorted(set(match_source) - set(output))
        if lost:
            return f"roundtrip dropped keys: {', '.join(repr(key) for key in lost)}"
    return None


def _round_half_up(value: object) -> int:
    with localcontext() as context:
        context.prec = DECIMAL_PRECISION
        return int(Decimal(value).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _half_up_matches_decimal(payload: Mapping[str, object]) -> Optional[str]:
    numbers = payload.get("numbers")
    if not isinstance(numbers, list):
        return None
    for value in numbers:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if isinstance(value, float) and not math.isfinite(value):
            continue
        actual = score.half_up(value)
        expected = _round_half_up(value)
        if actual != expected:
            return f"half_up({value!r}) == {actual}, ROUND_HALF_UP gives {expected}"
    return None


def _experience_monotone(payload: Mapping[str, object]) -> Optional[str]:
    years = payload.get("years")
    if not isinstance(years, dict):
        return None
    token = years.get("job")
    raw = years.get("candidate")
    if not isinstance(raw, list):
        return None
    ordered = sorted(
        value
        for value in raw
        if isinstance(value, int) and not isinstance(value, bool)
    )
    previous: Optional[int] = None
    previous_year: Optional[int] = None
    for year in ordered:
        points = score.experience_points(year, token)
        if previous_year is not None and (points is None) != (previous is None):
            return (
                f"{token!r}: {previous_year} years scores {previous!r} but "
                f"{year} years scores {points!r}"
            )
        if previous is not None and points is not None and points < previous:
            return (
                f"{token!r}: {previous_year} years scores {previous} but "
                f"{year} years scores {points}"
            )
        previous = points
        previous_year = year
    return None


def _scaffold_always_validates(payload: Mapping[str, object]) -> Optional[str]:
    pair = payload.get("guidance_pair")
    if not isinstance(pair, dict):
        return None
    candidate_source = pair.get("candidate")
    job_source = pair.get("job")
    if not isinstance(candidate_source, dict) or not isinstance(job_source, dict):
        return None
    try:
        candidate = models.CandidateProfile.from_json(candidate_source)
        job = models.JobProfile.from_json(job_source)
    except ValueError as error:
        return f"guidance sources are unreadable: {error}"
    row = scaffold_guidance.scaffold(candidate, job).to_json()
    result = validate_guidance.validate_payload(
        {
            "candidate": candidate_source,
            "jobs": [job_source],
            "guidance": [row],
        }
    )
    invalid = result.get("invalid")
    if invalid:
        return f"validator rejected the scaffold: {_stable(invalid)}"
    if len(result.get("valid") or ()) != 1:
        return f"validator returned {_stable(result)}"
    return None


PROPERTIES: Tuple[Property, ...] = (
    Property("no_unhandled_exception", _no_unhandled_exception),
    Property("score_and_confidence_in_range", _score_and_confidence_in_range),
    Property("decision_monotone_in_score", _decision_monotone_in_score),
    Property("deterministic", _deterministic),
    Property("input_not_mutated", _input_not_mutated),
    Property("keep_quoted_conserves_items", _keep_quoted_conserves_items),
    Property("keep_quoted_never_invents", _keep_quoted_never_invents),
    Property(
        "match_result_roundtrip_is_superset", _match_result_roundtrip_is_superset
    ),
    Property("half_up_matches_decimal", _half_up_matches_decimal),
    Property("experience_monotone", _experience_monotone),
    Property("scaffold_always_validates", _scaffold_always_validates),
)


def _reductions(payload: Mapping[str, object]) -> Tuple[Dict[str, object], ...]:
    """Every one-step simplification: drop a key, a job, or a match."""
    smaller: List[Dict[str, object]] = []
    for key in tuple(payload):
        candidate = dict(payload)
        del candidate[key]
        smaller.append(candidate)
    for key in ("jobs", "matches"):
        rows = payload.get(key)
        if not isinstance(rows, list):
            continue
        for index in range(len(rows)):
            candidate = dict(payload)
            candidate[key] = rows[:index] + rows[index + 1:]
            smaller.append(candidate)
    return tuple(smaller)


def shrink(payload: Mapping[str, object], check: Check) -> Mapping[str, object]:
    """Smallest still-failing payload, by repeatedly dropping keys, jobs and matches."""
    current: Mapping[str, object] = payload
    if check(current) is None:
        return current
    reduced = True
    while reduced:
        reduced = False
        for candidate in _reductions(current):
            if check(candidate) is not None:
                current = candidate
                reduced = True
                break
    return current


def run(seed: int = 0, runs: int = 200) -> Tuple[Failure, ...]:
    """Every property against every generated payload; failures come back shrunk."""
    rng = random.Random(seed)
    failures: List[Failure] = []
    for payload in payloads(rng, runs):
        for prop in PROPERTIES:
            detail = prop.check(payload)
            if detail is None:
                continue
            smallest = shrink(payload, prop.check)
            failures.append(
                Failure(
                    property_name=prop.name,
                    seed=seed,
                    payload=smallest,
                    detail=prop.check(smallest) or detail,
                )
            )
    return tuple(failures)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--runs", type=int, default=200)
    options = parser.parse_args()

    failures = run(options.seed, options.runs)
    for failure in failures:
        print(failure.describe())
    names = sorted({failure.property_name for failure in failures})
    print(
        f"fuzz: seed {options.seed}, {options.runs} payloads, "
        f"{len(PROPERTIES)} properties, {len(failures)} failures"
        + (f" in {', '.join(names)}" if names else "")
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

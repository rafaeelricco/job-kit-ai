#!/usr/bin/env python3
"""Fill match scores from immutable profile and match values."""

import json
import math
import re
import sys
from collections import Counter
from copy import deepcopy
from dataclasses import replace
from typing import Callable, Dict, Mapping, Optional, Sequence, Tuple

from models import (
    CandidateProfile,
    Decision,
    EvidenceDrop,
    JobProfile,
    MatchResult,
    ScoreBreakdown,
    StackScore,
    stack_score,
)


WEIGHTS = {
    "primary_stack": 25,
    "experience": 20,
    "seniority": 15,
    "role_type": 15,
    "location": 10,
    "domain": 5,
    "language": 5,
    "preferences": 5,
}

BANDS: Tuple[Tuple[int, Decision], ...] = (
    (90, "excellent_match"),
    (80, "strong_match"),
    (70, "possible_match"),
    (50, "weak_match"),
)
DERIVED = ("primary_stack", "experience", "role_type")
QUOTED_LISTS = ("strengths", "gaps", "blockers")


def half_up(value: float) -> int:
    """Round half away from zero.

    Adding 0.5 and truncating is exact only while ``value + 0.5`` is
    representable. Between 2**52 and 2**53 the float spacing is 1.0, so the
    addition lands on an exact tie and rounds to even, moving every odd value
    one integer away from zero. Subtracting the floor instead is exact for
    every finite float — above 2**52 the floor is the value itself and the
    remainder is 0.0 — so the rule holds across the whole range.
    """
    floor = math.floor(value)
    remainder = value - floor
    if value >= 0:
        return floor + 1 if remainder >= 0.5 else floor
    return floor + 1 if remainder > 0.5 else floor


def require_integer(name: str, value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name}: must be an integer, got {value!r}")
    return value


def cell_points(name: str, cell: object) -> Optional[int]:
    """Return points for one factor, or ``None`` when it is unscored."""
    if cell is None:
        return None
    if name == "primary_stack":
        if isinstance(cell, StackScore):
            held, required = cell.held, cell.required
        elif isinstance(cell, dict):
            held = require_integer("primary_stack.held", cell.get("held"))
            required = require_integer(
                "primary_stack.required", cell.get("required")
            )
        else:
            raise ValueError(
                "primary_stack: cell must carry held/required counts"
            )
        if required < 1:
            raise ValueError("primary_stack.required must be at least 1")
        if not 0 <= held <= required:
            raise ValueError(
                "primary_stack.held must be between 0 and required"
            )
        return half_up(WEIGHTS[name] * held / required)
    points = require_integer(f"{name}: cell", cell)
    if not 0 <= points <= WEIGHTS[name]:
        raise ValueError(f"{name}: {points} outside 0..{WEIGHTS[name]}")
    return points


def experience_points(
    candidate_years: Optional[int], job_years: Optional[str]
) -> Optional[int]:
    """Score the first one- or two-digit integer in the job experience token as its floor."""
    if candidate_years is None or job_years is None:
        return None
    match = re.search(r"\b\d{1,2}\b", str(job_years))
    if match is None:
        return None
    return (
        WEIGHTS["experience"]
        if candidate_years >= int(match.group())
        else 10
    )


def _words(text: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text).lower()).strip()


def _contains_token(text: str, token: str) -> bool:
    """Return whether ``token`` appears in ``text`` unglued from other letters or digits."""
    if not token:
        return False
    pattern = r"(?<![^\W_])" + re.escape(token) + r"(?![^\W_])"
    return re.search(pattern, text) is not None


def role_type_points(title: str, roles: Sequence[str]) -> Optional[int]:
    """Match a candidate role as whole normalized words within the job title."""
    if not roles:
        return None
    haystack = f" {_words(title)} "
    hit = any(
        f" {_words(role)} " in haystack for role in roles if _words(role)
    )
    return WEIGHTS["role_type"] if hit else 0


def derive(
    breakdown: ScoreBreakdown,
    candidate: CandidateProfile,
    job: JobProfile,
) -> ScoreBreakdown:
    """Return comparison-defined cells; code wins over worker values."""
    return replace(
        breakdown,
        primary_stack=stack_score(candidate, job),
        experience=experience_points(
            candidate.years_experience, job.years_experience
        ),
        role_type=role_type_points(job.title, candidate.roles),
    )


def keep_quoted(
    row: MatchResult,
    candidate: CandidateProfile,
    job: JobProfile,
) -> MatchResult:
    """Return a copy without claims that quote no profile source token as a whole token."""
    tokens = candidate.evidence_tokens | job.evidence_tokens
    updates: Dict[str, object] = {}
    dropped = []
    for name in QUOTED_LISTS:
        items = getattr(row, name)
        if items is None:
            continue
        kept = []
        for item in items:
            text = str(item).lower()
            if any(_contains_token(text, token) for token in tokens):
                kept.append(item)
            else:
                dropped.append(EvidenceDrop(name, item))
        updates[name] = tuple(kept)
    if dropped:
        updates["evidence_dropped"] = tuple(dropped)
    return replace(row, **updates)


def score_breakdown(
    breakdown: ScoreBreakdown,
) -> Tuple[ScoreBreakdown, Mapping[str, int]]:
    scored: Dict[str, int] = {}
    for name in WEIGHTS:
        points = cell_points(name, getattr(breakdown, name))
        if points is not None:
            scored[name] = points
    return breakdown, scored


def decision_for(match_score: int) -> Decision:
    return next(
        (decision for floor, decision in BANDS if match_score >= floor),
        "skip",
    )


def score(row: MatchResult) -> MatchResult:
    breakdown, points = score_breakdown(row.score_breakdown)
    if not points:
        raise ValueError("no scored factor")
    weight_sum = sum(WEIGHTS[name] for name in points)
    match_score = half_up(100 * sum(points.values()) / weight_sum)
    return replace(
        row,
        score_breakdown=breakdown,
        match_score=match_score,
        confidence=round(weight_sum / 100, 2),
        decision=decision_for(match_score),
    )


def score_with_profiles(
    row: MatchResult,
    candidate: CandidateProfile,
    job: Optional[JobProfile],
) -> MatchResult:
    if job is None:
        raise ValueError("no JobProfile for this url")
    derived = replace(
        row,
        score_breakdown=derive(row.score_breakdown, candidate, job),
    )
    return score(keep_quoted(derived, candidate, job))


def _safe(
    operation: Callable[[], MatchResult], source: object
) -> Dict[str, object]:
    """Return a row-local score error without mutating the source value."""
    try:
        return operation().to_json()
    except ValueError as error:
        output = deepcopy(source) if isinstance(source, dict) else {}
        output["score_error"] = str(error)
        return output


def _legacy_row(source: object) -> MatchResult:
    return score(MatchResult.from_json(source))


def score_all(payload: object) -> Sequence[Dict[str, object]]:
    if isinstance(payload, list):
        return [_safe(lambda row=row: _legacy_row(row), row) for row in payload]
    if not isinstance(payload, dict):
        raise ValueError(
            "stdin must be a MatchResult array or a candidate/jobs/matches object"
        )
    candidate_source = payload.get("candidate")
    jobs_source = payload.get("jobs")
    matches = payload.get("matches")
    if (
        not isinstance(candidate_source, dict)
        or not isinstance(jobs_source, list)
        or not isinstance(matches, list)
    ):
        raise ValueError(
            "payload needs candidate (object), jobs (array), matches (array)"
        )

    candidate = CandidateProfile.from_json(candidate_source)
    parsed: Tuple[JobProfile, ...] = tuple(
        JobProfile.from_json(item)
        for item in jobs_source
        if isinstance(item, dict)
    )
    counts = Counter(job.url for job in parsed)
    by_url = {job.url: job for job in parsed if counts[job.url] == 1}
    duplicates = frozenset(url for url, n in counts.items() if n > 1)

    def operation(source: object) -> MatchResult:
        url = source.get("url") if isinstance(source, dict) else None
        if isinstance(url, str) and url in duplicates:
            raise ValueError("duplicate JobProfile url")
        job = by_url.get(url) if isinstance(url, str) else None
        if job is None:
            raise ValueError("no JobProfile for this url")
        row = MatchResult.from_json(source, ignored_breakdown=DERIVED)
        return score_with_profiles(row, candidate, job)

    return [_safe(lambda row=row: operation(row), row) for row in matches]


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        output = score_all(payload)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
        json.dump({"score_error": str(error)}, sys.stdout)
        sys.stdout.write("\n")
        return 1
    json.dump(output, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

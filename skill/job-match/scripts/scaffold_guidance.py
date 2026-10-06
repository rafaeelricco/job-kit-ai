#!/usr/bin/env python3
"""Emit ResumeGuidance skeletons for the guidance worker to classify.

stdin: {"candidate": CandidateProfile, "jobs": [JobProfile]}
stdout: [ResumeGuidance] — one row per JobProfile, every requirement present
once, under its source kind, in source order. A requirement with a direct
candidate skill hold is already `held`; every other requirement is `unknown`
for the worker to classify. `priority_roles` lists every candidate role the
sources support (experience order, one per company/position, `matched_on`
sorted), and `warnings` carries every code the sources decide, `no_relevant_role`
included. The worker changes only `status` (never to `held`); it never adds,
drops, or reorders requirements.

Contract: references/contracts/contract-resume-guidance.md.
"""
import json
import re
import sys
from typing import Dict, FrozenSet, List, Optional, Tuple

from models import (
    CandidateProfile,
    JobProfile,
    Requirement,
    RequirementKind,
    ResumeGuidance,
    direct_skill_hold,
)
from score import role_type_points

SENIORITY_LADDER = ("intern", "junior", "mid", "senior", "staff", "principal")


def _seniority_rank(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    words = frozenset(re.findall(r"[a-z0-9]+", value.casefold()))
    return next(
        (index for index, level in enumerate(SENIORITY_LADDER) if level in words),
        None,
    )


def _role_match_reasons(job: "JobProfile", position: str) -> FrozenSet[str]:
    """Return the source-supported reasons that make one candidate role relevant."""
    reasons = set()
    if role_type_points(job.title, (position,)) == 15:
        reasons.add("role_type")

    job_rank = _seniority_rank(job.seniority)
    role_rank = _seniority_rank(position)
    if (
        job_rank is not None
        and role_rank is not None
        and abs(job_rank - role_rank) <= 1
    ):
        reasons.add("seniority")
    return frozenset(reasons)


def _has_relevant_role(job: "JobProfile", candidate: "CandidateProfile") -> bool:
    """Return whether candidate experience contains a source-supported role."""
    return any(
        _role_match_reasons(job, role.position)
        for role in candidate.experience
    )


def priority_roles(
    candidate: CandidateProfile, job: JobProfile
) -> Tuple[Dict[str, object], ...]:
    """Return each source-supported candidate role once, in experience order."""
    roles: List[Dict[str, object]] = []
    seen = set()
    for role in candidate.experience:
        pair = (role.company, role.position)
        reasons = _role_match_reasons(job, role.position)
        if not reasons or pair in seen:
            continue
        seen.add(pair)
        roles.append(
            {
                "company": role.company,
                "position": role.position,
                "matched_on": sorted(reasons),
            }
        )
    return tuple(roles)


def requirement(
    kind: RequirementKind, term: str, skills: Tuple[str, ...]
) -> Requirement:
    held = next(
        (skill for skill in skills if direct_skill_hold(skill, term)),
        None,
    )
    return Requirement(
        kind=kind,
        job_term=term,
        status="held" if held is not None else "unknown",
        profile_term=held,
    )


def source_warnings(
    candidate: CandidateProfile, job: JobProfile
) -> Tuple[str, ...]:
    """Return the warning codes that candidate and job emptiness alone decide."""
    return (
        (() if candidate.skills else ("candidate_skills_empty",))
        + (() if job.required_skills else ("no_required_skills",))
    )


def scaffold(candidate: CandidateProfile, job: JobProfile) -> ResumeGuidance:
    requirements = tuple(
        requirement("required", term, candidate.skills)
        for term in job.required_skills
    ) + tuple(
        requirement("preferred", term, candidate.skills)
        for term in job.preferred_skills
    )
    roles = priority_roles(candidate, job)
    warnings = source_warnings(candidate, job) + (
        () if roles else ("no_relevant_role",)
    )
    return ResumeGuidance(
        job.url, requirements, priority_roles=roles, warnings=warnings
    )


def main() -> int:
    payload = json.load(sys.stdin)
    candidate = CandidateProfile.from_json(payload.get("candidate") or {})
    jobs = tuple(
        JobProfile.from_json(job) for job in payload.get("jobs") or []
    )
    output = [scaffold(candidate, job).to_json() for job in jobs]
    json.dump(output, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

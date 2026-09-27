#!/usr/bin/env python3
"""Emit ResumeGuidance skeletons for the guidance worker to classify.

stdin: {"candidate": CandidateProfile, "jobs": [JobProfile]}
stdout: [ResumeGuidance] — one row per JobProfile, every requirement present
once, under its source kind, in source order. A requirement with a direct
candidate skill hold is already `held`; every other requirement is `unknown`
for the worker to classify. `priority_roles` is empty and `warnings` carries
the two codes that emptiness alone decides.

Contract: references/contracts/contract-resume-guidance.md. The worker changes only
`status` (never to `held`) and `priority_roles`, and may add `no_relevant_role`;
it never adds, drops, or reorders requirements.
"""
import json
import sys
from typing import Tuple

from models import (
    CandidateProfile,
    JobProfile,
    Requirement,
    RequirementKind,
    ResumeGuidance,
    direct_skill_hold,
)


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
    return ResumeGuidance(
        job.url, requirements, warnings=source_warnings(candidate, job)
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

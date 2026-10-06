#!/usr/bin/env python3
"""Validate ResumeGuidance structure and source provenance."""

import json
import re
import sys
from collections import Counter
from dataclasses import dataclass
from typing import Dict, FrozenSet, List, Mapping, Optional, Sequence, Tuple

from models import CandidateProfile, Experience, JobProfile, direct_skill_hold
from scaffold_guidance import _has_relevant_role, _role_match_reasons, source_warnings


ALLOWED_STATUS = frozenset({"held", "not_evidenced", "unknown"})
ALLOWED_KIND = frozenset({"required", "preferred"})
ALLOWED_ROLE_MATCH = frozenset({"role_type", "seniority"})
ALLOWED_WARNINGS = frozenset(
    {"candidate_skills_empty", "no_required_skills", "no_relevant_role"}
)

PAYLOAD_KEYS = frozenset({"candidate", "jobs", "guidance"})
GUIDANCE_KEYS = frozenset(
    {"schema_version", "url", "requirements", "priority_roles", "warnings"}
)
REQUIREMENT_KEYS = frozenset(
    {"kind", "job_term", "status", "profile_term"}
)
PRIORITY_ROLE_KEYS = frozenset({"company", "position", "matched_on"})


@dataclass(frozen=True)
class SourceIndex:
    candidate: CandidateProfile
    jobs: Tuple[JobProfile, ...]
    guidance: Tuple[object, ...]


def _invalid(url: object, errors: Sequence[str]) -> Dict[str, object]:
    """Build one invalid result while preserving error order."""
    return {
        "url": url if isinstance(url, str) else "",
        "errors": list(errors),
    }


def _payload_error(message: str) -> Dict[str, object]:
    return {"valid": [], "invalid": [_invalid("", (message,))]}


def _validate_sources(
    payload: object,
) -> Tuple[Optional[SourceIndex], Optional[Dict[str, object]]]:
    """Validate raw JSON once, then return immutable typed source values."""
    if not isinstance(payload, dict):
        return None, _payload_error("payload must be an object")

    payload_keys = set(payload)
    if payload_keys != PAYLOAD_KEYS:
        errors = []
        missing = sorted(PAYLOAD_KEYS - payload_keys)
        extra = sorted(payload_keys - PAYLOAD_KEYS)
        if missing:
            errors.append("payload missing keys: " + ", ".join(missing))
        if extra:
            errors.append("payload unknown keys: " + ", ".join(extra))
        return None, {"valid": [], "invalid": [_invalid("", errors)]}

    candidate = payload["candidate"]
    jobs = payload["jobs"]
    guidance = payload["guidance"]
    if not isinstance(candidate, dict):
        return None, _payload_error("candidate must be an object")
    if not isinstance(jobs, list):
        return None, _payload_error("jobs must be an array")
    if not isinstance(guidance, list):
        return None, _payload_error("guidance must be an array")

    skills = candidate.get("skills")
    raw_experience = candidate.get("experience")
    if not isinstance(skills, list) or not all(
        isinstance(item, str) for item in skills
    ):
        return None, _payload_error(
            "candidate.skills must be an array of strings"
        )
    if not isinstance(raw_experience, list):
        return None, _payload_error("candidate.experience must be an array")

    experience = []
    for index, role in enumerate(raw_experience):
        if not isinstance(role, dict):
            return None, _payload_error(
                f"candidate.experience[{index}] must be an object"
            )
        company = role.get("company")
        position = role.get("position")
        if not isinstance(company, str) or not isinstance(position, str):
            return None, _payload_error(
                f"candidate.experience[{index}] company and position must be strings"
            )
        date = role.get("date", "")
        experience.append(
            Experience(
                company=company,
                position=position,
                date=date if isinstance(date, str) else "",
            )
        )

    job_rows = []
    for index, job in enumerate(jobs):
        if not isinstance(job, dict):
            return None, _payload_error(f"jobs[{index}] must be an object")
        url = job.get("url")
        required = job.get("required_skills")
        preferred = job.get("preferred_skills")
        if not isinstance(url, str):
            return None, _payload_error(f"jobs[{index}].url must be a string")
        if not isinstance(required, list) or not all(
            isinstance(item, str) for item in required
        ):
            return None, _payload_error(
                f"jobs[{index}].required_skills must be an array of strings"
            )
        if not isinstance(preferred, list) or not all(
            isinstance(item, str) for item in preferred
        ):
            return None, _payload_error(
                f"jobs[{index}].preferred_skills must be an array of strings"
            )
        try:
            job_rows.append(JobProfile.from_json(job))
        except ValueError as error:
            return None, _payload_error(f"jobs[{index}] {error}")

    typed_candidate = CandidateProfile(
        skills=tuple(skills),
        experience=tuple(experience),
    )
    return (
        SourceIndex(
            candidate=typed_candidate,
            jobs=tuple(job_rows),
            guidance=tuple(guidance),
        ),
        None,
    )


def _key_errors(
    value: Mapping[str, object], expected: FrozenSet[str], prefix: str = ""
) -> Tuple[str, ...]:
    keys = set(value)
    missing = sorted(expected - keys)
    extra = sorted(keys - expected)
    return (
        (() if not missing else (f"{prefix}missing keys: " + ", ".join(missing),))
        + (() if not extra else (f"{prefix}unknown keys: " + ", ".join(extra),))
    )


def _schema_errors(row: Mapping[str, object]) -> Tuple[str, ...]:
    return () if row.get("schema_version") == 1 else ("schema_version must be 1",)


def _url_errors(
    job: JobProfile, row: Mapping[str, object]
) -> Tuple[str, ...]:
    return () if row.get("url") == job.url else ("url does not match JobProfile",)


def _requirement_errors(
    job: JobProfile,
    row: Mapping[str, object],
    candidate_skills: FrozenSet[str],
) -> Tuple[str, ...]:
    requirements = row.get("requirements")
    if not isinstance(requirements, list):
        return ("requirements must be an array",)

    errors: List[str] = []
    actual = []
    for index, requirement in enumerate(requirements):
        prefix = f"requirements[{index}]"
        if not isinstance(requirement, dict):
            errors.append(f"{prefix} must be an object")
            actual.append((None, None))
            continue

        errors.extend(_key_errors(requirement, REQUIREMENT_KEYS, f"{prefix} "))
        kind = requirement.get("kind")
        job_term = requirement.get("job_term")
        status = requirement.get("status")
        profile_term = requirement.get("profile_term")
        actual.append((kind, job_term))

        if not isinstance(kind, str) or kind not in ALLOWED_KIND:
            errors.append(f"{prefix}.kind is invalid")
        if not isinstance(job_term, str):
            errors.append(f"{prefix}.job_term must be a string")
        if not isinstance(status, str) or status not in ALLOWED_STATUS:
            errors.append(f"{prefix}.status is invalid")
        if status == "held":
            if not isinstance(profile_term, str) or profile_term not in candidate_skills:
                errors.append(
                    f"{prefix}.profile_term is not an exact candidate skill"
                )
            elif isinstance(job_term, str) and not direct_skill_hold(
                profile_term, job_term
            ):
                errors.append(
                    f"{prefix}.profile_term does not directly hold job_term"
                )
        else:
            if profile_term is not None:
                errors.append(f"{prefix}.profile_term must be null unless held")
            if isinstance(job_term, str) and any(
                direct_skill_hold(skill, job_term) for skill in candidate_skills
            ):
                errors.append(
                    f"{prefix}.status must be held for a directly held skill"
                )

    expected = [
        ("required", term) for term in job.required_skills
    ] + [("preferred", term) for term in job.preferred_skills]
    if actual != expected:
        errors.append(
            "requirements must contain every JobProfile requirement once, "
            "under its source kind and in source order"
        )
    return tuple(errors)


def _priority_role_errors(
    job: JobProfile,
    row: Mapping[str, object],
    candidate: CandidateProfile,
) -> Tuple[str, ...]:
    priority_roles = row.get("priority_roles")
    if not isinstance(priority_roles, list):
        return ("priority_roles must be an array",)

    errors: List[str] = []
    candidate_roles = candidate.role_pairs
    if not priority_roles and _has_relevant_role(job, candidate):
        errors.append(
            "priority_roles must include a source-matched candidate role"
        )
    seen_roles = set()
    for index, role in enumerate(priority_roles):
        prefix = f"priority_roles[{index}]"
        if not isinstance(role, dict):
            errors.append(f"{prefix} must be an object")
            continue

        errors.extend(_key_errors(role, PRIORITY_ROLE_KEYS, f"{prefix} "))
        company = role.get("company")
        position = role.get("position")
        role_pair = (company, position)
        role_is_strings = isinstance(company, str) and isinstance(position, str)
        if not role_is_strings or role_pair not in candidate_roles:
            errors.append(f"{prefix} is not an exact candidate role")
        if role_is_strings and role_pair in seen_roles:
            errors.append(f"{prefix} duplicates a priority role")
        if role_is_strings:
            seen_roles.add(role_pair)

        matched_on = role.get("matched_on")
        if (
            not isinstance(matched_on, list)
            or not matched_on
            or any(
                not isinstance(item, str) or item not in ALLOWED_ROLE_MATCH
                for item in matched_on
            )
            or (
                all(isinstance(item, str) for item in matched_on)
                and len(matched_on) != len(set(matched_on))
            )
        ):
            errors.append(
                f"{prefix}.matched_on must contain unique role_type/seniority values"
            )
        elif role_is_strings and role_pair in candidate_roles:
            supported = _role_match_reasons(job, position)
            if "role_type" in matched_on and "role_type" not in supported:
                errors.append(f"{prefix}.matched_on role_type is unsupported")

            if "seniority" in matched_on and "seniority" not in supported:
                errors.append(f"{prefix}.matched_on seniority is unsupported")
    return tuple(errors)


def _warning_errors(
    job: JobProfile, row: Mapping[str, object], candidate: CandidateProfile
) -> Tuple[str, ...]:
    """Require the warnings the sources decide, no more and no fewer."""
    warnings = row.get("warnings")
    if not isinstance(warnings, list):
        return ("warnings must be an array",)
    if (
        any(
            not isinstance(item, str) or item not in ALLOWED_WARNINGS
            for item in warnings
        )
        or len(warnings) != len(set(warnings))
    ):
        return ("warnings must contain unique allowed warning codes",)

    expected = set(source_warnings(candidate, job))
    if not _has_relevant_role(job, candidate):
        expected.add("no_relevant_role")
    if set(warnings) != expected:
        return (
            "warnings must equal the codes the sources decide: "
            + (", ".join(sorted(expected)) or "none"),
        )
    return ()


def _validate_row(
    job: JobProfile, row: object, candidate: CandidateProfile
) -> Tuple[str, ...]:
    """Return every row error in stable contract order."""
    if not isinstance(row, dict):
        return ("guidance row must be an object",)
    return (
        *_key_errors(row, GUIDANCE_KEYS),
        *_schema_errors(row),
        *_url_errors(job, row),
        *_requirement_errors(job, row, frozenset(candidate.skills)),
        *_priority_role_errors(job, row, candidate),
        *_warning_errors(job, row, candidate),
    )


def validate_payload(payload: object) -> Dict[str, object]:
    """Validate a payload without mutating or dropping valid source rows."""
    sources, error_result = _validate_sources(payload)
    if error_result is not None:
        return error_result
    assert sources is not None

    guidance_by_url: Dict[str, List[Mapping[str, object]]] = {}
    malformed = []
    for index, row in enumerate(sources.guidance):
        if not isinstance(row, dict) or not isinstance(row.get("url"), str):
            malformed.append(
                _invalid("", (f"guidance[{index}] must have a string url",))
            )
            continue
        guidance_by_url.setdefault(row["url"], []).append(row)

    job_counts = Counter(job.url for job in sources.jobs)
    valid = []
    invalid = []
    known_urls = set(job_counts)

    for job in sources.jobs:
        url = job.url
        if job_counts[url] > 1:
            if not any(item["url"] == url for item in invalid):
                invalid.append(_invalid(url, ("duplicate JobProfile url",)))
            continue

        rows = guidance_by_url.get(url, [])
        if not rows:
            invalid.append(_invalid(url, ("missing guidance for JobProfile",)))
            continue
        if len(rows) > 1:
            invalid.append(_invalid(url, ("duplicate guidance for JobProfile",)))
            continue

        row = rows[0]
        errors = _validate_row(job, row, sources.candidate)
        if errors:
            invalid.append(_invalid(url, errors))
        else:
            valid.append(row)

    for url, rows in guidance_by_url.items():
        if url not in known_urls:
            for _row in rows:
                invalid.append(_invalid(url, ("guidance url has no JobProfile",)))

    invalid.extend(malformed)
    return {"valid": valid, "invalid": invalid}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        result = _payload_error(f"invalid JSON: {error}")
        json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
        sys.stdout.write("\n")
        return 1

    result = validate_payload(payload)
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Scout rank score: the 0–10 share of a posting's required skills held.

The one scout ``score`` rule (``job-scout/references/flows/flow-rank.md``).
Covered is ``models.direct_skill_hold`` and rounding is ``score.half_up``, the
same rule the match scorer's ``primary_stack`` uses, so the two never disagree
on what a profile skill covers.

stdin: ``{"skills": ["React.js", ...], "jobs": [{"url": "...",
"required_skills": ["React", ...] | "React, Go" | "—"}, ...]}``. A string is the
stored comma list, split as ``slice_store.job_profile`` does; ``—`` is none.
stdout: ``[{"url": "...", "score": <int 0-10 | null>, "covered": <int>,
"required": <int>}, ...]`` in input order; ``score`` is ``null`` when either
skill list is empty. Malformed input → ``{"stack_error": "..."}`` with exit 1.
"""

import json
import sys
from typing import Dict, List, Sequence

from models import direct_skill_hold
from score import half_up


def string_list(name: str, value: object) -> List[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"{name} must be a list of strings")
    return value


def required_list(value: object) -> List[str]:
    if isinstance(value, str):
        return [] if value.strip() == "—" else [s.strip() for s in value.split(",") if s.strip()]
    return string_list("required_skills", value)


def rank_row(skills: Sequence[str], job: object) -> Dict[str, object]:
    if not isinstance(job, dict):
        raise ValueError("each job must be an object")
    url = job.get("url")
    if not isinstance(url, str):
        raise ValueError("job url must be a string")
    required = required_list(job.get("required_skills"))
    covered = sum(
        1 for term in required if any(direct_skill_hold(skill, term) for skill in skills)
    )
    score = half_up(10 * covered / len(required)) if skills and required else None
    return {"url": url, "score": score, "covered": covered, "required": len(required)}


def rank_all(payload: object) -> List[Dict[str, object]]:
    if not isinstance(payload, dict):
        raise ValueError("payload must be an object")
    skills = string_list("skills", payload.get("skills"))
    jobs = payload.get("jobs")
    if not isinstance(jobs, list):
        raise ValueError("jobs must be a list")
    return [rank_row(skills, job) for job in jobs]


def write_json(value: object) -> None:
    sys.stdout.buffer.write((json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


def main() -> int:
    try:
        output = rank_all(json.loads(sys.stdin.buffer.read().decode("utf-8-sig")))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
        write_json({"stack_error": str(error)})
        return 1
    write_json(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

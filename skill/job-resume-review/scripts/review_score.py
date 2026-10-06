#!/usr/bin/env python3
"""Score a job-resume-review from its ratings: rubric v2 arithmetic, one home.

stdin:  {"criteria": {"positioning"|"skills"|"organization"|"visual"|"writing"|"parsing": 0-4 | null},
         "bullets": [{"id": str, "rating": 0-4, "recent": bool}],
         "blocking": [str],
         "requirements": [{"id": str, "kind": "must"|"preference"|"unclassified", "credit": 0 | 0.5 | 1}]}
        Every key is optional; a missing or null criterion, or a missing bullets key, is unassessed.
        An empty bullets array means the CV has no achievement descriptions and rates 0.
stdout: {"rubric_version", "criteria": [{"name", "weight", "rating", "points"}], "coverage",
         "weighted_score", "score", "capped", "provisional", "alignment"}
Exit 0 on success; 1 with {"review_score_error": str} on invalid input.
"""
from __future__ import annotations

import json
import sys
from typing import Any, Dict, Optional

VERSION = 2
WEIGHTS = {"positioning": 15, "bullets": 30, "skills": 15, "organization": 10, "visual": 5, "writing": 10, "parsing": 15}
CAP = 40
KIND_WEIGHTS = {"must": 2, "preference": 1, "unclassified": 1}
CREDITS = (0, 0.5, 1)
RATED = [name for name in WEIGHTS if name != "bullets"]


class InputError(ValueError):
    pass


def half_up(value: float) -> int:
    return int(value + 0.5)


def rating(value: Any, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 4:
        raise InputError(f"{where}: rating must be an integer 0-4")
    return value


def bullet_rating(bullets: Any) -> float:
    """Weighted mean: bullets in the two most recent roles weigh 2, others 1; none at all rates 0."""
    if not isinstance(bullets, list):
        raise InputError("bullets: must be an array")
    total = weight = 0
    for i, bullet in enumerate(bullets):
        if not isinstance(bullet, dict) or not isinstance(bullet.get("recent"), bool):
            raise InputError(f"bullets[{i}]: needs a boolean recent")
        w = 2 if bullet["recent"] else 1
        total += w * rating(bullet.get("rating"), f"bullets[{i}]")
        weight += w
    return total / weight if weight else 0.0


def alignment(requirements: Any) -> Optional[int]:
    if not isinstance(requirements, list):
        raise InputError("requirements: must be an array")
    credited = total = 0.0
    for i, req in enumerate(requirements):
        if not isinstance(req, dict) or req.get("kind") not in KIND_WEIGHTS:
            raise InputError(f"requirements[{i}]: kind must be must, preference, or unclassified")
        credit = req.get("credit")
        if isinstance(credit, bool) or credit not in CREDITS:
            raise InputError(f"requirements[{i}]: credit must be 0, 0.5, or 1")
        total += KIND_WEIGHTS[req["kind"]]
        credited += KIND_WEIGHTS[req["kind"]] * credit
    return half_up(100 * credited / total) if total else None


def score(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise InputError("payload must be an object")
    given = payload.get("criteria", {})
    if not isinstance(given, dict) or set(given) - set(RATED):
        raise InputError(f"criteria: keys must be among {RATED}")
    blocking = payload.get("blocking", [])
    if not isinstance(blocking, list) or not all(isinstance(b, str) and b for b in blocking):
        raise InputError("blocking: must be an array of non-empty strings")
    ratings = {name: None if given.get(name) is None else rating(given[name], f"criteria.{name}") for name in RATED}
    ratings["bullets"] = bullet_rating(payload["bullets"]) if "bullets" in payload else None
    rows = [{"name": name, "weight": weight,
             "rating": None if ratings[name] is None else round(ratings[name], 2),
             "points": None if ratings[name] is None else round(weight * ratings[name] / 4, 2)}
            for name, weight in WEIGHTS.items()]
    assessed = sum(row["weight"] for row in rows if row["rating"] is not None)
    earned = sum(weight * ratings[name] / 4 for name, weight in WEIGHTS.items() if ratings[name] is not None)
    weighted = half_up(100 * earned / assessed) if assessed else None
    final = weighted if weighted is None or not blocking else min(weighted, CAP)
    return {"rubric_version": VERSION, "criteria": rows, "coverage": assessed, "weighted_score": weighted,
            "score": final, "capped": final != weighted, "provisional": assessed < 100,
            "alignment": alignment(payload.get("requirements", []))}


def main() -> int:
    try:
        result = score(json.loads(sys.stdin.buffer.read().decode("utf-8-sig")))
    except ValueError as error:  # InputError, JSONDecodeError, UnicodeDecodeError
        print(json.dumps({"review_score_error": str(error)}))
        return 1
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

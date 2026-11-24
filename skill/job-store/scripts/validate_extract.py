"""Validate extract rows before gate.

Shape only, never truth: the page said what it said. Closed vocabularies for
`status` and `eligibility`; ISO day for `jd_date`; a free-text cell is `—` or
one complete printed phrase. `apply_url` is `—` or an http(s) URL.

stdin: ``{"rows": [{"url": ..., "<posting fact key>": ...}]}``.
stdout: ``{"rows": [{"url": ..., "errors": [...]}]}`` in the same order, or
``{"validate_error": "..."}`` with exit 1.
"""

import datetime
import json
import re
import sys
from typing import Dict, List, Tuple

STATUS: Tuple[str, ...] = ("live", "dead", "uncertain")
ELIGIBILITY: Tuple[str, ...] = ("confirmed", "incompatible", "unknown")
PHRASE_KEYS: Tuple[str, ...] = (
    "work_auth", "hiring_route", "eligibility_evidence", "location", "salary",
    "equity", "seniority", "work_model", "years_experience", "required_skills",
)
REQUIRED: Tuple[str, ...] = ("url", "status") + PHRASE_KEYS + ("jd_date", "apply_url")
UNKNOWN = "—"
ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HTTP_URL = re.compile(r"^https?://\S+$")
BAD_TAIL = re.compile(r"[\(\[\{:;,/-]$|\((?:[a-z]|e\.g\.?)?$")


def phrase_errors(key: str, value: str) -> List[str]:
    if value == UNKNOWN:
        return []
    errors: List[str] = []
    if value != value.strip() or "  " in value or "\n" in value:
        errors.append("{0}: not collapsed to one line".format(key))
    if "|" in value:
        errors.append("{0}: contains a pipe".format(key))
    if value[:1] in ":;,.)]}":
        errors.append("{0}: starts mid-sentence".format(key))
    if value.count("(") != value.count(")") or BAD_TAIL.search(value):
        errors.append("{0}: cut mid-phrase".format(key))
    return errors


def real_day(value: str) -> bool:
    if not ISO_DAY.match(value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def validate(row: Dict[str, object]) -> List[str]:
    errors: List[str] = []
    for key in REQUIRED:
        if not isinstance(row.get(key), str):
            errors.append("{0}: missing or not a string".format(key))
    if errors:
        return errors
    if row["status"] not in STATUS:
        errors.append("status: not in {0}".format("|".join(STATUS)))
    eligibility = row.get("eligibility")
    if eligibility is not None and eligibility not in ELIGIBILITY:
        errors.append("eligibility: not in {0}".format("|".join(ELIGIBILITY)))
    if row["jd_date"] != UNKNOWN and not real_day(str(row["jd_date"])):
        errors.append("jd_date: not YYYY-MM-DD or —")
    if row["apply_url"] != UNKNOWN and not HTTP_URL.match(str(row["apply_url"])):
        errors.append("apply_url: not an http(s) url or —")
    for key in PHRASE_KEYS:
        errors.extend(phrase_errors(key, str(row[key])))
    return errors


def validate_payload(payload: object) -> Tuple[int, Dict[str, object]]:
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        return 1, {"validate_error": "stdin must be an object with a rows array of objects"}
    return 0, {"rows": [{"url": r.get("url"), "errors": validate(r)} for r in rows]}


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        code, result = 1, {"validate_error": "invalid JSON: {0}".format(error)}
    else:
        code, result = validate_payload(payload)
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())

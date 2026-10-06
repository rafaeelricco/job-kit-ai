"""Read scout/jobs/ per flow-read.md and emit job-match candidate slices.

Never writes under ``root``; the only write is the batch files under ``out``.

stdin: ``{"root": abs Profile root, "select": "new" | "all" | "<file>.md",
"exclude": [frontmatter status], "skip": [dossier filename], "out": abs dir,
"batch": positive int (default 10)}``.

Without ``out``: ``{"count", "filter": [{file, company, title, location,
work_model, work_auth, hiring_route, eligibility, eligibility_evidence,
salary}], "gaps": [{path, reason}]}``. With ``out``: writes
``out/extract-NN.json`` = ``{"excerpts": [<= batch rows]}`` for the selected rows
minus ``skip`` and prints ``{"count", "batches": [paths], "gaps"}``. A bad
payload prints ``{"slice_error": "..."}`` with exit 1.
"""

import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

from validate_dossier import frontmatter

MARKER = "<!-- scout never writes below this line -->"
UNKNOWN = "—"
REQUIRED = ("company", "title", "url", "status")
STATUSES = ("new", "applied", "rejected", "interview", "offer", "dropped")
FILTER_KEYS = (
    "location",
    "work_model",
    "work_auth",
    "hiring_route",
    "eligibility",
    "eligibility_evidence",
    "salary",
)
JOB_FACT_KEYS = (
    "seniority",
    "work_model",
    "location",
    "salary",
    "years_experience",
    "work_auth",
    "hiring_route",
    "eligibility",
    "eligibility_evidence",
)
LOG_LINE = re.compile(r"^- \d{4}-\d{2}-\d{2} · (.+) — (\S+)$")
CLOSERS = ("job-scout", "job-prep", "job-apply", "job-application")
CELL_SPLIT = re.compile(r"(?<!\\)\|")


def section(lines: List[str], heading: str) -> List[str]:
    """Lines under ``## heading`` up to the next ``## `` heading."""
    if heading not in lines:
        return []
    rest = lines[lines.index(heading) + 1:]
    for index, line in enumerate(rest):
        if line.startswith("## "):
            return rest[:index]
    return rest


def posting_facts(lines: List[str]) -> Dict[str, str]:
    facts: Dict[str, str] = {}
    for line in section(lines, "## Posting facts"):
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [c.strip().replace("\\|", "|") for c in CELL_SPLIT.split(stripped)[1:-1]]
        if len(cells) != 2 or set(cells[0]) <= set("-: ") or cells[0] == "key":
            continue
        facts[cells[0]] = cells[1]
    return facts


def role(lines: List[str]) -> Dict[str, Any]:
    result: Dict[str, Any] = {"snapshot": None, "do": [], "must": []}
    target: Optional[str] = None
    for line in section(lines, "## The role"):
        if line.startswith("**Snapshot** — "):
            result["snapshot"] = line[len("**Snapshot** — "):].strip() or None
            target = None
        elif line.strip() == "**What you'd do**":
            target = "do"
        elif line.strip() == "**Must have**":
            target = "must"
        elif line.startswith("- ") and target is not None:
            result[target].append(line[2:].strip())
    return result


def dead_by_log(lines: List[str]) -> bool:
    if MARKER not in lines:
        return False
    for line in reversed(lines[lines.index(MARKER) + 1:]):
        match = LOG_LINE.match(line)
        if match is None:
            continue
        event, writer = match.group(1), match.group(2)
        if event.startswith("posting dead:") and writer in CLOSERS:
            return True
        if event == "posting live again" and writer == "job-scout":
            return False
    return False


def read_dossier(path: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Return (dossier, None) or (None, gap reason)."""
    try:
        with open(path, encoding="utf-8-sig") as handle:
            lines = handle.read().splitlines()
    except (OSError, UnicodeDecodeError) as error:
        return None, "unreadable: {0}".format(error)
    fields, errors = frontmatter(lines)
    if errors:
        return None, errors[0]
    missing = [key for key in REQUIRED if key not in fields]
    if missing:
        return None, "missing {0}".format(", ".join(missing))
    return {"lines": lines, "fields": fields}, None


def select_rows(
    root: str, select: str, exclude: List[str]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    jobs = os.path.join(root, "scout", "jobs")
    rows: List[Dict[str, Any]] = []
    gaps: List[Dict[str, str]] = []
    if select.endswith(".md"):
        names = [select]
    elif os.path.isdir(jobs):
        names = sorted(
            n for n in os.listdir(jobs)
            if n.endswith(".md") and os.path.isfile(os.path.join(jobs, n))
        )
    else:
        names = []
    for name in names:
        path = os.path.join(jobs, name)
        if select.endswith(".md") and not os.path.isfile(path):
            continue
        dossier, reason = read_dossier(path)
        if dossier is None:
            gaps.append({"path": path, "reason": reason or "unparseable"})
            continue
        status = dossier["fields"]["status"]
        if not select.endswith(".md"):
            if dead_by_log(dossier["lines"]) or status in exclude:
                continue
            if select == "new" and status != "new":
                continue
            if select == "all" and status == "dropped":
                continue
        dossier["file"] = name
        rows.append(dossier)
    return rows, gaps


def filter_row(dossier: Dict[str, Any]) -> Dict[str, str]:
    facts = posting_facts(dossier["lines"])
    row = {
        "file": dossier["file"],
        "company": dossier["fields"]["company"],
        "title": dossier["fields"]["title"],
    }
    for key in FILTER_KEYS:
        row[key] = facts.get(key, "unknown" if key == "eligibility" else UNKNOWN)
    return row


def job_profile(fields: Dict[str, str], facts: Dict[str, str], score: Optional[int]) -> Dict[str, Any]:
    """JobProfile keys a dossier fixes; the extract worker adds the judged rest."""

    def value(key: str) -> Optional[str]:
        return None if facts.get(key, UNKNOWN) == UNKNOWN else facts[key]

    skills = value("required_skills") or ""
    profile: Dict[str, Any] = {
        "url": fields["url"],
        "company": fields["company"],
        "title": fields["title"],
        "scout_score": score,
    }
    for key in JOB_FACT_KEYS:
        profile[key] = value(key)
    profile["required_skills"] = [s.strip() for s in skills.split(",") if s.strip()]
    profile["preferred_skills"] = []
    profile["languages_required"] = []
    profile["languages_preferred"] = []
    profile["domain"] = None
    return profile


def excerpt(dossier: Dict[str, Any]) -> Dict[str, Any]:
    fields = dossier["fields"]
    raw = fields.get("score", UNKNOWN)
    score = int(raw) if raw.isdigit() else None
    facts = posting_facts(dossier["lines"])
    return {
        "file": dossier["file"],
        "url": fields["url"],
        "company": fields["company"],
        "title": fields["title"],
        "score": score,
        "status": fields["status"],
        "facts": facts,
        "role": role(dossier["lines"]),
        "job": job_profile(fields, facts, score),
    }


def string_list(value: object) -> bool:
    return isinstance(value, list) and all(isinstance(v, str) for v in value)


def slice_payload(payload: object) -> Tuple[int, Dict[str, object]]:
    def fail(message: str) -> Tuple[int, Dict[str, object]]:
        return 1, {"slice_error": message}

    if not isinstance(payload, dict):
        return fail("stdin must be an object")
    root = payload.get("root")
    if not isinstance(root, str) or not os.path.isabs(root):
        return fail("root must be an absolute path")
    select = payload.get("select")
    if not isinstance(select, str) or not (
        select in ("new", "all")
        or (select.endswith(".md") and select == os.path.basename(select))
    ):
        return fail('select must be "new", "all", or a dossier filename ending in .md')
    exclude = payload.get("exclude", [])
    if not string_list(exclude) or any(s not in STATUSES for s in exclude):
        return fail("exclude must be an array of frontmatter statuses")
    if select.endswith(".md") and exclude:
        return fail("exclude does not apply to a dossier filename")
    skip = payload.get("skip", [])
    if not string_list(skip):
        return fail("skip must be an array of dossier filenames")
    out = payload.get("out")
    if out is not None and (not isinstance(out, str) or not os.path.isabs(out)):
        return fail("out must be an absolute path")
    if out is not None and (os.path.realpath(out) + os.sep).startswith(os.path.realpath(root) + os.sep):
        return fail("out must be outside root")
    batch = payload.get("batch", 10)
    if isinstance(batch, bool) or not isinstance(batch, int) or batch < 1:
        return fail("batch must be a positive integer")

    rows, gaps = select_rows(root, select, list(exclude))
    if select.endswith(".md") and not rows and not gaps:
        return fail("no such dossier: {0}".format(select))
    if out is None:
        return 0, {"count": len(rows), "filter": [filter_row(r) for r in rows], "gaps": gaps}

    kept = [r for r in rows if r["file"] not in skip]
    os.makedirs(out, exist_ok=True)
    batches: List[str] = []
    for start in range(0, len(kept), batch):
        path = os.path.join(out, "extract-{0:02d}.json".format(len(batches) + 1))
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(
                {"excerpts": [excerpt(r) for r in kept[start:start + batch]]},
                handle, indent=2, ensure_ascii=False,
            )
            handle.write("\n")
        batches.append(path)
    return 0, {"count": len(kept), "batches": batches, "gaps": gaps}


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        code, result = 1, {"slice_error": "invalid JSON: {0}".format(error)}
    else:
        code, result = slice_payload(payload)
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())

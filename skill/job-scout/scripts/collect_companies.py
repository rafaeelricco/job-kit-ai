#!/usr/bin/env python3
"""Collect job candidates from a company CSV through vendor JSON APIs.

stdin: {"csv": abs path, "state": abs path, "pack": id, "regions": [..],
        "tiers": [..], "positions": [..], "limit": int}
stdout: {"candidates": [..], "boards": {"fetched", "failed", "unsupported",
         "no_ats", "remaining"}, "queued": int}, or {"collect_error": "..."} with exit 1.

CSV columns read: row_id, region, tier, company_name, ats, ats_tenant, and
optional ats_evidence (an EU Greenhouse or EU Lever host makes the row
unsupported). State is {"boards": {row_id: {"checked_at", "status", "error"?,
"sent"?}}, "queue": [..]}, written atomically; a re-fetched board queues only
matched urls not in its `sent` list. Queued candidates are emitted before any new fetch; boards
are fetched never-checked first, then oldest checked_at, then row_id, each at
most once per call, until the queue reaches `limit` or no board is left. A
fetch error, HTTP 429/5xx, or a missing response path marks the board
`failed`, never zero jobs. Title match is the first positions[] entry found
as whole words, case-insensitive, punctuation ignored.
"""
import csv
import http.client
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, Tuple

UNKNOWN = "—"
COLLECTORS = ("workday", "greenhouse", "ashby", "lever")
GREENHOUSE = "https://boards-api.greenhouse.io/v1/boards/{tenant}/jobs"
ASHBY = "https://api.ashbyhq.com/posting-api/job-board/{tenant}"
LEVER = "https://api.lever.co/v0/postings/{tenant}?mode=json"
# Tenant "host/wdN/site" → https://{host}.{wdN}.myworkdayjobs.com
WORKDAY = "https://{host}.{wd}.myworkdayjobs.com/wday/cxs/{host}/{site}/jobs"
WORKDAY_PAGE = 20
TIMEOUT = 10
MIN_INTERVAL = 1.0
COLUMNS = ("row_id", "region", "tier", "company_name", "ats", "ats_tenant")
EU_INSTANCES = (".eu.greenhouse.io", "jobs.eu.lever.co", "api.eu.lever.co")
ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}")

Fetch = Callable[[str, Optional[Dict[str, Any]]], Any]  # GET when body is None, else POST JSON

LAST_REQUEST: Dict[str, float] = {}


class FetchError(Exception):
    pass


def words(text: str) -> list:
    return re.findall(r"\w+", text.lower())


def title_match(title: str, positions: list) -> Optional[str]:
    have = words(title)
    for position in positions:
        want = words(position)
        if not want:
            continue
        for start in range(len(have) - len(want) + 1):
            if have[start:start + len(want)] == want:
                return position
    return None


def day_of(value: Any) -> str:
    if isinstance(value, str) and ISO_DAY.match(value):
        return value[:10]
    return UNKNOWN


def epoch_day(value: Any) -> str:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            return datetime.fromtimestamp(value / 1000, timezone.utc).strftime("%Y-%m-%d")
        except (OverflowError, OSError, ValueError):
            return UNKNOWN
    return UNKNOWN


def expect(data: Any, key: str, kind: type) -> Any:
    if not isinstance(data, dict) or not isinstance(data.get(key), kind):
        raise FetchError("response missing {}".format(key))
    return data[key]


def text_of(value: Any) -> str:
    return value if isinstance(value, str) and value.strip() else UNKNOWN


def nested(item: dict, key: str, inner: str) -> Any:
    value = item.get(key)
    return value.get(inner) if isinstance(value, dict) else None


def job(title: Any, url: Any, location: Any, date: str) -> dict:
    if not isinstance(title, str) or not isinstance(url, str):
        raise FetchError("job without title or url")
    return {"title": title, "url": url, "location": text_of(location), "date": date}


def workday_jobs(tenant: str, positions: list, fetch: Fetch) -> list:
    parts = tenant.split("/")
    if len(parts) != 3 or not all(parts):
        raise FetchError("bad workday tenant")
    host, wd, site = parts
    api = WORKDAY.format(host=host, wd=wd, site=site)
    base = "https://{}.{}.myworkdayjobs.com/{}".format(host, wd, site)
    found: Dict[str, dict] = {}
    for position in positions:
        offset, total = 0, None
        while True:
            reply = fetch(api, {"limit": WORKDAY_PAGE, "offset": offset,
                                "searchText": position, "appliedFacets": {}})
            # Workday may send `total` only on the first page; later pages say 0.
            if total is None:
                total = expect(reply, "total", int)
            page = expect(reply, "jobPostings", list)
            if not page:
                break
            for item in page:
                if not isinstance(item, dict) or not isinstance(item.get("externalPath"), str):
                    raise FetchError("job without externalPath")
                url = base + item["externalPath"]
                if url not in found:
                    found[url] = job(item.get("title"), url, item.get("locationsText"), UNKNOWN)
            offset += WORKDAY_PAGE
            if offset >= total:
                break
    return list(found.values())


def board_jobs(ats: str, tenant: str, positions: list, fetch: Fetch) -> list:
    """Return [{"title", "url", "location", "date"}] for one board, all pages.
    Workday runs one paged searchText query per position and dedupes by url."""
    if ats == "workday":
        return workday_jobs(tenant, positions, fetch)
    quoted = urllib.parse.quote(tenant, safe="")
    if ats == "greenhouse":
        items = expect(fetch(GREENHOUSE.format(tenant=quoted), None), "jobs", list)
        return [job(i.get("title"), i.get("absolute_url"), nested(i, "location", "name"),
                    day_of(i.get("first_published"))) for i in items if isinstance(i, dict)]
    if ats == "ashby":
        items = expect(fetch(ASHBY.format(tenant=quoted), None), "jobs", list)
        return [job(i.get("title"), i.get("jobUrl"), i.get("location"), day_of(i.get("publishedAt")))
                for i in items if isinstance(i, dict) and i.get("isListed") is not False]
    if ats == "lever":
        reply = fetch(LEVER.format(tenant=quoted), None)
        if not isinstance(reply, list):
            raise FetchError("response is not a list")
        return [job(i.get("text"), i.get("hostedUrl"), nested(i, "categories", "location"),
                    epoch_day(i.get("createdAt"))) for i in reply if isinstance(i, dict)]
    raise FetchError("unsupported ats {}".format(ats))


def bad_payload(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return "payload must be an object"
    path = payload.get("csv")
    if not isinstance(path, str) or not os.path.isabs(path):
        return "csv must be an absolute path"
    path = payload.get("state")
    if not isinstance(path, str) or not os.path.isabs(path):
        return "state must be an absolute path"
    pack = payload.get("pack")
    if not isinstance(pack, str) or not pack:
        return "pack must be a non-empty string"
    for key in ("regions", "tiers", "positions"):
        value = payload.get(key)
        if not isinstance(value, list) or not value or not all(isinstance(v, str) for v in value):
            return "{} must be a non-empty list of strings".format(key)
    limit = payload.get("limit")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0:
        return "limit must be a positive integer"
    return None


def read_rows(path: str) -> list:
    with open(path, newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        missing = [c for c in COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise ValueError("csv missing columns: {}".format(", ".join(missing)))
        rows = []
        for row in reader:
            kept = {c: (row.get(c) or "").strip() for c in COLUMNS}
            # EU Greenhouse and EU Lever boards live on other API hosts.
            if any(host in (row.get("ats_evidence") or "") for host in EU_INSTANCES):
                kept["ats"] += "-eu"
            rows.append(kept)
        return rows


def read_state(path: str) -> dict:
    if not os.path.exists(path):
        return {"boards": {}, "queue": []}
    with open(path, encoding="utf-8-sig") as handle:
        state = json.load(handle)
    if not isinstance(state, dict) or not isinstance(state.get("boards"), dict) \
            or not isinstance(state.get("queue"), list):
        raise ValueError("state file has the wrong shape")
    return state


def write_state(path: str, state: dict) -> None:
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    handle, tmp = tempfile.mkstemp(dir=folder, prefix=".collect-", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(state, out, indent=2, ensure_ascii=False)
            out.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def collect(payload: Any, fetch: Fetch, now: str) -> Tuple[int, Dict[str, Any]]:
    problem = bad_payload(payload)
    if problem:
        return 1, {"collect_error": problem}
    try:
        rows = read_rows(payload["csv"])
        state = read_state(payload["state"])
    except (OSError, ValueError) as exc:
        return 1, {"collect_error": str(exc)}
    regions = {r.casefold() for r in payload["regions"]}
    tiers = {t.casefold() for t in payload["tiers"]}
    selected = [r for r in rows if r["region"].casefold() in regions and r["tier"].casefold() in tiers]
    unsupported = [{"row_id": r["row_id"], "ats": r["ats"]} for r in selected
                   if r["ats"] and r["ats"] not in COLLECTORS]
    no_ats = sum(1 for r in selected if not r["ats"])
    boards = state["boards"]

    def record(row_id: str) -> dict:
        seen = boards.get(row_id)
        return seen if isinstance(seen, dict) else {}

    def order(row: dict) -> tuple:
        checked = record(row["row_id"]).get("checked_at")
        checked = checked if isinstance(checked, str) else None
        return (checked is not None, checked or "", row["row_id"])

    todo = sorted((r for r in selected if r["ats"] in COLLECTORS), key=order)
    queue = [c for c in state["queue"] if isinstance(c, dict) and isinstance(c.get("url"), str)]
    urls = {c["url"] for c in queue}
    limit, fetched, failed = payload["limit"], 0, []
    while todo and len(queue) < limit:
        row = todo.pop(0)
        try:
            found = board_jobs(row["ats"], row["ats_tenant"], payload["positions"], fetch)
        except FetchError as exc:
            message = str(exc) or "fetch failed"
            boards[row["row_id"]] = {"checked_at": now, "status": "failed", "error": message}
            failed.append({"row_id": row["row_id"], "ats": row["ats"], "error": message})
            continue
        fetched += 1
        # `sent`: matched urls already handed off or queued from this board; a
        # re-fetch queues only new ones, and closed postings fall out of it.
        sent = record(row["row_id"]).get("sent")
        sent = set(sent) if isinstance(sent, list) else set()
        matched = []
        for item in found:
            query = title_match(item["title"], payload["positions"])
            if query is None:
                continue
            matched.append(item["url"])
            if item["url"] in urls or item["url"] in sent:
                continue
            urls.add(item["url"])
            queue.append({"company": row["company_name"], "title": item["title"], "url": item["url"],
                          "source": payload["pack"], "channel": "ats", "author": UNKNOWN,
                          "contact": UNKNOWN, "date": item["date"], "matched_query": query,
                          "location": item["location"]})
        boards[row["row_id"]] = {"checked_at": now, "status": "done", "sent": matched}
    emit, state["queue"] = queue[:limit], queue[limit:]
    try:
        write_state(payload["state"], state)
    except OSError as exc:
        return 1, {"collect_error": "cannot write state: {}".format(exc)}
    return 0, {"candidates": emit,
               "boards": {"fetched": fetched, "failed": failed, "unsupported": unsupported,
                          "no_ats": no_ats, "remaining": len(todo)},
               "queued": len(state["queue"])}


def http_fetch(url: str, body: Optional[Dict[str, Any]]) -> Any:
    """urllib with a 10 s timeout and at most one request per second per host;
    any HTTP error, non-JSON body, or OSError raises FetchError."""
    host = urllib.parse.urlsplit(url).netloc
    wait = LAST_REQUEST.get(host, 0.0) + MIN_INTERVAL - time.monotonic()
    if wait > 0:
        time.sleep(wait)
    LAST_REQUEST[host] = time.monotonic()
    if body is None:
        call = urllib.request.Request(url, headers={"Accept": "application/json"}, method="GET")
    else:
        call = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Accept": "application/json", "Content-Type": "application/json"},
            method="POST",
        )
    try:
        with urllib.request.urlopen(call, timeout=TIMEOUT) as response:
            return json.load(response)
    # HTTPError is an OSError: report just the status. HTTPException: a malformed
    # or truncated response, which urllib does not wrap. ValueError: bad JSON.
    except urllib.error.HTTPError as exc:
        raise FetchError("HTTP {}".format(exc.code))
    except (OSError, http.client.HTTPException, ValueError) as exc:
        raise FetchError("{}: {}".format(type(exc).__name__, exc))


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        json.dump({"collect_error": "invalid JSON: {}".format(exc)}, sys.stdout)
        sys.stdout.write("\n")
        return 1
    code, result = collect(payload, http_fetch, datetime.now(timezone.utc).isoformat(timespec="seconds"))
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main())

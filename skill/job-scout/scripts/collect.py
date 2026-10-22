#!/usr/bin/env python3
"""Every posting on every board of a `kind: board` route, filtered by title and date.

The board leg of `job-scout/references/flows/flow-search.md`. No caps: every
slug list is read, every slug GET, every item kept that passes title, listed and
date. Lists are http(s) URLs or absolute file paths (the flow resolves
Profile-root paths). A Lever EU host is skipped, never sent to api.lever.co.

stdin: {"route": {<pack route>}, "slugs": ["acme", ...], "lists": ["https://…", "D:/…/greenhouse.csv"],
        "positions": ["Senior Software Engineer", ...], "date_posted": "week", "now": "2026-10-22T12:00:00Z"}
stdout: {"candidates": [{"slug", "company", "title", "url", "date", "location", "matched_query"}, ...],
         "slugs": [{"slug", "status": "ok" | "failed", "error", "items", "kept"}, ...],
         "lists": [{"source", "status": "ok" | "failed", "slugs", "skipped"}, ...]}
         (`skipped`: list rows read but not turned into slugs, e.g. a Lever EU or other-ATS url)
or {"collect_error": "..."} with exit 1. A failed slug or list is reported, never a zero.
"""

import csv
import http.client
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, quote, unquote, urlsplit

WORKERS = 4  # concurrent GETs to the route host; pacing, not a coverage limit
ATTEMPTS = 5
MAX_WAIT = 120.0
TIMEOUT = 30
WINDOWS = {"24_hours": 1, "week": 7, "month": 31, "all_time": None, "": None}
EU_LEVER_HOSTS = ("jobs.eu.lever.co", "api.eu.lever.co")
DATE_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
MISSING = object()


def parse_when(value: object) -> Optional[datetime]:
    """ISO-8601 string or epoch seconds / milliseconds → aware UTC datetime; else None."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str) and re.fullmatch(r"\s*\d+(\.\d+)?\s*", value):
        value = float(value)
    if isinstance(value, (int, float)):
        seconds = value / 1000 if abs(value) >= 1e11 else value
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def resolve(node: object, path: str) -> object:
    """Dot path into parsed JSON; `$` is the root. MISSING when any segment is absent."""
    if path == "$":
        return node
    for part in path.split("."):
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
            node = node[int(part)]
        else:
            return MISSING
    return node


def words(text: str) -> List[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def contains_words(title: List[str], position: List[str]) -> bool:
    size = len(position)
    return size > 0 and any(title[i:i + size] == position for i in range(len(title) - size + 1))


def url_slug(raw: str, ats: str) -> Optional[str]:
    parts = urlsplit(raw.strip())
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or ats.lower() not in host or host in EU_LEVER_HOSTS:
        return None
    if ats.lower() == "greenhouse" and parts.path.startswith("/embed/"):
        found = parse_qs(parts.query).get("for", [""])[0]
        return found or None
    segment = unquote(parts.path.strip("/").split("/")[0])
    return segment or None


def list_slugs(text: str, ats: str) -> Tuple[List[Tuple[str, str]], int]:
    """((slug, name) per row, count of rows skipped): JSON array of strings; CSV `url` column (host must be this
    ATS family; Greenhouse /embed/ takes `for`); CSV `slug` column otherwise."""
    text = text.lstrip("\ufeff")
    if text.lstrip().startswith("["):
        data = json.loads(text)
        if not isinstance(data, list) or not all(isinstance(s, str) for s in data):
            raise ValueError("not a JSON array of strings")
        found = [(s.strip(), s.strip()) for s in data if s.strip()]
        return found, len(data) - len(found)
    reader = csv.DictReader(io.StringIO(text))
    fields = {(name or "").strip().lower(): name for name in (reader.fieldnames or [])}
    if "url" not in fields and "slug" not in fields:
        raise ValueError("no url or slug column")
    rows: List[Tuple[str, str]] = []
    skipped = 0
    for row in reader:
        def cell(key: str) -> str:
            return (row.get(fields[key]) or "").strip() if key in fields else ""
        slug = url_slug(cell("url"), ats) if "url" in fields else cell("slug")
        if slug:
            rows.append((slug, cell("name") or slug))
        else:
            skipped += 1
    return rows, skipped


def keep(item: dict, route: dict, positions: List[str], since: Optional[datetime]) -> Optional[dict]:
    title = resolve(item, route["title"])
    url = resolve(item, route["posting_url"])
    if not isinstance(title, str) or not isinstance(url, str) or not url:
        return None
    tokens = words(title)
    matched = next((p for p in positions if contains_words(tokens, words(p))), None)
    if matched is None:
        return None
    if route.get("listed"):
        listed = resolve(item, route["listed"])
        if listed is False or (isinstance(listed, str) and listed.strip().lower() == "false"):
            return None
    when = parse_when(resolve(item, route["date"])) if route.get("date") else None
    if when is not None and since is not None and when < since:
        return None
    place = resolve(item, route["location"]) if route.get("location") else MISSING
    return {
        "title": title,
        "url": url,
        "date": when.astimezone(timezone.utc).strftime(DATE_FORMAT) if when else "",
        "location": place if isinstance(place, str) else "",
        "matched_query": matched,
    }


def get(url: str, fetch: Callable[..., tuple], sleep: Callable[[float], None]) -> Tuple[int, str]:
    """GET with up to ATTEMPTS tries on 429/5xx, waiting Retry-After seconds when given.

    `fetch` returns (status, body) or (status, body, retry_after)."""
    status, body = 0, ""
    for attempt in range(ATTEMPTS):
        result = fetch(url)
        status, body = result[0], result[1]
        retry_after = result[2] if len(result) > 2 else None
        if not (status == 429 or status >= 500) or attempt == ATTEMPTS - 1:
            break
        try:
            wait = min(max(float(retry_after), 0.0), MAX_WAIT)
        except (TypeError, ValueError):
            wait = float(2 ** attempt)
        sleep(wait)
    return status, body


def read_list(source: str, ats: str, fetch: Callable[..., tuple],
              sleep: Callable[[float], None]) -> Tuple[List[Tuple[str, str]], int]:
    if re.match(r"^https?://", source, re.IGNORECASE):
        status, text = get(source, fetch, sleep)
        if status != 200:
            raise ValueError("HTTP {0}".format(status))
    else:
        with open(source, encoding="utf-8-sig") as handle:
            text = handle.read()
    return list_slugs(text, ats)


def scan_slug(slug: str, route: dict, positions: List[str], since: Optional[datetime],
              fetch: Callable[..., tuple], sleep: Callable[[float], None]) -> Tuple[Dict[str, object], List[dict]]:
    report: Dict[str, object] = {"slug": slug, "status": "failed", "error": "", "items": 0, "kept": 0}
    status, body = get(route["url"].replace("{slug}", quote(slug, safe="")), fetch, sleep)
    if status != 200:
        report["error"] = "HTTP {0}".format(status)
        return report, []
    try:
        data = json.loads(body)
    except ValueError:
        report["error"] = "non-JSON response"
        return report, []
    items = resolve(data, route["items"])
    if not isinstance(items, list):
        report["error"] = "items path {0!r} missing".format(route["items"])
        return report, []
    kept = [k for k in (keep(i, route, positions, since) for i in items if isinstance(i, dict)) if k]
    report.update(status="ok", items=len(items), kept=len(kept))
    return report, kept


def collect(payload: object, fetch: Callable[..., tuple],
            sleep: Callable[[float], None] = time.sleep) -> Tuple[int, Dict[str, object]]:
    def bad(message: str) -> Tuple[int, Dict[str, object]]:
        return 1, {"collect_error": message}

    if not isinstance(payload, dict):
        return bad("stdin must be an object")
    route = payload.get("route")
    if not isinstance(route, dict):
        return bad("route must be an object")
    for key in ("ats", "url", "items", "posting_url", "title"):
        if not isinstance(route.get(key), str) or not route[key]:
            return bad("route.{0} must be a non-empty string".format(key))
    if "{slug}" not in route["url"]:
        return bad("route.url must contain {slug}")
    for key in ("location", "date", "listed"):
        if route.get(key) is not None and not isinstance(route[key], str):
            return bad("route.{0} must be a string".format(key))
    positions = payload.get("positions")
    if not isinstance(positions, list) or not all(isinstance(p, str) for p in positions):
        return bad("positions must be an array of strings")
    slugs = payload.get("slugs", [])
    lists = payload.get("lists", [])
    for key, value in (("slugs", slugs), ("lists", lists)):
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            return bad("{0} must be an array of strings".format(key))
    window = payload.get("date_posted") or ""
    if isinstance(window, dict):  # legacy bool map: its one true key is the window
        window = next((k for k, v in window.items() if v is True), "")
    if not isinstance(window, str) or window not in WINDOWS:
        return bad("date_posted must be one of 24_hours, week, month, all_time or empty")
    now = parse_when(payload.get("now"))
    if now is None:
        return bad("now must be an ISO-8601 timestamp")
    days = WINDOWS[window]
    since = now - timedelta(days=days) if days else None

    ordered: Dict[str, Tuple[str, str]] = {}  # lowercased slug → (slug, name)
    for slug in slugs:
        if slug.strip():
            ordered.setdefault(slug.strip().lower(), (slug.strip(), slug.strip()))
    list_reports: List[Dict[str, object]] = []
    for source in lists:
        try:
            rows, skipped = read_list(source, route["ats"], fetch, sleep)
        except (OSError, ValueError, csv.Error) as error:
            list_reports.append({"source": source, "status": "failed", "error": str(error), "slugs": 0,
                                 "skipped": 0})
            continue
        list_reports.append({"source": source, "status": "ok", "slugs": len(rows), "skipped": skipped})
        for slug, name in rows:
            ordered.setdefault(slug.lower(), (slug, name))

    def work(entry: Tuple[str, str]) -> Tuple[Dict[str, object], List[dict]]:
        slug, name = entry
        report, kept = scan_slug(slug, route, positions, since, fetch, sleep)
        for candidate in kept:
            candidate.update(slug=slug, company=name)
        return report, kept

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(work, ordered.values()))
    candidates = [c for _, kept in results for c in kept]
    candidates.sort(key=lambda c: c["date"], reverse=True)  # undated ("") last; sort is stable
    shaped = [{k: c[k] for k in ("slug", "company", "title", "url", "date", "location", "matched_query")}
              for c in candidates]
    return 0, {"candidates": shaped, "slugs": [r for r, _ in results], "lists": list_reports}


def http_fetch(url: str) -> Tuple[int, str, Optional[str]]:
    request = urllib.request.Request(url, headers={"User-Agent": "job-kit-collect/1", "Accept": "application/json, text/csv, */*"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            return response.status, response.read().decode("utf-8", errors="replace"), None
    except urllib.error.HTTPError as error:
        return error.code, "", error.headers.get("Retry-After")
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as error:
        return 0, str(error), None


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        code, result = 1, {"collect_error": "invalid JSON: {0}".format(error)}
    else:
        code, result = collect(payload, http_fetch)
    text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()
    return code


if __name__ == "__main__":
    raise SystemExit(main())

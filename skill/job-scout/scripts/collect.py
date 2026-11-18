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

Boards branch (`boards` key present; ashby, greenhouse, lever): stdin swaps `slugs` for
"boards": [{"company_id", "name", "url", "enabled"?}, ...]. `lists` rows follow the pack rows unless
their tenant is already a pack row, enabled or disabled. Each candidate adds
"api_evidence": {"request_url", "board_url", "job": <raw item>}; each `slugs` report adds
"company_id", "name", "board_url", "http_status". A bad board root or a malformed job fails that board alone;
an untitled job is skipped.
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
ASHBY_API = "https://api.ashbyhq.com/posting-api/job-board/{slug}"
GREENHOUSE_API = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
# Per ATS the boards branch reads: accepted route urls, board-root hosts, the root a list slug expands to,
# the route paths the API fixes, and the host every posting link must stay on (None when the API may link
# to the employer's own careers site) with its optional apply-step segment.
BOARD_APIS: Dict[str, dict] = {
    "ashby": {
        "urls": (ASHBY_API, ASHBY_API + "?includeCompensation=true", ASHBY_API + "?includeCompensation=false"),
        "hosts": ("jobs.ashbyhq.com",),
        "root": "https://jobs.ashbyhq.com/{slug}",
        "required": (("items", "jobs"), ("posting_url", "jobUrl"), ("title", "title")),
        "optional": (("location", "location"), ("date", "publishedAt"), ("listed", "isListed")),
        "posting_host": "jobs.ashbyhq.com",
        "apply_step": "application",
    },
    "greenhouse": {
        "urls": (GREENHOUSE_API, GREENHOUSE_API + "?content=true"),
        "hosts": ("job-boards.greenhouse.io", "boards.greenhouse.io",
                  "job-boards.eu.greenhouse.io", "boards.eu.greenhouse.io"),
        "root": "https://job-boards.greenhouse.io/{slug}",
        "required": (("items", "jobs"), ("posting_url", "absolute_url"), ("title", "title")),
        "optional": (("location", "location.name"), ("date", "first_published")),
        "posting_host": None,
        "apply_step": None,
    },
    "lever": {
        "urls": ("https://api.lever.co/v0/postings/{slug}?mode=json",),
        "hosts": ("jobs.lever.co",),
        "root": "https://jobs.lever.co/{slug}",
        "required": (("items", "$"), ("posting_url", "hostedUrl"), ("title", "text")),
        "optional": (("location", "categories.location"), ("date", "createdAt")),
        "posting_host": "jobs.lever.co",
        "apply_step": None,
    },
}


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


def read_lists(lists: List[str], ats: str, fetch: Callable[..., tuple],
               sleep: Callable[[float], None]) -> Tuple[List[Tuple[str, str]], List[Dict[str, object]]]:
    """Every (slug, name) row of every list in order, and one report per list; a failed list is reported."""
    rows: List[Tuple[str, str]] = []
    reports: List[Dict[str, object]] = []
    for source in lists:
        try:
            found, skipped = read_list(source, ats, fetch, sleep)
        except (OSError, ValueError, csv.Error) as error:
            reports.append({"source": source, "status": "failed", "error": str(error), "slugs": 0, "skipped": 0})
            continue
        reports.append({"source": source, "status": "ok", "slugs": len(found), "skipped": skipped})
        rows.extend(found)
    return rows, reports


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


def board_tenant(board_url: object, hosts: Tuple[str, ...]) -> str:
    """Extract one safe tenant from a board root on one of the ATS's board hosts."""
    if not isinstance(board_url, str) or not board_url or board_url != board_url.strip():
        raise ValueError("board url must be a non-empty absolute URL")
    try:
        parts = urlsplit(board_url)
    except ValueError:
        raise ValueError("invalid board url")
    # The request is rebuilt from the tenant alone, so scheme, query and fragment are ignored.
    if parts.scheme.lower() not in ("http", "https") or parts.netloc.lower() not in hosts:
        raise ValueError("board url must be on http(s)://{0}".format(" or ".join(hosts)))
    match = re.fullmatch(r"/([^/]+)/?", parts.path)
    if not match:
        raise ValueError("board url must contain exactly one tenant path segment")
    tenant = unquote(match.group(1))
    if (tenant in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._~-]+", tenant)
            or "/" in tenant or "\\" in tenant):
        raise ValueError("board url has an unsafe tenant segment")
    return tenant


def safe_posting_url(raw: object, tenant: str, spec: dict) -> bool:
    """A posting link is an absolute URL; where the ATS hosts every posting it stays on the tenant's path."""
    if not isinstance(raw, str) or not raw or raw != raw.strip():
        return False
    try:
        parts = urlsplit(raw)
    except ValueError:
        return False
    if spec["posting_host"] is None:
        return parts.scheme.lower() in ("http", "https") and bool(parts.hostname)
    if (parts.scheme.lower() != "https" or parts.netloc.lower() != spec["posting_host"]
            or parts.query or parts.fragment or "?" in raw or "#" in raw):
        return False
    if not parts.path.startswith("/"):
        return False
    segments = parts.path[1:].split("/")
    if segments and segments[-1] == "":
        segments.pop()
    if len(segments) not in (2, 3):
        return False
    decoded = [unquote(segment) for segment in segments]
    if any(segment in (".", "..") or not re.fullmatch(r"[A-Za-z0-9._~-]+", segment)
           for segment in decoded):
        return False
    if len(decoded) == 3 and decoded[2].casefold() != spec["apply_step"]:
        return False
    return decoded[0].casefold() == tenant.casefold()


def board_api(route: dict) -> dict:
    """The BOARD_APIS entry for a route, once the route is that API's official shape."""
    spec = BOARD_APIS.get(route["ats"].lower())
    if spec is None:
        raise ValueError("boards require route.ats to be ashby, greenhouse, or lever")
    if route.get("kind") not in (None, "board"):
        raise ValueError("route.kind must be board")
    if route["url"] not in spec["urls"]:
        raise ValueError("route.url must be the official {0} API URL: {1}".format(
            route["ats"], " or ".join(spec["urls"])))
    for key, expected in spec["required"]:
        if route[key] != expected:
            raise ValueError("route.{0} must be {1!r}".format(key, expected))
    for key, expected in spec["optional"]:
        if route.get(key) is not None and route[key] != expected:
            raise ValueError("route.{0} must be {1!r} when configured".format(key, expected))
    return spec


def enabled_boards(boards: object, hosts: Tuple[str, ...]) -> Tuple[List[Tuple[str, str, str]], set]:
    """Validate every profile board before any request: the enabled rows as (company_id, name, url)
    in order, and the casefolded tenants of the disabled rows."""
    if not isinstance(boards, list):
        raise ValueError("boards must be an array")
    entries: List[Tuple[str, str, str]] = []
    disabled = set()
    for index, board in enumerate(boards):
        if not isinstance(board, dict):
            raise ValueError("boards[{0}] must be an object".format(index))
        if "enabled" in board and not isinstance(board["enabled"], bool):
            raise ValueError("boards[{0}].enabled must be a boolean".format(index))
        if not board.get("enabled", True):
            try:
                disabled.add(board_tenant(board.get("url"), hosts).casefold())
            except ValueError:
                pass  # a disabled row is never validated
            continue
        for key in ("company_id", "name", "url"):
            if not isinstance(board.get(key), str) or not board[key].strip():
                raise ValueError("boards[{0}].{1} must be a non-empty string".format(index, key))
        if "managed_by" in board and board["managed_by"] != "job-company-scout":
            raise ValueError("boards[{0}].managed_by must be 'job-company-scout'".format(index))
        entries.append((board["company_id"], board["name"].strip(), board["url"]))
    return entries, disabled


def prepare_boards(route: dict, spec: dict, entries: List[Tuple[str, str, str]], disabled: set,
                   listed: List[Tuple[str, str]]) -> List[dict]:
    """Boards to scan, in order: pack rows, then list rows whose tenant is new and not disabled."""
    prepared: List[dict] = []
    seen: set = set()

    def add(company_id: str, name: str, url: str) -> None:
        row = {"company_id": company_id, "name": name, "board_url": url, "slug": ""}
        try:
            tenant = board_tenant(url, spec["hosts"])
        except ValueError as error:
            # One bad board root fails only that board; route errors stay pack-wide.
            row["error"] = "invalid board url: {0}".format(error)
        else:
            if tenant.casefold() in seen:
                return
            seen.add(tenant.casefold())
            row.update(slug=tenant, request_url=route["url"].replace("{slug}", quote(tenant, safe="")))
        prepared.append(row)

    for company_id, name, url in entries:
        add(company_id, name, url)
    seen.update(disabled)
    for slug, name in listed:
        add("", name, spec["root"].replace("{slug}", quote(slug, safe="")))
    return prepared


def scan_board(board: dict, route: dict, spec: dict, positions: List[str], since: Optional[datetime],
               fetch: Callable[..., tuple], sleep: Callable[[float], None]) -> Tuple[Dict[str, object], List[dict]]:
    report: Dict[str, object] = {
        "company_id": board["company_id"], "name": board["name"], "slug": board["slug"],
        "board_url": board["board_url"], "status": "failed", "error": "", "items": 0,
        "kept": 0, "http_status": 0,
    }
    if board.get("error"):
        report["error"] = board["error"]
        return report, []
    status, body = get(board["request_url"], fetch, sleep)
    report["http_status"] = status
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
    report["items"] = len(items)

    # The API fixes these field names, so they apply even when the route omits the optional paths.
    paths = dict(route)
    for key, default in spec["optional"]:
        paths[key] = route.get(key) or default
    kept = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            report["error"] = "job {0} is not an object".format(index)
            return report, []
        title = resolve(item, route["title"])
        posting_url = resolve(item, route["posting_url"])
        if not isinstance(title, str) or not title.strip():
            continue  # an untitled job can match no position, so it never fails the board
        if not safe_posting_url(posting_url, board["slug"], spec):
            report["error"] = "job {0} has an unsafe posting URL".format(index)
            return report, []
        if paths.get("listed"):
            listed = resolve(item, paths["listed"])
            if listed is not MISSING and not isinstance(listed, bool):
                report["error"] = "job {0} has an invalid {1} value".format(index, paths["listed"])
                return report, []
        candidate = keep(item, paths, positions, since)
        if candidate is not None:
            candidate.update(slug=board["slug"], company=board["name"])
            candidate["api_evidence"] = {
                "request_url": board["request_url"], "board_url": board["board_url"], "job": item,
            }
            kept.append(candidate)
    report.update(status="ok", kept=len(kept))
    return report, kept


def collect_boards(payload: dict, route: dict, positions: List[str], since: Optional[datetime],
                   lists: List[str], fetch: Callable[..., tuple],
                   sleep: Callable[[float], None]) -> Tuple[int, Dict[str, object]]:
    if payload.get("slugs", []):
        return 1, {"collect_error": "boards cannot be combined with non-empty slugs"}
    try:
        spec = board_api(route)
        entries, disabled = enabled_boards(payload.get("boards"), spec["hosts"])
    except ValueError as error:
        return 1, {"collect_error": str(error)}
    listed, list_reports = read_lists(lists, route["ats"], fetch, sleep)
    boards = prepare_boards(route, spec, entries, disabled, listed)

    def work(board: dict):
        return scan_board(board, route, spec, positions, since, fetch, sleep)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        results = list(pool.map(work, boards))
    candidates = [candidate for _, kept in results for candidate in kept]
    candidates.sort(key=lambda candidate: candidate["date"], reverse=True)
    shaped = [{key: candidate[key] for key in
               ("slug", "company", "title", "url", "date", "location", "matched_query", "api_evidence")}
              for candidate in candidates]
    return 0, {"candidates": shaped, "slugs": [report for report, _ in results], "lists": list_reports}


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

    if "boards" in payload:
        return collect_boards(payload, route, positions, since, lists, fetch, sleep)

    ordered: Dict[str, Tuple[str, str]] = {}  # lowercased slug → (slug, name)
    for slug in slugs:
        if slug.strip():
            ordered.setdefault(slug.strip().lower(), (slug.strip(), slug.strip()))
    rows, list_reports = read_lists(lists, route["ats"], fetch, sleep)
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
    # ASCII escapes keep lone surrogates from raw API text encodable.
    text = json.dumps(result, indent=2, ensure_ascii=True) + "\n"
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()
    return code


if __name__ == "__main__":
    raise SystemExit(main())

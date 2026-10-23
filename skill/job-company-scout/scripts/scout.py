"""Durable queue and coordinator for Company Scout.

Workers receive plain task data and return structured findings.  Only this
module writes queue state; :mod:`deck` owns the YAML publication transaction.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_BATCH_SIZE = 50
MAX_WORKERS = 3
_DB_RELATIVE = Path("scout") / "runtime" / "company-scout" / "state.sqlite3"


def _root_path(profile_root: Any) -> Path:
    root = Path(profile_root)
    if not root.is_absolute():
        raise ValueError("profile_root must be absolute")
    return root


def _canonical_url(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("URL must be a non-empty absolute HTTP(S) URL")
    try:
        from deck import canonical_url  # lazy: status does not need the YAML adapter
    except (ImportError, AttributeError) as exc:
        raise ValueError("Company Scout deck adapter is unavailable") from exc
    result = canonical_url(value)
    if not isinstance(result, str) or not result:
        raise ValueError(f"Invalid URL: {value}")
    return result


def _load_document(profile_root: Path) -> Any:
    try:
        import deck
        document = deck.load_document(profile_root, discovery_defaults=True)
    except (ImportError, AttributeError) as exc:
        raise ValueError("Company Scout deck adapter is unavailable") from exc
    if not isinstance(document, dict):
        raise ValueError("search_packs.yaml must contain a mapping")
    return document


def _validate_markets(document: Any, markets: Any) -> list[str]:
    if not isinstance(markets, list) or not markets:
        raise ValueError("markets must be a non-empty list of configured market IDs")
    if any(not isinstance(market, str) or not market.strip() for market in markets):
        raise ValueError("markets must contain non-empty strings")
    discovery = document.get("discovery")
    configured = discovery.get("markets") if isinstance(discovery, dict) else None
    if not isinstance(configured, dict):
        raise ValueError("discovery.markets must be a mapping")
    if "all" in markets:
        if len(markets) != 1:
            raise ValueError("'all' must be selected alone")
        requested = [market for market, spec in configured.items()
                     if isinstance(spec, dict) and spec.get("enabled", True) is not False]
    else:
        requested = list(dict.fromkeys(markets))
    for market in requested:
        spec = configured.get(market)
        if not isinstance(spec, dict) or spec.get("enabled", True) is False:
            raise ValueError(f"Market is not configured and enabled: {market}")
    selected = set(requested)
    return [market for market in configured if market in selected]


def _source_entries(document: Any, markets: list[str]) -> list[dict[str, Any]]:
    discovery = document.get("discovery", {})
    market_map = discovery.get("markets", {})
    observations = discovery.get("observations", {})
    if not isinstance(observations, dict):
        observations = {}
    selected = set(markets)
    entries: list[dict[str, Any]] = []
    # Use the YAML's market and source order, not the caller's argument order.
    for market, market_spec in market_map.items():
        if market not in selected or not isinstance(market_spec, dict) or market_spec.get("enabled", True) is False:
            continue
        sources = market_spec.get("sources", {})
        if not isinstance(sources, dict):
            raise ValueError(f"discovery.markets.{market}.sources must be a mapping")
        for source_id, source_spec in sources.items():
            if not isinstance(source_spec, dict):
                raise ValueError(f"Invalid source specification: {market}/{source_id}")
            if source_spec.get("enabled", True) is False:
                continue
            raw_url = source_spec.get("url")
            if not isinstance(raw_url, str):
                raise ValueError(f"Source {market}/{source_id} must have a URL")
            source_url = _canonical_url(raw_url)
            observation = observations.get(source_url)
            if not isinstance(observation, dict):
                observation = next((v for k, v in observations.items()
                                    if isinstance(k, str) and _safe_canonical(k) == source_url and isinstance(v, dict)), {})
            pending = observation.get("pending_urls", []) if isinstance(observation, dict) else []
            if pending is None:
                pending = []
            if not isinstance(pending, list):
                raise ValueError(f"pending_urls for {source_url} must be a list")
            urls = []
            seen = set()
            for url in pending:
                canonical = _canonical_url(url)
                if canonical not in seen:
                    urls.append(canonical)
                    seen.add(canonical)
            entries.append({"market": market, "source_id": str(source_id), "source_url": source_url,
                            "pending_urls": urls, "observation": observation})
    return entries


def _safe_canonical(value: str) -> str | None:
    try:
        return _canonical_url(value)
    except (TypeError, ValueError):
        return None


def _db_path(root: Path) -> Path:
    return root / _DB_RELATIVE


def _connect(root: Path, *, create: bool = False, readonly: bool = False) -> sqlite3.Connection | None:
    path = _db_path(root)
    if readonly:
        if not path.is_file():
            return None
        # Not `mode=ro`: SQLite must be able to roll back a hot journal left by a
        # killed writer, and `query_only` still blocks every write from here.
        connection = sqlite3.connect(str(path), timeout=15)
        connection.execute("PRAGMA query_only=ON")
    else:
        if create:
            path.parent.mkdir(parents=True, exist_ok=True)
        if not path.is_file() and not create:
            return None
        connection = sqlite3.connect(str(path), timeout=30, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    if not readonly:
        connection.execute("PRAGMA busy_timeout=30000")
    return connection


def _initialize(connection: sqlite3.Connection) -> None:
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS coverage (
            url TEXT NOT NULL,
            market TEXT NOT NULL,
            source_url TEXT NOT NULL,
            pending INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 0,
            first_seen_order INTEGER NOT NULL,
            PRIMARY KEY (url, market, source_url)
        );
        CREATE TABLE IF NOT EXISTS cycles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            cycle_key TEXT NOT NULL,
            scope_json TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'open',
            created_order INTEGER NOT NULL,
            UNIQUE(kind, cycle_key, created_order)
        );
        CREATE INDEX IF NOT EXISTS cycles_active ON cycles(kind, cycle_key, state, id);
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            url TEXT NOT NULL,
            markets_json TEXT NOT NULL,
            origins_json TEXT NOT NULL,
            cycle_id INTEGER,
            state TEXT NOT NULL DEFAULT 'pending',
            created_order INTEGER NOT NULL,
            active_run_id TEXT,
            error TEXT,
            FOREIGN KEY(cycle_id) REFERENCES cycles(id)
        );
        CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(kind, state, created_order);
        CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS run_tasks (
            run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            PRIMARY KEY(run_id, task_id),
            FOREIGN KEY(run_id) REFERENCES runs(id),
            FOREIGN KEY(task_id) REFERENCES tasks(id)
        );
        CREATE TABLE IF NOT EXISTS results (
            run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            delivery_state TEXT NOT NULL DEFAULT 'awaiting_publication',
            created_order INTEGER NOT NULL,
            published_at TEXT,
            PRIMARY KEY(run_id, task_id),
            FOREIGN KEY(run_id, task_id) REFERENCES run_tasks(run_id, task_id)
        );
    """)
    connection.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','1')")


def _next_order(connection: sqlite3.Connection) -> int:
    row = connection.execute("SELECT value FROM meta WHERE key='next_order'").fetchone()
    value = int(row[0]) if row else 1
    connection.execute("INSERT INTO meta(key,value) VALUES('next_order',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (str(value + 1),))
    return value


def _task_id(kind: str, url: str, markets: list[str], origins: list[dict[str, str]], cycle_id: int | None = None) -> str:
    material = json.dumps([kind, url, sorted(markets), origins, cycle_id], ensure_ascii=False, separators=(",", ":"))
    return "scout-" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:24]


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _seed_coverage(connection: sqlite3.Connection, entries: list[dict[str, Any]]) -> None:
    connection.execute("UPDATE coverage SET active=0")
    for entry in entries:
        for url in entry["pending_urls"]:
            row = connection.execute("SELECT first_seen_order FROM coverage WHERE url=? AND market=? AND source_url=?",
                                     (url, entry["market"], entry["source_url"])).fetchone()
            order = row[0] if row else _next_order(connection)
            connection.execute("""
                INSERT INTO coverage(url,market,source_url,pending,active,first_seen_order)
                VALUES(?,?,?,1,1,?)
                ON CONFLICT(url,market,source_url) DO UPDATE SET pending=1,active=1
            """, (url, entry["market"], entry["source_url"], order))


def _candidate_items(connection: sqlite3.Connection, entries: list[dict[str, Any]], markets: list[str]) -> list[dict[str, Any]]:
    order_by_source = {}
    for index, entry in enumerate(entries):
        order_by_source.setdefault((entry["market"], entry["source_url"]), index)
    rows = connection.execute("SELECT url,market,source_url,first_seen_order FROM coverage WHERE active=1 AND pending=1 ORDER BY first_seen_order").fetchall()
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        data = grouped.setdefault(row["url"], {"kind": "item", "url": row["url"], "origins": [], "_source_indexes": []})
        origin = {"market": row["market"], "source_url": row["source_url"]}
        data["origins"].append(origin)
        data["_source_indexes"].append(order_by_source.get((row["market"], row["source_url"]), 10**9))
    candidates = []
    for data in grouped.values():
        data["origins"] = sorted(data["origins"], key=lambda o: (order_by_source.get((o["market"], o["source_url"]), 10**9), o["market"], o["source_url"]))
        data["markets"] = sorted({origin["market"] for origin in data["origins"]}, key=lambda m: markets.index(m))
        data["_source_index"] = min(data.pop("_source_indexes"), default=10**9)
        data["_signature"] = _task_id("item", data["url"], data["markets"], data["origins"])
        row = connection.execute("SELECT id,state,created_order FROM tasks WHERE id=?", (data["_signature"],)).fetchone()
        data["_existing_state"] = row["state"] if row else None
        data["_created_order"] = row["created_order"] if row else 10**9
        data["_task_id"] = data["_signature"]
        candidates.append(data)
    return candidates


def _fair_order(candidates: list[dict[str, Any]], entries: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    if limit <= 0 or not candidates:
        return []
    source_keys = []
    for entry in entries:
        key = (entry["market"], entry["source_url"])
        if key not in source_keys and any(key == (origin["market"], origin["source_url"])
                                          for candidate in candidates for origin in candidate["origins"]):
            source_keys.append(key)
    queues: dict[tuple[str, str], list[dict[str, Any]]] = {key: [] for key in source_keys}
    for candidate in candidates:
        for origin in candidate["origins"]:
            key = (origin["market"], origin["source_url"])
            if key in queues and candidate not in queues[key]:
                queues[key].append(candidate)
    for queue in queues.values():
        queue.sort(key=lambda c: (c["_created_order"], c["url"]))
    active = [key for key in source_keys if queues[key]]
    if not active:
        return []
    selected: list[dict[str, Any]] = []
    selected_ids = set()
    indexes = {key: 0 for key in active}
    while len(selected) < limit:
        made_progress = False
        for key in active:
            queue = queues[key]
            while indexes[key] < len(queue) and queue[indexes[key]]["_task_id"] in selected_ids:
                indexes[key] += 1
            if indexes[key] >= len(queue):
                continue
            candidate = queue[indexes[key]]
            indexes[key] += 1
            made_progress = True
            if candidate["_task_id"] in selected_ids:
                continue
            selected.append(candidate)
            selected_ids.add(candidate["_task_id"])
            if len(selected) >= limit:
                return selected
        if not made_progress:
            break
    return selected


def _ensure_task(connection: sqlite3.Connection, task: dict[str, Any], cycle_id: int | None = None) -> dict[str, Any]:
    task_id = task.get("_task_id") or _task_id(task["kind"], task["url"], task["markets"], task["origins"], cycle_id)
    if task.get("_task_id") and cycle_id is not None:
        task_id = _task_id(task["kind"], task["url"], task["markets"], task["origins"], cycle_id)
    row = connection.execute("SELECT state,created_order FROM tasks WHERE id=?", (task_id,)).fetchone()
    if row is None:
        order = _next_order(connection)
        connection.execute("INSERT INTO tasks(id,kind,url,markets_json,origins_json,cycle_id,state,created_order) VALUES(?,?,?,?,?,?, 'pending',?)",
                           (task_id, task["kind"], task["url"], _json(task["markets"]), _json(task["origins"]), cycle_id, order))
        state = "pending"
        created_order = order
    else:
        state = row["state"]
        created_order = row["created_order"]
        if state == "published":
            return {**task, "_task_id": task_id, "_existing_state": state, "_created_order": created_order}
    return {**task, "_task_id": task_id, "_existing_state": state, "_created_order": created_order, "_cycle_id": cycle_id}


def _cycle(connection: sqlite3.Connection, kind: str, cycle_key: str, scope: list[str]) -> tuple[int, bool]:
    row = connection.execute("SELECT id FROM cycles WHERE kind=? AND cycle_key=? AND state='open' ORDER BY id DESC LIMIT 1",
                             (kind, cycle_key)).fetchone()
    if row:
        return int(row[0]), False
    order = _next_order(connection)
    cursor = connection.execute("INSERT INTO cycles(kind,cycle_key,scope_json,state,created_order) VALUES(?,?,?,'open',?)",
                                (kind, cycle_key, _json(scope), order))
    return int(cursor.lastrowid), True


def _has_open_refresh_work(connection: sqlite3.Connection, entries: list[dict[str, Any]], markets: list[str]) -> bool:
    source_groups = []
    for entry in entries:
        group = (entry["source_url"], tuple(sorted(e["market"] for e in entries if e["source_url"] == entry["source_url"])))
        if group not in source_groups:
            source_groups.append(group)
    # An open cycle whose only outstanding tasks already failed must not hold back
    # other refresh work; those failures are retried after the fresh work.
    unattempted = ("SELECT 1 FROM cycles c JOIN tasks t ON t.cycle_id=c.id WHERE c.kind=? AND c.cycle_key=? "
                   "AND c.state='open' AND t.state IN ('pending','awaiting_publication') LIMIT 1")
    for source_url, market_tuple in source_groups:
        key = source_url + "|" + _json(list(market_tuple))
        if connection.execute(unattempted, ("source", key)).fetchone():
            return True
    company_key = _json(sorted(markets))
    return bool(connection.execute(unattempted, ("company", company_key)).fetchone())


def _source_work(connection: sqlite3.Connection, entries: list[dict[str, Any]], seed_new: bool) -> list[dict[str, Any]]:
    groups: list[dict[str, Any]] = []
    for entry in entries:
        group = next((g for g in groups if g["source_url"] == entry["source_url"]), None)
        if group is None:
            group = {"source_url": entry["source_url"], "markets": [], "origins": []}
            groups.append(group)
        if entry["market"] not in group["markets"]:
            group["markets"].append(entry["market"])
            group["origins"].append({"market": entry["market"], "source_url": entry["source_url"]})
    work = []
    for group in groups:
        key = group["source_url"] + "|" + _json(sorted(group["markets"]))
        active_cycle = connection.execute("SELECT id FROM cycles WHERE kind='source' AND cycle_key=? AND state='open' ORDER BY id DESC LIMIT 1",
                                          (key,)).fetchone()
        if active_cycle:
            cycle_id, created = int(active_cycle[0]), False
        elif seed_new:
            cycle_id, created = _cycle(connection, "source", key, group["markets"])
        else:
            continue
        if created:
            root_task = {"kind": "source", "url": group["source_url"], "markets": group["markets"], "origins": group["origins"]}
            work.append(_ensure_task(connection, root_task, cycle_id))
        rows = connection.execute("SELECT * FROM tasks WHERE cycle_id=? AND kind='source' AND state IN ('pending','failed') ORDER BY created_order",
                                  (cycle_id,)).fetchall()
        for row in rows:
            task = {"kind": row["kind"], "url": row["url"], "markets": json.loads(row["markets_json"]),
                    "origins": json.loads(row["origins_json"]), "_task_id": row["id"],
                    "_existing_state": row["state"], "_created_order": row["created_order"], "_cycle_id": cycle_id}
            if task not in work:
                work.append(task)
    return work


def _checked_key(value: Any) -> float:
    # YAML loads unquoted ISO values as datetimes and quoted ones as strings.
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str) and value.strip():
        try:
            parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return 0.0
    else:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _company_work(connection: sqlite3.Connection, document: Any, markets: list[str], seed_new: bool) -> list[dict[str, Any]]:
    discovery = document.get("discovery", {})
    companies = discovery.get("companies", {}) if isinstance(discovery, dict) else {}
    if not isinstance(companies, dict):
        return []
    cycle_key = _json(sorted(markets))
    active_cycle = connection.execute("SELECT id FROM cycles WHERE kind='company' AND cycle_key=? AND state='open' ORDER BY id DESC LIMIT 1",
                                      (cycle_key,)).fetchone()
    if active_cycle:
        cycle_id, created = int(active_cycle[0]), False
    elif seed_new:
        cycle_id, created = _cycle(connection, "company", cycle_key, markets)
    else:
        return []
    candidates = []
    for company_id, company in companies.items():
        if not isinstance(company, dict):
            continue
        membership = company.get("markets", {})
        if not isinstance(membership, dict):
            continue
        qualifying = [m for m in markets if isinstance(membership.get(m), dict)
                      and membership[m].get("status") in ("qualified", "pending")]
        if not qualifying:
            continue
        website = company.get("website")
        if not isinstance(website, str):
            continue
        url = _canonical_url(website)
        task = {"kind": "company", "url": url, "markets": qualifying, "origins": [], "company_id": str(company_id),
                "_cycle_id": cycle_id}
        task["_task_id"] = _task_id("company", url, qualifying, [], cycle_id)
        row = connection.execute("SELECT state,created_order FROM tasks WHERE id=?", (task["_task_id"],)).fetchone()
        task["_existing_state"] = row["state"] if row else None
        task["_created_order"] = row["created_order"] if row else 10**9
        task["_last_checked_at"] = _checked_key(company.get("last_checked_at"))
        candidates.append(task)
    candidates.sort(key=lambda c: (c["_last_checked_at"], c["company_id"], c["url"]))
    if created:
        for task in candidates:
            _ensure_task(connection, task, cycle_id)
    else:
        # New companies or newly qualifying markets remain visible during an open cycle.
        for task in candidates:
            _ensure_task(connection, task, cycle_id)
    rows = connection.execute("SELECT * FROM tasks WHERE cycle_id=? AND kind='company' AND state IN ('pending','failed') ORDER BY created_order",
                              (cycle_id,)).fetchall()
    by_id = {row["id"]: row for row in rows}
    result = []
    for task in candidates:
        row = by_id.get(task["_task_id"])
        if row:
            task["_existing_state"] = row["state"]
            task["_created_order"] = row["created_order"]
            result.append(task)
    # Work for companies no longer qualifying in the selected markets remains
    # stored in SQLite, but it must not be selected from this cycle.
    if not result:
        connection.execute("UPDATE cycles SET state=? WHERE id=?",
                           ("inactive" if rows else "completed", cycle_id))
    return result


def _task_public(task: dict[str, Any]) -> dict[str, Any]:
    return {key: task[key] for key in ("id", "kind", "url", "markets", "origins") if key in task}


def _awaiting_overlap(connection: sqlite3.Connection, task: dict[str, Any]) -> bool:
    rows = connection.execute("SELECT markets_json,origins_json FROM tasks WHERE kind=? AND url=? AND state='awaiting_publication'",
                              (task["kind"], task["url"])).fetchall()
    task_markets = set(task.get("markets", []))
    task_origins = {(o.get("market"), o.get("source_url")) for o in task.get("origins", [])}
    for row in rows:
        if task["kind"] == "company":
            if task_markets.intersection(json.loads(row["markets_json"])):
                return True
        else:
            other_origins = {(o.get("market"), o.get("source_url")) for o in json.loads(row["origins_json"])}
            if task_origins.intersection(other_origins):
                return True
    return False


def _assignments(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    slots = [[] for _ in range(MAX_WORKERS)]
    for index, task in enumerate(tasks):
        slots[index % MAX_WORKERS].append(task["id"])
    return [{"worker_id": f"worker-{index + 1}", "task_ids": ids} for index, ids in enumerate(slots)]


def inspect(profile_root: Any, markets: Any) -> dict[str, Any]:
    """Read selected source configuration and pending counts without creating state."""
    root = _root_path(profile_root)
    document = _load_document(root)
    selected = _validate_markets(document, markets)
    entries = _source_entries(document, selected)
    sources = [{"market": entry["market"], "source_url": entry["source_url"],
                "pending": len(entry["pending_urls"])} for entry in entries]
    return {"profile_root": str(root), "markets": selected, "sources": sources,
            "pending": len({url for entry in entries for url in entry["pending_urls"]})}


def start(profile_root: Any, markets: Any, batch_size: int = DEFAULT_BATCH_SIZE, refresh: bool = False) -> dict[str, Any]:
    """Create one bounded run, resuming durable work before adding new work."""
    root = _root_path(profile_root)
    if isinstance(batch_size, bool) or not isinstance(batch_size, int) or batch_size <= 0:
        raise ValueError("batch_size must be a positive integer")
    if not isinstance(refresh, bool):
        raise ValueError("refresh must be a boolean")
    document = _load_document(root)
    selected = _validate_markets(document, markets)
    entries = _source_entries(document, selected)
    connection = _connect(root, create=True)
    assert connection is not None
    try:
        _initialize(connection)
        # A saved checkpoint is always replayed before this invocation selects more work.
        publication = _publish_pending_connection(root, connection, selected, entries)
        if publication["errors"]:
            run_id = uuid.uuid4().hex
            return {"run_id": run_id, "tasks": [], "assignments": _assignments([]), "publication": publication}
        document = _load_document(root)
        selected = _validate_markets(document, markets)
        entries = _source_entries(document, selected)
        connection.execute("BEGIN IMMEDIATE")
        try:
            _seed_coverage(connection, entries)
            candidates = _candidate_items(connection, entries, selected)
            candidates = [candidate for candidate in candidates if not _awaiting_overlap(connection, candidate)]
            pending_resumes = sorted((c for c in candidates if c["_existing_state"] == "pending"),
                                     key=lambda c: (c["_created_order"], c["url"]))
            failed = sorted((c for c in candidates if c["_existing_state"] == "failed"),
                            key=lambda c: (c["_created_order"], c["url"]))
            fresh = [c for c in candidates if c["_existing_state"] is None]
            fair_fresh = _fair_order(fresh, entries, max(0, batch_size - len(pending_resumes)))
            item_order = pending_resumes + fair_fresh + failed

            # A quiet backlog, or explicit refresh, opens/resumes source and company cycles.
            has_backlog = bool(pending_resumes or fresh or failed)
            seed_refresh_work = refresh or (not has_backlog and
                                            not _has_open_refresh_work(connection, entries, selected))
            source_work = _source_work(connection, entries, seed_refresh_work)
            company_work = _company_work(connection, document, selected, seed_refresh_work)
            source_work = [task for task in source_work if not _awaiting_overlap(connection, task)]
            company_work = [task for task in company_work if not _awaiting_overlap(connection, task)]
            source_resumes = sorted((t for t in source_work if t.get("_existing_state") == "pending"),
                                    key=lambda t: (t.get("_created_order", 0), t["url"]))
            source_failed = sorted((t for t in source_work if t.get("_existing_state") == "failed"),
                                   key=lambda t: (t.get("_created_order", 0), t["url"]))
            source_new = [t for t in source_work if t.get("_existing_state") is None]
            company_resumes = sorted((t for t in company_work if t.get("_existing_state") == "pending"),
                                     key=lambda t: (t.get("_created_order", 0), t.get("_last_checked_at", 0.0), t["url"]))
            company_failed = sorted((t for t in company_work if t.get("_existing_state") == "failed"),
                                    key=lambda t: (t.get("_created_order", 0), t["url"]))
            company_new = sorted((t for t in company_work if t.get("_existing_state") is None),
                                 key=lambda t: (t.get("_last_checked_at", 0.0), t.get("company_id", "")))
            attempts = {row["task_id"]: row["last_attempt"] for row in connection.execute(
                "SELECT task_id,MAX(created_order) AS last_attempt FROM results GROUP BY task_id")}
            retries = sorted(failed + source_failed + company_failed,
                             key=lambda task: (attempts.get(task["_task_id"], 0), task["_created_order"]))

            if refresh:
                ordered = source_resumes + source_new + pending_resumes + fair_fresh + company_resumes + company_new + retries
            else:
                ordered = (pending_resumes + source_resumes + company_resumes + fair_fresh +
                           source_new + company_new + retries)
            # De-duplicate candidates and stop at the single-run bound.
            chosen = []
            seen_ids = set()
            for task in ordered:
                if task.get("_task_id") in seen_ids or task.get("_existing_state") == "published":
                    continue
                if task["kind"] == "item":
                    saved = _ensure_task(connection, task)
                else:
                    saved = _ensure_task(connection, task, task.get("_cycle_id"))
                if saved["_existing_state"] == "published":
                    continue
                task_id = saved["_task_id"]
                seen_ids.add(task_id)
                public = {"id": task_id, "kind": saved["kind"], "url": saved["url"],
                          "markets": saved["markets"], "origins": saved["origins"]}
                for optional in ("company_id", "cycle_id"):
                    if optional in saved:
                        public[optional] = saved[optional]
                chosen.append((saved, public))
                if len(chosen) >= batch_size:
                    break
            run_id = uuid.uuid4().hex
            connection.execute("INSERT INTO runs(id,created_at) VALUES(?,?)",
                               (run_id, datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")))
            for position, (saved, public) in enumerate(chosen):
                connection.execute("INSERT INTO run_tasks(run_id,task_id,position) VALUES(?,?,?)", (run_id, public["id"], position))
                connection.execute("UPDATE tasks SET active_run_id=? WHERE id=?", (run_id, public["id"]))
            try:
                import deck
                context = deck.read_context(root, selected,
                    [task.get("company_id") for _, task in chosen if task.get("company_id")])
            except (ImportError, AttributeError) as exc:
                raise ValueError("Company Scout deck context adapter is unavailable") from exc
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        tasks = [public for _, public in chosen]
        return {"run_id": run_id, "tasks": tasks, "assignments": _assignments(tasks),
                "context": context, "publication": publication}
    finally:
        connection.close()


def _validate_result(task: sqlite3.Row, result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise ValueError("result must be a mapping")
    outcome = result.get("outcome")
    if outcome not in ("complete", "retry", "failed"):
        raise ValueError("outcome must be complete, retry, or failed")
    checked_at = result.get("checked_at")
    if not isinstance(checked_at, str) or not checked_at.strip():
        raise ValueError("checked_at must be an ISO timestamp")
    try:
        datetime.fromisoformat(checked_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("checked_at must be an ISO timestamp") from exc
    normalized = {key: value for key, value in result.items()
                  if key in {"outcome", "checked_at", "error", "companies", "boards", "page"}}
    if task["kind"] == "source":
        page = result.get("page")
        if page is None and outcome != "complete":
            # A failed read has no page; it never counts toward crawl completion.
            page = {"links": [], "next_pages": [], "complete": False}
        if not isinstance(page, dict) or not isinstance(page.get("links", []), list) or not isinstance(page.get("next_pages", []), list) or not isinstance(page.get("complete"), bool):
            raise ValueError("source results require page.links, page.next_pages, and page.complete")
        normalized["page"] = {"links": [_canonical_url(v) for v in page.get("links", [])],
                              "next_pages": [_canonical_url(v) for v in page.get("next_pages", [])],
                              "complete": page["complete"]}
    else:
        companies = result.get("companies", {})
        boards = result.get("boards", [])
        if not isinstance(companies, dict) or not isinstance(boards, list):
            raise ValueError("companies must be a mapping and boards must be a list")
        normalized["companies"] = companies
        normalized["boards"] = boards
    if outcome != "complete" and not isinstance(result.get("error", ""), str):
        raise ValueError("error must be a string when outcome is retry or failed")
    return normalized


def record(profile_root: Any, run_id: str, task_id: str, result: Any) -> dict[str, Any]:
    """Save one worker result checkpoint; YAML publication is a later operation."""
    root = _root_path(profile_root)
    if not isinstance(run_id, str) or not run_id or not isinstance(task_id, str) or not task_id:
        raise ValueError("run_id and task_id must be non-empty strings")
    # Validate timestamp and payload shape before opening a write transaction.
    connection = _connect(root)
    if connection is None:
        raise ValueError("No Company Scout run exists for this profile")
    try:
        row = connection.execute("SELECT t.* FROM tasks t JOIN run_tasks rt ON rt.task_id=t.id WHERE rt.run_id=? AND rt.task_id=?",
                                 (run_id, task_id)).fetchone()
        if row is None:
            raise ValueError("task_id is not part of the supplied run_id")
        normalized = _validate_result(row, result)
        payload_json = _json(normalized)
        document = _load_document(root)
        markets = json.loads(row["markets_json"])
        origins = json.loads(row["origins_json"])
        enriched = dict(normalized)
        enriched.update({"kind": row["kind"], "url": row["url"], "markets": markets, "origins": origins})
        if row["kind"] == "source":
            enriched["pagination_complete"] = _prospective_source_complete(connection, row, enriched)
        try:
            import deck
            deck.merge_result(document, enriched)
        except (ImportError, AttributeError) as exc:
            raise ValueError("Company Scout deck validation adapter is unavailable") from exc
        source_discovery = document.get("discovery", {})
        prior = connection.execute("SELECT payload_json,delivery_state FROM results WHERE run_id=? AND task_id=?",
                                   (run_id, task_id)).fetchone()
        if prior:
            if prior["payload_json"] == payload_json:
                return {"recorded": False, "idempotent": True, "task_id": task_id}
            raise ValueError("conflicting result already recorded for this run task")
        if row["active_run_id"] != run_id:
            raise ValueError("task belongs to an older run and is no longer active")
        if row["state"] == "published":
            raise ValueError("task has already been published")
        # A result awaiting publication cannot be replaced by a second delivery.
        pending = connection.execute("SELECT payload_json FROM results WHERE task_id=? AND delivery_state='awaiting_publication' LIMIT 1",
                                     (task_id,)).fetchone()
        if pending and pending["payload_json"] != payload_json:
            raise ValueError("a conflicting result is already awaiting publication")
        connection.execute("BEGIN IMMEDIATE")
        try:
            order = _next_order(connection)
            connection.execute("INSERT INTO results(run_id,task_id,payload_json,delivery_state,created_order) VALUES(?,?,?,'awaiting_publication',?)",
                               (run_id, task_id, payload_json, order))
            connection.execute("UPDATE tasks SET state='awaiting_publication',error=NULL WHERE id=?", (task_id,))
            if row["kind"] == "source" and normalized["outcome"] == "complete":
                for link in normalized["page"]["links"]:
                    for origin in origins:
                        observations = source_discovery.get("observations", {}) if isinstance(source_discovery, dict) else {}
                        observation = observations.get(origin["source_url"], {}) if isinstance(observations, dict) else {}
                        if not isinstance(observation, dict) and isinstance(observations, dict):
                            observation = next((value for key, value in observations.items()
                                                if isinstance(key, str) and _safe_canonical(key) == origin["source_url"]
                                                and isinstance(value, dict)), {})
                        pending_urls = {_safe_canonical(value) for value in observation.get("pending_urls", [])} if isinstance(observation, dict) else set()
                        seen_urls = {_safe_canonical(value) for value in observation.get("seen_urls", [])} if isinstance(observation, dict) else set()
                        if link in seen_urls and link not in pending_urls:
                            continue
                        existing = connection.execute("SELECT first_seen_order FROM coverage WHERE url=? AND market=? AND source_url=?",
                                                      (link, origin["market"], origin["source_url"])).fetchone()
                        first_order = existing[0] if existing else _next_order(connection)
                        connection.execute("""
                            INSERT INTO coverage(url,market,source_url,pending,active,first_seen_order)
                            VALUES(?,?,?,1,0,?) ON CONFLICT(url,market,source_url) DO NOTHING
                        """, (link, origin["market"], origin["source_url"], first_order))
                cycle_id = row["cycle_id"]
                if cycle_id is not None:
                    for next_page in normalized["page"]["next_pages"]:
                        child = {"kind": "source", "url": next_page, "markets": markets, "origins": origins}
                        child_id = _task_id("source", next_page, markets, origins, cycle_id)
                        duplicate = connection.execute("SELECT state FROM tasks WHERE id=?", (child_id,)).fetchone()
                        if duplicate is None:
                            _ensure_task(connection, child, cycle_id)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        return {"recorded": True, "idempotent": False, "task_id": task_id}
    finally:
        connection.close()


def _task_metadata(connection: sqlite3.Connection, result_row: sqlite3.Row) -> sqlite3.Row:
    return connection.execute("SELECT * FROM tasks WHERE id=?", (result_row["task_id"],)).fetchone()


def _source_cycle_complete(connection: sqlite3.Connection, cycle_id: int | None,
                           prospective: dict[str, dict[str, Any]] | None = None) -> bool:
    if cycle_id is None:
        return False
    prospective = prospective or {}
    rows = connection.execute("SELECT * FROM tasks WHERE cycle_id=? AND kind='source' ORDER BY created_order", (cycle_id,)).fetchall()
    if not rows:
        return False
    tasks_by_id = {row["id"]: row for row in rows}
    has_terminal = False
    for task in rows:
        if task["id"] in prospective:
            payload = prospective[task["id"]]
            state = "published"
        else:
            state = task["state"]
            latest = connection.execute("SELECT payload_json FROM results WHERE task_id=? ORDER BY created_order DESC LIMIT 1",
                                        (task["id"],)).fetchone()
            payload = json.loads(latest[0]) if latest else None
        if state != "published" or not payload or payload.get("outcome") != "complete":
            return False
        page = payload.get("page", {})
        if not isinstance(page, dict):
            return False
        children = page.get("next_pages", [])
        for child_url in children:
            child_id = _task_id("source", child_url, json.loads(task["markets_json"]),
                                json.loads(task["origins_json"]), cycle_id)
            if child_id not in tasks_by_id:
                return False
        # A pagination bar may link back to earlier pages; only the page's own
        # completion claim decides whether the crawl reached its end.
        if page.get("complete") is True:
            has_terminal = True
        elif not children:
            return False
    return has_terminal


def _prospective_source_complete(connection: sqlite3.Connection, current_task: sqlite3.Row,
                                 current_result: dict[str, Any]) -> bool:
    if current_result.get("outcome") != "complete":
        return False
    return _source_cycle_complete(connection, current_task["cycle_id"], {current_task["id"]: current_result})


def _publish_pending_connection(root: Path, connection: sqlite3.Connection, markets: list[str],
                                entries: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        import deck
    except ImportError as exc:
        return {"published": 0, "errors": [{"error": f"Cannot import deck publisher: {exc}"}]}
    rows = connection.execute("SELECT * FROM results WHERE delivery_state='awaiting_publication' ORDER BY created_order").fetchall()
    published = 0
    errors = []
    summaries = []
    selected_markets = set(markets)
    active_sources = {(entry["market"], entry["source_url"]) for entry in entries}
    for result_row in rows:
        task = _task_metadata(connection, result_row)
        if task is None:
            errors.append({"task_id": result_row["task_id"], "error": "saved task metadata is missing"})
            break
        task_markets = set(json.loads(task["markets_json"]))
        task_origins = json.loads(task["origins_json"])
        if not task_markets.issubset(selected_markets):
            continue
        if task["kind"] in ("item", "source") and any(
                origin.get("market") not in selected_markets or
                (origin.get("market"), origin.get("source_url")) not in active_sources
                for origin in task_origins):
            continue
        result = json.loads(result_row["payload_json"])
        result.update({"kind": task["kind"], "url": task["url"],
                       "markets": list(json.loads(task["markets_json"])), "origins": task_origins})
        if task["kind"] == "source":
            result["pagination_complete"] = _prospective_source_complete(connection, task, result)
        try:
            summary = deck.publish_result(root, result)
        except Exception as exc:
            errors.append({"task_id": task["id"], "error": str(exc)})
            break
        connection.execute("BEGIN IMMEDIATE")
        try:
            connection.execute("UPDATE results SET delivery_state='published',published_at=? WHERE run_id=? AND task_id=?",
                               (datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"), result_row["run_id"], task["id"]))
            outcome = result.get("outcome")
            new_state = "published" if outcome == "complete" else "failed"
            connection.execute("UPDATE tasks SET state=?,error=? WHERE id=?",
                               (new_state, result.get("error") if new_state == "failed" else None, task["id"]))
            if outcome == "complete" and task["kind"] == "item":
                for origin in result["origins"]:
                    connection.execute("UPDATE coverage SET pending=0 WHERE url=? AND market=? AND source_url=?",
                                       (task["url"], origin["market"], origin["source_url"]))
            if task["kind"] == "source" and task["cycle_id"] is not None:
                cycle_id = task["cycle_id"]
                states = connection.execute("SELECT state FROM tasks WHERE cycle_id=? AND kind='source'", (cycle_id,)).fetchall()
                has_outstanding = any(row[0] in ("pending", "awaiting_publication", "failed") for row in states)
                all_complete = _source_cycle_complete(connection, cycle_id)
                if not has_outstanding and all_complete:
                    connection.execute("UPDATE cycles SET state='completed' WHERE id=?", (cycle_id,))
                elif not has_outstanding:
                    connection.execute("UPDATE cycles SET state='incomplete' WHERE id=?", (cycle_id,))
            if task["kind"] == "company" and task["cycle_id"] is not None:
                remaining = connection.execute("SELECT 1 FROM tasks WHERE cycle_id=? AND kind='company' AND state IN ('pending','awaiting_publication','failed') LIMIT 1",
                                               (task["cycle_id"],)).fetchone()
                if not remaining:
                    connection.execute("UPDATE cycles SET state='completed' WHERE id=?", (task["cycle_id"],))
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        published += 1
        if isinstance(summary, dict):
            summaries.append({"task_id": task["id"], **summary})
    return {"published": published, "summaries": summaries, "errors": errors}


def publish_pending(profile_root: Any, markets: Any) -> dict[str, Any]:
    """Replay saved result checkpoints in order, stopping at the first publication error."""
    root = _root_path(profile_root)
    document = _load_document(root)
    selected = _validate_markets(document, markets)
    entries = _source_entries(document, selected)
    connection = _connect(root)
    if connection is None:
        return {"published": 0, "errors": []}
    try:
        return _publish_pending_connection(root, connection, selected, entries)
    finally:
        connection.close()


def status(profile_root: Any) -> dict[str, Any]:
    """Read queue counters from SQLite without importing YAML/deck or creating files."""
    root = _root_path(profile_root)
    connection = _connect(root, readonly=True)
    empty = {"pending": 0, "awaiting_publication": 0, "published": 0, "failed": 0, "attempted": 0,
             "progress": {"item_pending": 0, "source_pending": 0, "company_pending": 0,
                          "source_incomplete_cycles": 0}}
    if connection is None:
        return empty
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "tasks" not in tables:
            return empty
        state_counts = {row["state"]: row["count"] for row in connection.execute("SELECT state,COUNT(*) AS count FROM tasks GROUP BY state")}
        result_counts = {row["delivery_state"]: row["count"] for row in connection.execute("SELECT delivery_state,COUNT(*) AS count FROM results GROUP BY delivery_state")} if "results" in tables else {}
        # `active` only marks the last start's selection; report every market's backlog.
        coverage_count = connection.execute("SELECT COUNT(DISTINCT url) FROM coverage WHERE pending=1").fetchone()[0] if "coverage" in tables else 0
        coverage_by_market = connection.execute("SELECT market,COUNT(DISTINCT url) AS n FROM coverage WHERE pending=1 GROUP BY market").fetchall() if "coverage" in tables else []
        progress = {"item_pending": coverage_count, "source_pending": 0, "company_pending": 0}
        if "tasks" in tables:
            for row in connection.execute("SELECT kind,COUNT(*) AS n FROM tasks WHERE state IN ('pending','failed') GROUP BY kind"):
                if row["kind"] == "source":
                    progress["source_pending"] = row["n"]
                elif row["kind"] == "company":
                    progress["company_pending"] = row["n"]
        # A later crawl of the same source supersedes an earlier incomplete one.
        incomplete_cycles = connection.execute("""
            SELECT COUNT(*) FROM cycles c WHERE kind='source' AND state='incomplete'
            AND id=(SELECT MAX(id) FROM cycles WHERE kind='source' AND cycle_key=c.cycle_key)
        """).fetchone()[0] if "cycles" in tables else 0
        progress["source_incomplete_cycles"] = incomplete_cycles
        pending = coverage_count + progress["source_pending"] + progress["company_pending"] + incomplete_cycles
        return {"pending": pending, "awaiting_publication": result_counts.get("awaiting_publication", 0),
                "published": state_counts.get("published", 0), "failed": state_counts.get("failed", 0),
                "attempted": connection.execute("SELECT COUNT(DISTINCT task_id) FROM results").fetchone()[0],
                "progress": progress, "pending_by_market": {row["market"]: row["n"] for row in coverage_by_market}}
    finally:
        connection.close()


def _cli() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("stdin must contain a JSON object")
        op = payload.get("op")
        root = payload.get("profile_root")
        if op == "inspect":
            output = inspect(root, payload.get("markets"))
        elif op == "start":
            output = start(root, payload.get("markets"), payload.get("batch_size", DEFAULT_BATCH_SIZE), payload.get("refresh", False))
        elif op == "record":
            output = record(root, payload.get("run_id"), payload.get("task_id"), payload.get("result"))
        elif op == "publish_pending":
            output = publish_pending(root, payload.get("markets"))
        elif op == "status":
            output = status(root)
        else:
            raise ValueError("op must be inspect, start, record, publish_pending, or status")
        sys.stdout.buffer.write((json.dumps(output, ensure_ascii=False, default=str) + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()
        return 0
    except BaseException as exc:
        if isinstance(exc, KeyboardInterrupt):
            raise
        sys.stdout.buffer.write((json.dumps({"scout_error": str(exc)}, ensure_ascii=False) + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(_cli())

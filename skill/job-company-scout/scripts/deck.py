"""Round-trip helpers for the company discovery search deck.

This module deliberately owns only the YAML side of company scout.  It has no
database, browser, or profile initialization side effects at import time.
"""

import copy
import datetime as _datetime
import difflib
import json
import os
import re
import tempfile
import urllib.parse
import uuid
from pathlib import Path, PurePosixPath, PureWindowsPath

from ruamel.yaml import YAML


_MANAGED = "job-company-scout"
_CONTEXT_HISTORY_LIMIT = 10
_SCHEMA_ATS = {"ashby", "greenhouse", "lever"}
_BOARD_TEMPLATES = {
    "ashby": "ashby-boards",
    "greenhouse": "greenhouse-boards",
    # The current template has no Lever route.  Existing compatible operator
    # routes can still be used; otherwise Lever is represented as careers.
    "lever": "lever-boards",
}


def _yaml():
    parser = YAML(typ="rt")
    parser.preserve_quotes = True
    parser.indent(mapping=2, sequence=4, offset=2)
    return parser


def _template_path():
    return Path(__file__).resolve().parents[2] / "job-profile" / "templates" / "data" / "search_packs.yaml"


def _profile_path(profile_root):
    return Path(profile_root).expanduser() / "data" / "search_packs.yaml"


def _iso_timestamp(value, label):
    if isinstance(value, _datetime.datetime):
        return value.isoformat().replace("+00:00", "Z")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("{} must be an ISO-8601 timestamp".format(label))
    text = value.strip()
    try:
        _datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("{} must be an ISO-8601 timestamp".format(label)) from exc
    return text


def canonical_url(url):
    """Canonicalize an absolute HTTP(S) URL for identity and evidence keys."""
    if not isinstance(url, str) or not url.strip():
        raise ValueError("URL must be a non-empty absolute HTTP(S) URL")
    try:
        parts = urllib.parse.urlsplit(url.strip())
        scheme = parts.scheme.lower()
        host = parts.hostname
        port = parts.port
    except (ValueError, UnicodeError) as exc:
        raise ValueError("invalid URL: {}".format(url)) from exc
    if scheme not in ("http", "https") or not host or parts.username or parts.password:
        raise ValueError("URL must be an absolute HTTP(S) URL without credentials: {}".format(url))
    host = host.lower()
    if ":" in host and not host.startswith("["):
        host = "[{}]".format(host)
    if port is not None and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        netloc = "{}:{}".format(host, port)
    else:
        netloc = host
    path = parts.path or "/"
    return urllib.parse.urlunsplit((scheme, netloc, path, parts.query, ""))


def _host_from_url(url):
    canonical = canonical_url(url)
    host = urllib.parse.urlsplit(canonical).hostname.lower()
    return host[4:] if host.startswith("www.") else host


def _is_mapping(value):
    return isinstance(value, dict)


def _require_mapping(value, label):
    if not _is_mapping(value):
        raise ValueError("{} must be a mapping".format(label))


def _require_string(value, label, nonempty=True):
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ValueError("{} must be {}string".format(label, "a non-empty " if nonempty else "a "))


def _require_list(value, label):
    if not isinstance(value, list):
        raise ValueError("{} must be a list".format(label))


def _require_http_url(value, label):
    try:
        canonical_url(value)
    except ValueError as exc:
        raise ValueError("{}: {}".format(label, exc)) from exc


def _validate_route(pack, route, label):
    _require_mapping(route, label + ".route")
    kind = route.get("kind")
    if kind == "json":
        for key in ("url", "pages", "items", "posting_url"):
            _require_string(route.get(key), label + ".route." + key)
        if "{formulation}" not in route["url"] or "{page}" not in route["url"]:
            raise ValueError("{}.route.url must contain {{formulation}} and {{page}}".format(label))
        _require_http_url(route["url"].replace("{formulation}", "x").replace("{page}", "1"), label + ".route.url")
    elif kind == "board":
        ats = route.get("ats")
        if not isinstance(ats, str) or ats.lower() not in _SCHEMA_ATS:
            raise ValueError("{}.route.ats must be a supported ATS".format(label))
        _require_string(route.get("url"), label + ".route.url")
        if "{slug}" not in route["url"]:
            raise ValueError("{}.route.url must contain {{slug}}".format(label))
        _require_http_url(route["url"].replace("{slug}", "tenant"), label + ".route.url")
        for key in ("items", "posting_url", "title"):
            _require_string(route.get(key), label + ".route." + key)
        if "slug_lists" in route:
            _require_list(route["slug_lists"], label + ".route.slug_lists")
    elif kind == "careers":
        if pack.get("surface") != "careers" or pack.get("location") != "keep-only":
            raise ValueError("{}.route.kind careers requires surface careers and location keep-only".format(label))
        _require_http_url(pack.get("entry"), label + ".entry")
        if pack.get("managed_by") == _MANAGED:
            _require_string(pack.get("company_id"), label + ".company_id")
            _require_string(pack.get("company"), label + ".company")
    elif kind == "companies":
        if pack.get("location") != "keep-only":
            raise ValueError("{}.route.kind companies requires location keep-only".format(label))
        _require_string(route.get("csv"), label + ".route.csv")
        if not (PurePosixPath(route["csv"]).is_absolute() or PureWindowsPath(route["csv"]).is_absolute()):
            raise ValueError("{}.route.csv must be an absolute path".format(label))
        if "entry" in pack:
            raise ValueError("{}.entry must be absent for a companies route".format(label))
        for key, allowed in (("regions", {"UK", "US", "EU"}), ("tiers", {"A", "B", "C"})):
            _require_list(route.get(key), label + ".route." + key)
            if not route[key] or any(item not in allowed for item in route[key]):
                raise ValueError("{}.route.{} contains unsupported values".format(label, key))
    else:
        raise ValueError("{}.route.kind is unsupported".format(label))
    for key in ("location", "date", "listed"):
        if key in route and not isinstance(route[key], str):
            raise ValueError("{}.route.{} must be a string".format(label, key))


def _validate_pack(pack, index):
    label = "packs[{}]".format(index)
    _require_mapping(pack, label)
    _require_string(pack.get("id"), label + ".id")
    _require_string(pack.get("surface"), label + ".surface")
    route = pack.get("route")
    if route is not None:
        _require_mapping(route, label + ".route")
    if pack.get("surface") == "careers" and pack.get("location") != "keep-only":
        raise ValueError("{}.location must be keep-only for a careers pack".format(label))
    if route is not None and route.get("kind") != "companies":
        _require_http_url(pack.get("entry"), label + ".entry")
    elif route is None and "entry" in pack:
        _require_http_url(pack.get("entry"), label + ".entry")
    elif route is not None and route.get("kind") == "companies" and "entry" in pack:
        _require_http_url(pack.get("entry"), label + ".entry")
    elif route is None and pack.get("surface") != "companies":
        _require_http_url(pack.get("entry"), label + ".entry")
    if "enabled" in pack and not isinstance(pack["enabled"], bool):
        raise ValueError("{}.enabled must be a boolean".format(label))
    if "formulations" in pack:
        _require_list(pack["formulations"], label + ".formulations")
        if not pack["formulations"] or any(not isinstance(item, str) for item in pack["formulations"]):
            raise ValueError("{}.formulations must contain strings".format(label))
    if "route_required" in pack and not isinstance(pack["route_required"], bool):
        raise ValueError("{}.route_required must be a boolean".format(label))
    if "location" in pack and pack["location"] != "keep-only":
        raise ValueError("{}.location must be keep-only".format(label))
    if route is not None:
        _validate_route(pack, route, label)
    elif pack.get("route_required") is True and pack.get("enabled", True):
        raise ValueError("{}.route is required for this enabled pack".format(label))
    if "boards" in pack:
        _require_list(pack["boards"], label + ".boards")
        for row_index, row in enumerate(pack["boards"]):
            row_label = "{}.boards[{}]".format(label, row_index)
            _require_mapping(row, row_label)
            for key in ("company_id", "name"):
                _require_string(row.get(key), row_label + "." + key)
            _require_http_url(row.get("url"), row_label + ".url")
            if "enabled" in row and not isinstance(row["enabled"], bool):
                raise ValueError(row_label + ".enabled must be a boolean")
            if "managed_by" in row and row["managed_by"] != _MANAGED:
                raise ValueError(row_label + ".managed_by is unsupported")
    if "managed_by" in pack and pack["managed_by"] != _MANAGED:
        raise ValueError(label + ".managed_by is unsupported")


def _validate_decision(value, label):
    _require_mapping(value, label)
    if value.get("status") not in ("pending", "qualified", "rejected"):
        raise ValueError(label + ".status must be pending, qualified, or rejected")
    _require_string(value.get("reason"), label + ".reason", nonempty=False)
    urls = value.get("evidence_urls")
    _require_list(urls, label + ".evidence_urls")
    if value["status"] != "pending" and not urls:
        raise ValueError(label + ".evidence_urls must support the resolved decision")
    for index, url in enumerate(urls):
        _require_http_url(url, "{}.evidence_urls[{}]".format(label, index))


def _validate_company(key, company, label):
    _require_mapping(company, label)
    _require_string(key, label + " key")
    if key != key.lower() or key.startswith("www.") or _host_from_url(company.get("website")) != key:
        raise ValueError("{} must use the verified official hostname as its key".format(label))
    _require_string(company.get("name"), label + ".name")
    _require_http_url(company.get("website"), label + ".website")
    aliases = company.get("aliases")
    _require_list(aliases, label + ".aliases")
    if any(not isinstance(alias, str) or not alias.strip() for alias in aliases):
        raise ValueError(label + ".aliases must contain non-empty strings")
    _iso_timestamp(company.get("first_seen_at"), label + ".first_seen_at")
    _iso_timestamp(company.get("last_checked_at"), label + ".last_checked_at")
    successful = company.get("last_successful_check_at")
    if successful is not None:
        _iso_timestamp(successful, label + ".last_successful_check_at")
    _validate_decision(company.get("relevance"), label + ".relevance")
    markets = company.get("markets")
    _require_mapping(markets, label + ".markets")
    for market, decision in markets.items():
        _require_string(market, label + ".markets key")
        _validate_decision(decision, label + ".markets." + market)
    careers = company.get("careers")
    _require_mapping(careers, label + ".careers")
    if careers.get("status") not in ("unknown", "not_found", "found"):
        raise ValueError(label + ".careers.status must be unknown, not_found, or found")
    if careers.get("status") == "found":
        _require_http_url(careers.get("url"), label + ".careers.url")
    evidence = company.get("evidence")
    _require_list(evidence, label + ".evidence")
    for index, item in enumerate(evidence):
        evidence_label = "{}.evidence[{}]".format(label, index)
        _require_mapping(item, evidence_label)
        _require_http_url(item.get("source_url"), evidence_label + ".source_url")
        _iso_timestamp(item.get("first_seen_at"), evidence_label + ".first_seen_at")
        if item.get("event_type") is not None and not isinstance(item.get("event_type"), str):
            raise ValueError(evidence_label + ".event_type must be a string or null")
        if item.get("event_date") is not None and not isinstance(item.get("event_date"), str):
            raise ValueError(evidence_label + ".event_date must be a string or null")


def validate_deck(document):
    """Validate a parsed search deck. Raises ValueError on the first defect."""
    _require_mapping(document, "search deck")
    packs = document.get("packs")
    _require_list(packs, "packs")
    seen_ids = set()
    for index, pack in enumerate(packs):
        _validate_pack(pack, index)
        pack_id = pack["id"]
        if pack_id in seen_ids:
            raise ValueError("duplicate pack id: {}".format(pack_id))
        seen_ids.add(pack_id)
    if "discovery" not in document:
        return True
    discovery = document["discovery"]
    _require_mapping(discovery, "discovery")
    if "markets" in discovery:
        markets = discovery["markets"]
        _require_mapping(markets, "discovery.markets")
        for market_id, market in markets.items():
            _require_string(market_id, "discovery market id")
            _require_mapping(market, "discovery.markets." + market_id)
            if not isinstance(market.get("enabled"), bool):
                raise ValueError("discovery.markets.{}.enabled must be a boolean".format(market_id))
            _require_string(market.get("scope"), "discovery.markets.{}.scope".format(market_id))
            sources = market.get("sources")
            _require_mapping(sources, "discovery.markets.{}.sources".format(market_id))
            for source_id, source in sources.items():
                _require_string(source_id, "discovery source id")
                _require_mapping(source, "discovery source")
                _require_http_url(source.get("url"), "discovery source url")
                if source.get("strategy") not in ("news", "portfolio"):
                    raise ValueError("discovery source strategy must be news or portfolio")
    if "observations" in discovery:
        observations = discovery["observations"]
        _require_mapping(observations, "discovery.observations")
        for source_url, observation in observations.items():
            if canonical_url(source_url) != source_url:
                raise ValueError("observation keys must be canonical source URLs")
            label = "discovery.observations." + source_url
            _require_mapping(observation, label)
            _iso_timestamp(observation.get("first_seen_at"), label + ".first_seen_at")
            _iso_timestamp(observation.get("last_checked_at"), label + ".last_checked_at")
            successful = observation.get("last_successful_check_at")
            if successful is not None:
                _iso_timestamp(successful, label + ".last_successful_check_at")
            for field in ("seen_urls", "pending_urls"):
                _require_list(observation.get(field), label + "." + field)
                for index, url in enumerate(observation[field]):
                    _require_http_url(url, "{}.{}[{}]".format(label, field, index))
    if "companies" in discovery:
        companies = discovery["companies"]
        _require_mapping(companies, "discovery.companies")
        for key, company in companies.items():
            _validate_company(key, company, "discovery.companies." + str(key))
    return True


def _load_text(text, path_label):
    try:
        document = _yaml().load(text)
    except Exception as exc:
        raise ValueError("could not parse {}: {}".format(path_label, exc)) from exc
    return document


def load_document(profile_root, *, discovery_defaults=False):
    """Read and validate a profile's current search deck without writing."""
    path = _profile_path(profile_root)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        raise
    document = _load_text(text, str(path))
    validate_deck(document)
    if discovery_defaults and "discovery" not in document:
        document = copy.deepcopy(document)
        document["discovery"] = copy.deepcopy(_load_template()["discovery"])
    return document


def _load_template():
    path = _template_path()
    try:
        document = _yaml().load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ValueError("could not read search pack template {}: {}".format(path, exc)) from exc
    validate_deck(document)
    return document


def _slug(value):
    return re.sub(r"[^a-z0-9]+", "-", str(value).lower()).strip("-")


def _decision_status(value):
    return value.get("status") if isinstance(value, dict) else None


def _validate_result(result, document=None):
    _require_mapping(result, "result")
    if result.get("kind") not in ("item", "source", "company"):
        raise ValueError("result.kind must be item, source, or company")
    _require_http_url(result.get("url"), "result.url")
    if canonical_url(result["url"]) != result["url"]:
        raise ValueError("result.url must be canonical")
    markets = result.get("markets")
    _require_list(markets, "result.markets")
    if any(not isinstance(market, str) or not market for market in markets) or len(set(markets)) != len(markets):
        raise ValueError("result.markets must contain unique market ids")
    origins = result.get("origins")
    _require_list(origins, "result.origins")
    for index, origin in enumerate(origins):
        _require_mapping(origin, "result.origins[{}]".format(index))
        if origin.get("market") not in markets:
            raise ValueError("result origin market must be listed in result.markets")
        _require_http_url(origin.get("source_url"), "result origin source_url")
        if canonical_url(origin["source_url"]) != origin["source_url"]:
            raise ValueError("result origin source_url must be canonical")
    if result.get("kind") in ("item", "source") and not origins:
        raise ValueError("item and source results require at least one origin")
    if result.get("outcome") not in ("complete", "retry", "failed"):
        raise ValueError("result.outcome must be complete, retry, or failed")
    checked_at = _iso_timestamp(result.get("checked_at"), "result.checked_at")
    companies = result.get("companies", {})
    _require_mapping(companies, "result.companies")
    for key, company in companies.items():
        _validate_company(key, company, "result.companies." + str(key))
        if result["outcome"] == "complete" and result["kind"] in ("item", "company"):
            if company["relevance"]["status"] == "pending":
                raise ValueError("complete item/company result has unresolved relevance evidence")
            if not company.get("evidence"):
                raise ValueError("complete item/company result requires evidence")
            for market in markets:
                if market not in company["markets"] or company["markets"][market]["status"] == "pending":
                    raise ValueError("complete item/company result has unresolved market evidence for {}".format(market))
    if result["outcome"] == "complete" and result["kind"] in ("item", "company") and not companies:
        raise ValueError("complete item/company result requires a verified company record")
    if result["kind"] == "source":
        page = result.get("page")
        _require_mapping(page, "result.page")
        for field in ("links", "next_pages"):
            _require_list(page.get(field), "result.page." + field)
            for index, url in enumerate(page[field]):
                _require_http_url(url, "result.page.{}[{}]".format(field, index))
        if not isinstance(page.get("complete"), bool):
            raise ValueError("result.page.complete must be a boolean")
        if "pagination_complete" in result and not isinstance(result["pagination_complete"], bool):
            raise ValueError("result.pagination_complete must be a boolean")
    boards = result.get("boards", [])
    _require_list(boards, "result.boards")
    for index, board in enumerate(boards):
        _require_mapping(board, "result.boards[{}]".format(index))
        _require_string(board.get("company_id"), "result.boards[{}].company_id".format(index))
        _require_http_url(board.get("url"), "result.boards[{}].url".format(index))
        board_parts = urllib.parse.urlsplit(canonical_url(board["url"]))
        board_host = (board_parts.hostname or "").lower()
        board_segments = [segment for segment in board_parts.path.split("/") if segment]
        if board_host in ("jobs.ashbyhq.com", "job-boards.greenhouse.io", "boards.greenhouse.io", "jobs.lever.co") and len(board_segments) != 1:
            raise ValueError("result.boards[{}].url must be an ATS board root, not an individual job URL".format(index))
    if document is not None:
        validate_deck(document)
        discovery = document.get("discovery")
        if discovery is None:
            discovery = _load_template()["discovery"]
        for market in markets:
            if market not in discovery.get("markets", {}):
                raise ValueError("result references unknown market: {}".format(market))
        configured = {}
        for market, spec in discovery.get("markets", {}).items():
            for source in spec.get("sources", {}).values():
                configured.setdefault(canonical_url(source["url"]), set()).add(market)
        for origin in origins:
            if origin["source_url"] not in configured or origin["market"] not in configured[origin["source_url"]]:
                raise ValueError("result origin is not configured for market {}: {}".format(origin["market"], origin["source_url"]))
    return checked_at


def _timestamp_key(value):
    try:
        parsed = _datetime.datetime.fromisoformat(_iso_timestamp(value, "timestamp").replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=_datetime.timezone.utc)
        return parsed.timestamp()
    except (ValueError, OverflowError):
        return 0


def _earliest(*values):
    values = [value for value in values if value is not None]
    return min(values, key=_timestamp_key) if values else None


def _append_unique(sequence, value, key=None):
    compare = key or (lambda item: item)
    wanted = compare(value)
    for current in sequence:
        if compare(current) == wanted:
            return False
    sequence.append(value)
    return True


def _merge_decision(old, new):
    if old is None:
        return copy.deepcopy(new)
    old_status, new_status = old.get("status"), new.get("status")
    if new_status == "pending" and old_status in ("qualified", "rejected"):
        chosen = copy.deepcopy(old)
        return chosen
    chosen = copy.deepcopy(new)
    combined = list(chosen.get("evidence_urls", []))
    for url in old.get("evidence_urls", []):
        _append_unique(combined, url, lambda item: canonical_url(item))
    chosen["evidence_urls"] = combined
    return chosen


def _merge_evidence(old_records, new_records):
    records = copy.deepcopy(list(old_records or []))
    positions = {}
    for index, record in enumerate(records):
        key = (canonical_url(record["source_url"]), record.get("event_type"), record.get("event_date"))
        positions[key] = index
    for incoming in new_records or []:
        item = copy.deepcopy(incoming)
        item["source_url"] = canonical_url(item["source_url"])
        key = (item["source_url"], item.get("event_type"), item.get("event_date"))
        if key in positions:
            index = positions[key]
            records[index]["first_seen_at"] = _earliest(records[index].get("first_seen_at"), item.get("first_seen_at"))
        else:
            positions[key] = len(records)
            records.append(item)
    return records


def _alias_host(alias):
    if not isinstance(alias, str) or not alias:
        return None
    candidate = alias if "://" in alias else "https://" + alias
    try:
        return _host_from_url(candidate)
    except ValueError:
        return None


def _find_identity_matches(companies, key, record):
    aliases = {_alias_host(value) for value in record.get("aliases", [])}
    aliases.discard(None)
    matches = []
    for old_key, old_record in companies.items():
        if old_key == key:
            continue
        old_aliases = {_alias_host(value) for value in old_record.get("aliases", [])}
        old_aliases.discard(None)
        if old_key in aliases or key in old_aliases:
            matches.append(old_key)
    return matches


def _merge_company_record(companies, key, record):
    matches = _find_identity_matches(companies, key, record)
    if len(matches) > 1:
        raise ValueError("conflicting verified hostname aliases for {}".format(key))
    old_key = matches[0] if matches else key
    if old_key != key and key in companies:
        raise ValueError("conflicting existing company identities: {} and {}".format(old_key, key))
    existing = companies.pop(old_key, None) if old_key != key else companies.get(key)
    incoming = copy.deepcopy(record)
    if existing is None:
        companies[key] = incoming
        return
    merged = copy.deepcopy(existing)
    merged["name"] = incoming["name"]
    merged["website"] = incoming["website"]
    aliases = list(incoming.get("aliases", []))
    if old_key != key:
        _append_unique(aliases, old_key)
    for alias in merged.get("aliases", []):
        _append_unique(aliases, alias)
    merged["aliases"] = aliases
    merged["first_seen_at"] = _earliest(existing.get("first_seen_at"), incoming.get("first_seen_at"))
    merged["last_checked_at"] = incoming.get("last_checked_at")
    merged["last_successful_check_at"] = incoming.get("last_successful_check_at") or existing.get("last_successful_check_at")
    merged["relevance"] = _merge_decision(existing.get("relevance"), incoming.get("relevance"))
    markets = copy.deepcopy(existing.get("markets", {}))
    for market, decision in incoming.get("markets", {}).items():
        markets[market] = _merge_decision(markets.get(market), decision)
    merged["markets"] = markets
    old_careers, new_careers = existing.get("careers", {}), incoming.get("careers", {})
    if new_careers.get("status") == "unknown" and old_careers.get("status") in ("found", "not_found"):
        merged["careers"] = copy.deepcopy(old_careers)
    else:
        merged["careers"] = copy.deepcopy(new_careers)
    merged["evidence"] = _merge_evidence(existing.get("evidence", []), incoming.get("evidence", []))
    companies[key] = merged


def _empty_observation(checked_at):
    return {"first_seen_at": checked_at, "last_checked_at": checked_at,
            "last_successful_check_at": None, "seen_urls": [], "pending_urls": []}


def _get_observation(discovery, source_url, checked_at):
    observations = discovery.setdefault("observations", {})
    source_url = canonical_url(source_url)
    observation = observations.get(source_url)
    if observation is None:
        observation = _empty_observation(checked_at)
        observations[source_url] = observation
    return observation


def _url_equal(left, right):
    try:
        return canonical_url(left) == canonical_url(right)
    except ValueError:
        return left == right


def _source_markets(discovery, source_url):
    markets = set()
    for market, spec in discovery.get("markets", {}).items():
        if not _is_mapping(spec) or spec.get("enabled", True) is False:
            continue
        for source in (spec.get("sources") or {}).values():
            if _is_mapping(source) and source.get("enabled", True) is not False and _url_equal(source.get("url"), source_url):
                markets.add(market)
    return markets


def _merge_observation_result(discovery, result):
    checked_at = result["checked_at"]
    kind, outcome = result["kind"], result["outcome"]
    if kind not in ("item", "source"):
        return
    for origin in result["origins"]:
        observation = _get_observation(discovery, origin["source_url"], checked_at)
        observation["last_checked_at"] = checked_at
        if kind == "item":
            if outcome == "complete":
                url = canonical_url(result["url"])
                _append_unique(observation["seen_urls"], url, lambda item: canonical_url(item))
                # pending_urls is shared by every market configuring this source;
                # keep the link until each of those markets has researched it.
                researched = set(result["markets"])
                researched.update((result.get("researched_markets") or {}).get(origin["source_url"], []))
                if _source_markets(discovery, origin["source_url"]) <= researched:
                    observation["pending_urls"] = [
                        current for current in observation["pending_urls"] if not _url_equal(current, url)
                    ]
        elif outcome == "complete":
            page = result["page"]
            for url in page["links"]:
                normalized = canonical_url(url)
                already_seen = any(_url_equal(current, normalized) for current in observation["seen_urls"])
                _append_unique(observation["seen_urls"], normalized, lambda item: canonical_url(item))
                if not already_seen:
                    _append_unique(observation["pending_urls"], normalized, lambda item: canonical_url(item))
            if result.get("pagination_complete") is True:
                observation["last_successful_check_at"] = checked_at


def _normalize_exclusions(profile_root):
    path = Path(profile_root).expanduser() / "data" / "job_search.yaml"
    if not path.exists():
        return set()
    try:
        data = _yaml().load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:
        raise ValueError("could not parse {}: {}".format(path, exc)) from exc
    values = data.get("exclude_companies", []) if isinstance(data, dict) else []
    if values is None:
        return set()
    if not isinstance(values, list):
        raise ValueError("{}: exclude_companies must be a list".format(path))
    return {_slug(value) for value in values if isinstance(value, str) and value.strip()}


def _apply_exclusions(result, exclusions):
    if not exclusions or result.get("outcome") != "complete":
        return result
    adjusted = copy.deepcopy(result)
    for company in adjusted.get("companies", {}).values():
        names = [company.get("name", "")] + list(company.get("aliases", []))
        if any(_slug(name) in exclusions for name in names if isinstance(name, str)):
            relevance = company["relevance"]
            relevance["status"] = "rejected"
            relevance["reason"] = "Excluded by the profile's exclude_companies setting."
            if not relevance.get("evidence_urls"):
                relevance["evidence_urls"] = [company["website"]]
    return adjusted


def _ats_tenant(url):
    canonical = canonical_url(url)
    parts = urllib.parse.urlsplit(canonical)
    host = parts.hostname.lower()
    path_parts = [segment for segment in parts.path.split("/") if segment]
    if len(path_parts) != 1:
        return None
    if host == "jobs.ashbyhq.com":
        ats = "ashby"
    elif host in ("job-boards.greenhouse.io", "boards.greenhouse.io"):
        ats = "greenhouse"
    elif host == "jobs.lever.co":
        ats = "lever"
    else:
        return None
    tenant = urllib.parse.unquote(path_parts[0]).lower()
    if not tenant or tenant in ("api", "postings", "jobs"):
        return None
    return ats, tenant, canonical


def _row_instance(pack, row):
    route = pack.get("route", {})
    if route.get("kind") != "board":
        return None
    board = _ats_tenant(row.get("url"))
    if board and board[0] == route.get("ats"):
        return board[:2]
    return None


def _all_company_refs(document, key):
    for pack in document.get("packs", []):
        if pack.get("managed_by") == _MANAGED and pack.get("company_id") == key:
            yield "pack", pack, None
        for row in pack.get("boards", []) or []:
            if row.get("managed_by") == _MANAGED and row.get("company_id") == key:
                yield "board", pack, row


def _update_rekey_references(document, old_key, new_key, name):
    if old_key == new_key:
        return
    for pack in document.get("packs", []):
        if pack.get("managed_by") == _MANAGED and pack.get("company_id") == old_key:
            pack["company_id"] = new_key
            pack["company"] = name
        for row in pack.get("boards", []) or []:
            if row.get("managed_by") == _MANAGED and row.get("company_id") == old_key:
                row["company_id"] = new_key
                row["name"] = name


def _disable_company_routes(document, company_key):
    for pack in document.get("packs", []):
        if pack.get("managed_by") == _MANAGED and pack.get("company_id") == company_key:
            pack["enabled"] = False
        for row in pack.get("boards", []) or []:
            if row.get("managed_by") == _MANAGED and row.get("company_id") == company_key:
                row["enabled"] = False


def _qualified(company):
    relevance = company.get("relevance", {}).get("status") == "qualified"
    markets = company.get("markets", {}).values()
    return relevance and any(market.get("status") == "qualified" for market in markets)


def _confirmed_rejection(company, exclusions, key):
    if _slug(company.get("name", "")) in exclusions or any(_slug(alias) in exclusions for alias in company.get("aliases", [])):
        return True
    if company.get("relevance", {}).get("status") == "rejected":
        return True
    statuses = [record.get("status") for record in company.get("markets", {}).values()]
    return bool(statuses) and all(status == "rejected" for status in statuses)


def _careers_pack_id(packs, host, entry):
    base = "careers-{}".format(re.sub(r"[^a-z0-9]+", "-", host.lower()).strip("-"))
    candidate = base
    index = 2
    ids = {pack.get("id") for pack in packs}
    while candidate in ids:
        existing = next(pack for pack in packs if pack.get("id") == candidate)
        if existing.get("company_id") == host and _url_equal(existing.get("entry", ""), entry):
            return candidate
        candidate = "{}-{}".format(base, index)
        index += 1
    return candidate


def _ensure_careers_pack(document, company_key, company):
    entry = canonical_url(company["careers"]["url"])
    packs = document["packs"]
    for pack in packs:
        if (pack.get("surface") == "careers" and pack.get("location") == "keep-only"
                and pack.get("company_id") == company_key and _url_equal(pack.get("entry", ""), entry)):
            # Preserve any operator or discovery enabled state exactly.
            return pack
    # An operator-authored careers route with an identical destination can be
    # used without claiming or editing it.
    for pack in packs:
        if (pack.get("surface") == "careers" and pack.get("location") == "keep-only"
                and _url_equal(pack.get("entry", ""), entry)):
            return pack
    pack_id = _careers_pack_id(packs, company_key, entry)
    pack = {
        "id": pack_id,
        "surface": "careers",
        "entry": entry,
        "location": "keep-only",
        "route": {"kind": "careers"},
        "company_id": company_key,
        "company": company["name"],
        "managed_by": _MANAGED,
    }
    packs.append(pack)
    return pack


def _template_board_pack(ats):
    template = _load_template()
    expected_id = _BOARD_TEMPLATES.get(ats)
    if not expected_id:
        return None
    for pack in template["packs"]:
        if pack.get("id") == expected_id and pack.get("route", {}).get("kind") == "board" and pack["route"].get("ats") == ats:
            return copy.deepcopy(pack)
    return None


def _add_board_or_careers(document, company_key, company, board_url):
    candidate = _ats_tenant(board_url)
    if candidate is None:
        _ensure_careers_pack(document, company_key, company)
        return
    ats, tenant, normalized_url = candidate
    packs = document["packs"]
    compatible = [pack for pack in packs if pack.get("route", {}).get("kind") == "board"
                  and pack.get("route", {}).get("ats") == ats]
    instance = (ats, tenant)
    for pack in packs:
        for row in pack.get("boards", []) or []:
            if _row_instance(pack, row) == instance:
                if row.get("managed_by") == _MANAGED and row.get("company_id") != company_key:
                    aliases = {_alias_host(alias) for alias in company.get("aliases", [])}
                    aliases.discard(None)
                    if row.get("company_id") in aliases:
                        row["company_id"] = company_key
                        row["name"] = company["name"]
                return
    target = compatible[0] if compatible else None
    if target is None:
        template_pack = _template_board_pack(ats)
        if template_pack is None:
            _ensure_careers_pack(document, company_key, company)
            return
        existing = next((pack for pack in packs if pack.get("id") == template_pack["id"]), None)
        if existing is not None:
            # An occupied incompatible id is an operator conflict. Keep the
            # research record, but do not replace or route around the pack.
            return
        packs.append(template_pack)
        target = template_pack
    boards = target.setdefault("boards", [])
    # A matching operator-owned row was handled above. New rows are always
    # discovery-owned and use the verified company host as their identity.
    _append_unique(boards, {
        "company_id": company_key,
        "name": company["name"],
        "url": normalized_url,
        "managed_by": _MANAGED,
    }, lambda row: (row.get("company_id"), _row_instance(target, row)))


def _materialize(document, result, exclusions):
    if result.get("outcome") != "complete":
        return
    discovery = document["discovery"]
    incoming = result.get("companies", {})
    aliases_to_new = {}
    for key, record in incoming.items():
        for alias in record.get("aliases", []):
            host = _alias_host(alias)
            if host and host != key:
                aliases_to_new[host] = key
    for old_key, new_key in aliases_to_new.items():
        _update_rekey_references(document, old_key, new_key, incoming[new_key]["name"])
    for key, incoming_record in incoming.items():
        company = discovery["companies"].get(key)
        if company is None:
            # A rekeyed record is stored under its new host.
            company = next((value for candidate, value in discovery["companies"].items()
                            if _alias_host(candidate) in {_alias_host(alias) for alias in incoming_record.get("aliases", [])}), None)
        if company is None:
            continue
        excluded = any(_slug(name) in exclusions for name in [company.get("name", "")] + list(company.get("aliases", [])))
        if _confirmed_rejection(company, exclusions, key):
            _disable_company_routes(document, key)
            continue
        if excluded or not _qualified(company) or company.get("careers", {}).get("status") != "found":
            continue
        board_records = [board for board in result.get("boards", [])
                         if _alias_host(board.get("company_id", "")) in {key, *({_alias_host(a) for a in company.get("aliases", [])} - {None})}]
        board_url = board_records[0].get("url") if board_records else company["careers"].get("url")
        _add_board_or_careers(document, key, company, board_url)


def merge_result(document, result):
    """Validate and merge a structured result, returning a new document."""
    validate_deck(document)
    _validate_result(result, document)
    working = copy.deepcopy(document)
    if "discovery" not in working:
        working["discovery"] = copy.deepcopy(_load_template()["discovery"])
    # Preserve the complete prior record on failed or retry outcomes. A check
    # can advance observation attempt timestamps, but never rewrite verified
    # company facts or decisions.
    if result["outcome"] == "complete":
        companies = working["discovery"].setdefault("companies", {})
        for key, record in result.get("companies", {}).items():
            record = copy.deepcopy(record)
            record["markets"] = {market: decision for market, decision in record["markets"].items()
                                 if market in result["markets"]}
            old_key = next((match for match in _find_identity_matches(companies, key, record)), key)
            _merge_company_record(companies, key, record)
            if old_key != key:
                _update_rekey_references(working, old_key, key, record["name"])
    _merge_observation_result(working["discovery"], result)
    _materialize(working, result, set())
    validate_deck(working)
    return working


def _copy_company_facts(company, selected_markets):
    # Previews are context only; merging still reads the full authoritative
    # history from disk. Report omitted history separately from company facts.
    preview = copy.deepcopy(company)
    counts = {"evidence": len(preview.get("evidence", [])),
              "aliases": len(preview.get("aliases", [])), "decision_evidence_urls": {}}
    preview["evidence"] = preview.get("evidence", [])[-_CONTEXT_HISTORY_LIMIT:]
    preview["aliases"] = preview.get("aliases", [])[:_CONTEXT_HISTORY_LIMIT]
    preview["markets"] = {market: decision for market, decision in preview.get("markets", {}).items()
                          if market in selected_markets}
    decisions = [("relevance", preview["relevance"])] + list(preview["markets"].items())
    for label, decision in decisions:
        urls = decision.get("evidence_urls", [])
        counts["decision_evidence_urls"][label] = len(urls)
        decision["evidence_urls"] = urls[:_CONTEXT_HISTORY_LIMIT]
    return preview, counts


def read_context(profile_root, markets, task_ids):
    """Return bounded market/source metadata and explicitly requested facts."""
    document = load_document(profile_root, discovery_defaults=True)
    discovery = document["discovery"]
    selected = list(markets or [])
    market_map = discovery.get("markets", {})
    selected = [market for market in market_map if market in selected]
    observations = discovery.get("observations", {})
    market_rows = []
    for market_id in selected:
        spec = market_map[market_id]
        sources = []
        pending_total = 0
        seen_total = 0
        for source_id, source in spec.get("sources", {}).items():
            source_url = canonical_url(source["url"])
            observation = observations.get(source_url, {})
            pending_count = len(observation.get("pending_urls", []))
            seen_count = len(observation.get("seen_urls", []))
            pending_total += pending_count
            seen_total += seen_count
            sources.append({
                "id": source_id,
                "url": source_url,
                "strategy": source["strategy"],
                "pending_count": pending_count,
                "seen_count": seen_count,
                "last_checked_at": observation.get("last_checked_at"),
                "last_successful_check_at": observation.get("last_successful_check_at"),
            })
        market_rows.append({
            "id": market_id,
            "enabled": spec["enabled"],
            "scope": spec["scope"],
            "sources": sources,
            "pending_count": pending_total,
            "seen_count": seen_total,
        })
    companies = discovery.get("companies", {})
    requested = {}
    history_counts = {}
    for task_id in task_ids or []:
        if isinstance(task_id, str) and task_id in companies:
            requested[task_id], history_counts[task_id] = _copy_company_facts(companies[task_id], selected)
    return {
        "markets": market_rows,
        "companies": requested,
        "company_history_counts": history_counts,
        "counts": {
            "market_count": len(market_rows),
            "source_count": sum(len(market["sources"]) for market in market_rows),
            "company_count": len(companies),
            "requested_company_count": len(requested),
        },
    }


def _yaml_text(document):
    from io import StringIO
    stream = StringIO()
    _yaml().dump(document, stream)
    return stream.getvalue()


def _scalar(node):
    return getattr(node, "value", None)


def _mapping_pairs(node):
    if node is None or not hasattr(node, "value"):
        return []
    return node.value if isinstance(node.value, list) else []


def _node_member(mapping_node, key):
    for key_node, value_node in _mapping_pairs(mapping_node):
        if _scalar(key_node) == key:
            return key_node, value_node
    return None, None


def _line_start(text, line_number):
    if line_number <= 0:
        return 0
    offset = 0
    for _ in range(line_number):
        next_line = text.find("\n", offset)
        if next_line < 0:
            return len(text)
        offset = next_line + 1
    return offset


def _root_pair(text, root_node, key):
    key_node, value_node = _node_member(root_node, key)
    if key_node is None:
        return None, None, None
    start = _line_start(text, key_node.start_mark.line)
    end = _node_end(text, value_node)
    return key_node, value_node, (start, end)


def _sequence_items(node):
    return node.value if node is not None and isinstance(node.value, list) else []


def _node_field_value(mapping_node, field):
    _, value_node = _node_member(mapping_node, field)
    return value_node


def _pack_node_by_id(packs_node, pack_id):
    for node in _sequence_items(packs_node):
        _, id_node = _node_member(node, "id")
        if id_node is not None and _scalar(id_node) == pack_id:
            return node
    return None


def _item_span(text, node):
    start = _line_start(text, node.start_mark.line)
    end = _node_end(text, node)
    return start, end


def _node_end(text, node):
    end = node.end_mark.index
    line_start = _line_start(text, node.end_mark.line)
    # A collection can end at the next key's column, after its indentation.
    # That whitespace belongs to the following field, outside this edit.
    if not text[line_start:end].strip():
        return line_start
    return end


def _slice_node(text, node):
    start, end = _item_span(text, node)
    return text[start:end]


def _dumped_nodes(text):
    parser = _yaml()
    root = parser.compose(text)
    if root is None:
        raise ValueError("rendered YAML is empty")
    _, packs_node = _node_member(root, "packs")
    return root, packs_node


def _surgical_text(original_text, original_document, updated_document):
    if original_document == updated_document:
        return original_text
    rendered = _yaml_text(updated_document)
    old_root, old_packs_node = _dumped_nodes(original_text)
    new_root, new_packs_node = _dumped_nodes(rendered)
    old_discovery = original_document.get("discovery")
    new_discovery = updated_document.get("discovery")
    old_packs = {pack["id"]: pack for pack in original_document.get("packs", [])}
    new_packs = {pack["id"]: pack for pack in updated_document.get("packs", [])}
    changed_existing = {pack_id for pack_id in old_packs.keys() & new_packs.keys()
                        if old_packs[pack_id] != new_packs[pack_id]}
    added_ids = [pack["id"] for pack in updated_document.get("packs", []) if pack["id"] not in old_packs]
    patches = []
    old_root_discovery = _root_pair(original_text, old_root, "discovery")
    new_root_discovery = _root_pair(rendered, new_root, "discovery")

    # Only observations and company history are discovery-owned. Market/source
    # configuration and unknown extension keys remain operator-owned bytes.
    discovery_changed = old_discovery != new_discovery
    discovery_replacement = None
    if new_root_discovery[2] is not None:
        discovery_replacement = rendered[new_root_discovery[2][0]:new_root_discovery[2][1]]
        if discovery_changed and old_root_discovery[2] is not None:
            old_node, new_node = old_root_discovery[1], new_root_discovery[1]
            inserted = []
            for field in set(old_discovery) | set(new_discovery):
                if old_discovery.get(field) == new_discovery.get(field):
                    continue
                if field not in ("observations", "companies"):
                    raise ValueError("unsupported operator discovery change: {}".format(field))
            for field in ("observations", "companies"):
                if old_discovery.get(field) == new_discovery.get(field):
                    continue
                old_field = _root_pair(original_text, old_node, field)
                new_field = _root_pair(rendered, new_node, field)
                if new_field[2] is None:
                    raise ValueError("discovery history cannot be removed")
                fragment = rendered[new_field[2][0]:new_field[2][1]]
                if old_field[2] is None:
                    inserted.append(fragment)
                else:
                    patches.append((old_field[2][0], old_field[2][1], fragment))
            if inserted:
                end = _node_end(original_text, old_node)
                prefix = "" if end == 0 or original_text[end - 1] == "\n" else "\n"
                patches.append((end, end, prefix + "".join(inserted)))

    # Shared operator board packs are edited at their boards value only.
    # Discovery-created careers packs are owned as complete entries.
    for pack_id in changed_existing:
        old_value, new_value = old_packs[pack_id], new_packs[pack_id]
        old_pack_node = _pack_node_by_id(old_packs_node, pack_id)
        new_pack_node = _pack_node_by_id(new_packs_node, pack_id)
        if old_pack_node is None or new_pack_node is None:
            raise ValueError("could not locate pack span for {}".format(pack_id))
        if old_value.get("managed_by") == _MANAGED and old_value.get("route", {}).get("kind") == "careers":
            old_start, old_end = _item_span(original_text, old_pack_node)
            new_text = _slice_node(rendered, new_pack_node)
            patches.append((old_start, old_end, new_text))
            continue
        if old_value.get("boards") != new_value.get("boards"):
            old_boards = _node_field_value(old_pack_node, "boards")
            new_boards = _node_field_value(new_pack_node, "boards")
            if new_boards is None:
                raise ValueError("could not render boards for pack {}".format(pack_id))
            new_start, new_end = _item_span(rendered, new_boards)
            new_value_text = rendered[new_start:new_end]
            if old_boards is not None:
                old_start, old_end = _item_span(original_text, old_boards)
                patches.append((old_start, old_end, new_value_text))
            else:
                # Insert the new field at the existing pack's end, after its
                # final operator field and before the next list item.
                old_end = _node_end(original_text, old_pack_node)
                prefix = "" if old_end == 0 or original_text[old_end - 1] == "\n" else "\n"
                field_fragment_start = _line_start(rendered, _node_member(new_pack_node, "boards")[0].start_mark.line)
                field_fragment = rendered[field_fragment_start:new_end]
                patches.append((old_end, old_end, prefix + field_fragment))
        elif old_value != new_value:
            # No known mutable subfield should take this path. Refuse to widen
            # a patch over an operator-owned pack.
            raise ValueError("unsupported operator pack change in {}".format(pack_id))

    # Discovery-owned career packs are new sequence items. Copy their rendered
    # item blocks and insert before discovery when it exists.
    added_fragments = []
    for pack_id in added_ids:
        new_node = _pack_node_by_id(new_packs_node, pack_id)
        if new_node is None:
            raise ValueError("could not locate new pack span for {}".format(pack_id))
        added_fragments.append(_slice_node(rendered, new_node).rstrip("\r\n"))
    if added_fragments:
        joined = "\n".join(added_fragments)
        if old_root_discovery[2] is not None:
            discovery_start, _ = old_root_discovery[2]
            patches.append((discovery_start, discovery_start, joined + "\n"))
        else:
            # The discovery block is absent only in a profile receiving its
            # first explicit research publication. Add it after the pack list.
            pack_end = _node_end(original_text, old_packs_node)
            prefix = "" if pack_end == 0 or original_text[pack_end - 1] == "\n" else "\n"
            discovery_block = discovery_replacement or ""
            insertion = prefix + joined + "\n\n" + discovery_block
            patches.append((pack_end, pack_end, insertion))
    elif discovery_changed and old_root_discovery[2] is None and discovery_replacement:
        # A discovery-only initialization with no new packs.
        pack_end = _node_end(original_text, old_packs_node)
        prefix = "" if pack_end == 0 or original_text[pack_end - 1] == "\n" else "\n"
        patches.append((pack_end, pack_end, prefix + "\n" + discovery_replacement))

    # Apply non-overlapping source-span edits from the end backwards. Adjacent
    # insertion and replacement spans are consolidated above.
    patches.sort(key=lambda patch: (patch[0], patch[1]), reverse=True)
    result_text = original_text
    last_start = None
    for start, end, replacement in patches:
        if last_start is not None and end > last_start:
            raise ValueError("overlapping surgical YAML edits")
        result_text = result_text[:start] + replacement + result_text[end:]
        last_start = start
    parsed = _load_text(result_text, "staged search deck")
    validate_deck(parsed)
    if parsed != updated_document:
        raise ValueError("surgical YAML patch did not preserve the intended deck semantics")
    return result_text


def _publication_summary(before, after):
    before_companies = before.get("discovery", {}).get("companies", {})
    after_companies = after.get("discovery", {}).get("companies", {})
    return {
        "companies_added": sum(1 for key in after_companies if key not in before_companies),
        "companies_updated": sum(1 for key in after_companies if key in before_companies and after_companies[key] != before_companies[key]),
        "pack_ids": [pack["id"] for pack in after.get("packs", [])
                     if pack.get("enabled", True) and pack != next(
                         (old for old in before.get("packs", []) if old["id"] == pack["id"]), None)],
    }


def publish_result(profile_root, result):
    """Atomically publish one validated queue result to the profile deck."""
    path = _profile_path(profile_root)
    original_bytes = path.read_bytes()
    try:
        original_text = original_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("{} is not UTF-8: {}".format(path, exc)) from exc
    original_document = _load_text(original_text, str(path))
    validate_deck(original_document)
    _validate_result(result, original_document)
    exclusions = _normalize_exclusions(profile_root)
    adjusted_result = _apply_exclusions(result, exclusions)
    updated_document = merge_result(original_document, adjusted_result)
    # merge_result is also a public pure helper. Apply profile-specific
    # exclusion policy here after a successful structured result is merged.
    _materialize(updated_document, adjusted_result, exclusions)
    validate_deck(updated_document)
    staged_text = _surgical_text(original_text, original_document, updated_document)
    if staged_text == original_text:
        return _publication_summary(original_document, updated_document)

    temp_path = path.with_name(path.name + ".{}.tmp".format(uuid.uuid4().hex))
    try:
        with open(temp_path, "xb") as staged:
            staged.write(staged_text.encode("utf-8"))
            staged.flush()
            os.fsync(staged.fileno())
        staged_document = _load_text(temp_path.read_text(encoding="utf-8"), str(temp_path))
        validate_deck(staged_document)
        if staged_document != updated_document:
            raise ValueError("staged search deck differs from the validated result")
        if path.read_bytes() != original_bytes:
            raise ValueError("search deck changed during publication")
        os.replace(temp_path, path)
    finally:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass
    return _publication_summary(original_document, updated_document)

#!/usr/bin/env python3
"""Resolve a residence country and compare it with UN M49 geography labels."""

from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
import sys
from typing import Any

DATA_PATH = Path(__file__).with_name("geography.json")
COUNTRY_ALIASES = {
    "brasil": "BR",
    "united states": "US",
    "united kingdom": "GB",
    "uk": "GB",
}
REGION_ALIASES = {
    "latam": "latin america and the caribbean",
    "latin america": "latin america and the caribbean",
    "eu": "european union",
}
WORLDWIDE_LABELS = {"worldwide", "anywhere", "global"}


@lru_cache(maxsize=1)
def _load_countries() -> tuple[dict[str, dict[str, Any]], dict[str, str], dict[str, set[str]]]:
    with DATA_PATH.open("r", encoding="utf-8") as stream:
        data = json.load(stream)
    countries = data["countries"]
    groups = {name: set(group["countries"]) for name, group in data["groups"].items()}
    lookup: dict[str, str] = {}
    for code, country in countries.items():
        for value in (code, country["alpha3"], country["name"]):
            lookup[value.strip().casefold()] = code
    lookup.update(COUNTRY_ALIASES)
    return countries, lookup, groups


def _country_code(value: str, lookup: dict[str, str]) -> str | None:
    return lookup.get(value.strip().casefold())


def _place_match(
    place: str,
    residence_code: str,
    countries: dict[str, dict[str, Any]],
    country_lookup: dict[str, str],
    groups: dict[str, set[str]],
) -> bool | None:
    normalized = place.strip().casefold()
    if normalized in WORLDWIDE_LABELS:
        return True

    country_code = _country_code(place, country_lookup)
    if country_code is not None:
        return country_code == residence_code

    canonical_region = REGION_ALIASES.get(normalized, normalized)
    if canonical_region in groups:
        return residence_code in groups[canonical_region]
    residence_regions = {
        region.casefold() for region in countries[residence_code]["regions"]
    }
    if canonical_region in residence_regions:
        return True
    if any(
        canonical_region == region.casefold()
        for country in countries.values()
        for region in country["regions"]
    ):
        return False
    return None


def geography_payload(payload: object) -> tuple[int, dict[str, object]]:
    """Return normalized residence geography and membership for supplied places."""
    if not isinstance(payload, dict):
        return 1, {"geography_error": "input must be a JSON object"}
    if "country" not in payload or not isinstance(payload["country"], str):
        return 1, {"geography_error": "country must be a string"}
    places = payload.get("places", [])
    if not isinstance(places, list) or any(not isinstance(place, str) for place in places):
        return 1, {"geography_error": "places must be a list of strings"}

    try:
        countries, lookup, groups = _load_countries()
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
        return 1, {"geography_error": f"could not load geography data: {error}"}

    code = _country_code(payload["country"], lookup)
    if code is None:
        return 0, {"country": None, "regions": [], "matches": [None for _ in places]}

    country = countries[code]
    matches = [
        _place_match(place, code, countries, lookup, groups)
        for place in places
    ]
    return 0, {
        "country": country["name"],
        "regions": country["regions"],
        "matches": matches,
    }


def main() -> int:
    try:
        raw = sys.stdin.buffer.read().decode("utf-8")
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        result: dict[str, object] = {"geography_error": f"invalid UTF-8 JSON input: {error}"}
        code = 1
    else:
        code, result = geography_payload(payload)

    try:
        encoded = json.dumps(result, ensure_ascii=False).encode("utf-8") + b"\n"
        sys.stdout.buffer.write(encoded)
    except (BrokenPipeError, OSError):
        return 1
    return code


if __name__ == "__main__":
    raise SystemExit(main())

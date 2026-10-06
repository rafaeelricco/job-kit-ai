#!/usr/bin/env python3
"""Resolve a residence country and compare it with UN M49 geography labels."""

from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path
import re
import sys
from typing import Any
import unicodedata

DATA_PATH = Path(__file__).with_name("geography.json")
COUNTRY_ALIASES = {
    "brasil": "BR",
    "united states": "US",
    "united kingdom": "GB",
    "uk": "GB",
    "great britain": "GB",
    "england": "GB",
    "scotland": "GB",
    "wales": "GB",
    "northern ireland": "GB",
    "south korea": "KR",
    "north korea": "KP",
    "russia": "RU",
    "vietnam": "VN",
    "turkey": "TR",
    "czech republic": "CZ",
    "tanzania": "TZ",
    "syria": "SY",
    "moldova": "MD",
    "laos": "LA",
    "brunei": "BN",
    "ivory coast": "CI",
    "cape verde": "CV",
    "east timor": "TL",
    "palestine": "PS",
    "macedonia": "MK",
    "swaziland": "SZ",
    "vatican": "VA",
    "vatican city": "VA",
    "dr congo": "CD",
    "drc": "CD",
    "republic of the congo": "CG",
    "hong kong": "HK",
    "macau": "MO",
    "macao": "MO",
}
REGION_ALIASES = {
    "latam": "latin america and the caribbean",
    "latin america": "latin america and the caribbean",
    "eu": "european union",
}
WORLDWIDE_LABELS = {"worldwide", "anywhere", "global"}
# Countries M49 files under one continent that also lie in Europe or Asia.
TRANSCONTINENTAL = {"AM", "AZ", "CY", "GE", "KZ", "RU", "TR"}
TRANSCONTINENTAL_LABELS = {"europe", "asia"}
PARENTHETICAL = re.compile(r"\s*\([^)]*\)")


@lru_cache(maxsize=1)
def _load_countries() -> tuple[dict[str, dict[str, Any]], dict[str, str], dict[str, set[str]]]:
    with DATA_PATH.open("r", encoding="utf-8") as stream:
        data = json.load(stream)
    countries = data["countries"]
    groups = {name: set(group["countries"]) for name, group in data["groups"].items()}
    lookup: dict[str, str] = {}
    for code, country in countries.items():
        short_name = PARENTHETICAL.sub("", country["name"])
        for value in (code, country["alpha3"], country["name"], short_name):
            lookup[_normalize(value)] = code
    lookup.update({_normalize(alias): code for alias, code in COUNTRY_ALIASES.items()})
    return countries, lookup, groups


def _normalize(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.replace("\u2019", "'"))
    folded = "".join(char for char in decomposed if not unicodedata.combining(char))
    return " ".join(folded.casefold().split())


def _country_code(value: str, lookup: dict[str, str]) -> str | None:
    return lookup.get(_normalize(value))


def _place_match(
    place: str,
    residence_code: str,
    countries: dict[str, dict[str, Any]],
    country_lookup: dict[str, str],
    groups: dict[str, set[str]],
) -> bool | None:
    normalized = _normalize(place)
    if normalized in WORLDWIDE_LABELS:
        return True
    # Georgia is also a US state; a US residence cannot tell which one a label means.
    if residence_code == "US" and normalized == "georgia":
        return None

    country_code = _country_code(place, country_lookup)
    if country_code is not None:
        if normalized == country_code.casefold() and country_code != residence_code:
            return None
        return country_code == residence_code

    canonical_region = REGION_ALIASES.get(normalized, normalized)
    if canonical_region in groups:
        return residence_code in groups[canonical_region]
    residence_regions = {
        region.casefold() for region in countries[residence_code]["regions"]
    }
    if canonical_region in residence_regions:
        return True
    if canonical_region == "europe" and residence_code in groups["european union"]:
        return True
    if canonical_region in TRANSCONTINENTAL_LABELS and residence_code in TRANSCONTINENTAL:
        return None
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

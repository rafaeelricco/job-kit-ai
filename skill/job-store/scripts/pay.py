#!/usr/bin/env python3
"""Yearly USD pay from a posting's printed salary phrase, and the profile pay floor.

The one pay rule (`job-scout/references/flows/flow-gate.md`). Period factors are
the job-apply ones (`contract-screening.md` "Salary period"): hour 2080, day 260,
week 52, month 12. Currencies convert through `rates.json` beside this script.

stdin: {"min": {"currency": "USD", "monthly": "5000", "annual": "60000"},
        "rows": [{"url": "...", "salary": "£80,000 - £100,000" | "—"}, ...]}
stdout: {"min_usd_year": 60000,
         "rows": [{"url": "...", "pay_usd_year": "107000-134000" | "—", "below_min": false}, ...]}
in input order, or {"pay_error": "..."} with exit 1. An unparseable phrase, an
unknown currency or an empty min is "—" / below_min false: unknown pay never drops.
The floor is min.annual in USD; min.monthly × 12 must match it within 12.
"""

import json
import math
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

FACTORS = {"hour": 2080, "day": 260, "week": 52, "month": 12, "year": 1}
SYMBOLS = (("R$", "BRL"), ("CA$", "CAD"), ("C$", "CAD"), ("A$", "AUD"), ("AU$", "AUD"),
           ("NZ$", "NZD"), ("S$", "SGD"), ("MX$", "MXN"), ("HK$", "HKD"),
           ("$", "USD"), ("£", "GBP"), ("€", "EUR"), ("₹", "INR"))

# a space, no-break space, narrow no-break space or apostrophe may group thousands ("6 257", "120'000");
# a digit glued to a letter ("B2B", "Q3") is not a figure
NUMBER = re.compile(r"(?<![A-Za-z])(\d{1,3}(?:[ \u00a0\u202f'\u2019]\d{3})+(?![\d.,])|\d[\d.,]*\d|\d)\s*([kKmM](?![A-Za-z]))?")
RANGE_GAP = re.compile(r"^\s*(?:-|\u2013|to)\s*$", re.IGNORECASE)
SCHEDULE_BEFORE = re.compile(r"\b(?:hours?|hrs?)\s*$", re.IGNORECASE)
CLAUSE_JOINER = re.compile(r"(?:[+;,()]|\b(?:plus|and|or)\b)", re.IGNORECASE)
BONUS_LABEL = re.compile(r"\bbonus\b", re.IGNORECASE)
CURRENCY_TOKEN = re.compile("|".join(re.escape(symbol) for symbol, _ in SYMBOLS)
                            + r"|US\$|(?<![A-Za-z])[A-Z]{3}(?![A-Za-z])")
CODE_BEFORE = re.compile(r"(?<![A-Za-z])([A-Z]{3})\s*$")
CODE_AFTER = re.compile(r"^\s*([A-Z]{3})(?![A-Za-z])")
PERIOD_AFTER_MARK = re.compile(
    r"(?:/|\bper\b|\ba\b)\s*(hour|hr|h|hora|day|dia|week|wk|semana|month|mo|mes|mês"
    r"|year|yr|annum|ano)\b", re.IGNORECASE)
PERIOD_ADJECTIVE = re.compile(
    r"\b(hourly|daily|weekly|monthly|yearly|annual|annually|p\.a\.?)(?![A-Za-z])", re.IGNORECASE)
PERIODS = {
    "hour": "hour", "hr": "hour", "h": "hour", "hora": "hour", "hourly": "hour",
    "day": "day", "dia": "day", "daily": "day",
    "week": "week", "wk": "week", "semana": "week", "weekly": "week",
    "month": "month", "mo": "month", "mes": "month", "mês": "month", "monthly": "month",
    "year": "year", "yr": "year", "annum": "year", "ano": "year", "yearly": "year",
    "annual": "year", "annually": "year", "p.a": "year", "p.a.": "year",
}


def parse_amount(token: str, scale: float = 1) -> Optional[float]:
    thousands_k = scale > 1
    text = re.sub(r"[ \u00a0\u202f'\u2019]", "", token.strip())
    if "," in text and "." in text:
        decimal = "," if text.rfind(",") > text.rfind(".") else "."
        thousands = "." if decimal == "," else ","
        text = text.replace(thousands, "").replace(decimal, ".")
    else:
        for sep in (",", "."):
            if sep not in text:
                continue
            tail = text.split(sep)[-1]
            if text.count(sep) > 1 or (len(tail) == 3 and not thousands_k):
                text = text.replace(sep, "")
            else:
                text = text.replace(sep, ".")
            break
    try:
        value = float(text)
    except ValueError:
        return None
    return value * scale


def currency_before(prefix: str) -> str:
    stripped = prefix.rstrip()
    if stripped.endswith("US$"):
        return "USD"
    for symbol, code in SYMBOLS:
        if stripped.endswith(symbol):
            return code
    match = CODE_BEFORE.search(stripped)
    return match.group(1) if match else ""


def printed_period(segment: str, tail: str) -> str:
    """Read the period from one wage group's bounded suffix, then its prefix."""
    for text in (tail, segment):
        for pattern in (PERIOD_AFTER_MARK, PERIOD_ADJECTIVE):
            for match in pattern.finditer(text):
                if pattern is PERIOD_AFTER_MARK and SCHEDULE_BEFORE.search(text[: match.start()]):
                    continue  # "hrs/week", "hours per week": a schedule, not a pay period
                if (match.group(1).lower() in ("annual", "annually")
                        and re.match(r"\s+(?:leave|bonus)\b", text[match.end():], re.IGNORECASE)):
                    continue  # "annual leave" and "annual bonus" are not salary periods
                return PERIODS[match.group(1).lower()]
    return ""


def guessed_period(largest_usd: float) -> str:
    if largest_usd >= 20000:
        return "year"
    if largest_usd >= 1000:
        return "month"
    return "hour"


def figures(phrase: str, rates: Optional[Dict[str, float]] = None) -> List[Tuple[float, str, str]]:
    rates = rates or {}
    out: List[Tuple[float, str, str]] = []
    for segment in re.split(r"[;\n|]", phrase):
        found: List[dict] = []
        for match in NUMBER.finditer(segment):
            mark = (match.group(2) or "").lower()
            if match.group(1) == "401" and (mark == "k" or re.match(r"\(k\)", segment[match.end():], re.IGNORECASE)):
                continue  # a retirement plan, not pay
            scale = {"k": 1000, "m": 1000000}.get(mark, 1)
            currency = currency_before(segment[: match.start()])
            if not currency:
                after = CODE_AFTER.match(segment[match.end():])
                currency = after.group(1) if after else ""
            found.append({"token": match.group(1), "scale": scale, "currency": currency,
                          "start": match.start(), "end": match.end()})
        links = [bool(RANGE_GAP.match(CURRENCY_TOKEN.sub("", segment[left["end"]:right["start"]])))
                 for left, right in zip(found, found[1:])]
        for index, linked in enumerate(links):  # the high end's k/M reaches a small low end
            left, right = found[index], found[index + 1]
            low = parse_amount(left["token"], 1)
            if linked and left["scale"] == 1 and right["scale"] > 1 and low is not None and low < 1000:
                left["scale"] = right["scale"]
        changed = True
        while changed:  # a range joins a bare number to a figure that carries a currency
            changed = False
            for index, linked in enumerate(links):
                left, right = found[index], found[index + 1]
                if linked and bool(left["currency"]) != bool(right["currency"]):
                    left["currency"] = right["currency"] = left["currency"] or right["currency"]
                    changed = True
        start = 0
        for end in range(len(found)):
            if end < len(links) and links[end]:
                continue
            # A range shares its period; unrelated amounts have separate contexts.
            previous_end = found[start - 1]["end"] if start else 0
            next_start = found[end + 1]["start"] if end + 1 < len(found) else len(segment)
            before = segment[previous_end:found[start]["start"]]
            after = segment[found[end]["end"]:next_start]
            prefix_parts = CLAUSE_JOINER.split(before)
            prefix = prefix_parts[-1] if len(prefix_parts) > 1 or start == 0 else ""
            suffix = CLAUSE_JOINER.split(after)[0]
            counted = [fig for fig in found[start:end + 1] if fig["currency"]]
            start = end + 1
            if BONUS_LABEL.search(prefix) or BONUS_LABEL.search(suffix):
                continue
            values = [(parse_amount(fig["token"], fig["scale"]), fig["currency"]) for fig in counted]
            values = [(amount, currency) for amount, currency in values if amount is not None]
            if not values:
                continue
            period = printed_period(prefix, suffix)
            if not period:
                largest = max(amount * rates.get(currency, 1.0) for amount, currency in values)
                if largest < 10:
                    continue  # a lone figure this small is no wage
                period = guessed_period(largest)
            out.extend((amount, currency, period) for amount, currency in values)
    return out


def yearly_usd(amount: float, currency: str, period: str, rates: Dict[str, float]) -> Optional[int]:
    rate = rates.get(currency)
    factor = FACTORS.get(period)
    if rate is None or factor is None:
        return None
    return int(math.floor(amount * factor * rate / 100.0 + 0.5)) * 100


def min_usd_year(floor: object, rates: Dict[str, float]) -> Optional[int]:
    if not isinstance(floor, dict):
        raise ValueError("min must be an object with currency, monthly and annual")
    raw = {key: floor.get(key) for key in ("currency", "monthly", "annual")}
    for key in ("monthly", "annual"):
        if isinstance(raw[key], bool) or not isinstance(raw[key], (str, int, float)):
            raise ValueError("min: {0} must be a number or string".format(key))
    if not isinstance(raw["currency"], str):
        raise ValueError("min: currency must be a string")
    text = {key: str(value).strip() for key, value in raw.items()}
    filled = [part for part in text.values() if part]
    if not filled:
        return None
    if len(filled) < 3:
        raise ValueError("min: currency, monthly and annual must all be set, or all empty")
    amounts = {}
    for key in ("monthly", "annual"):
        amounts[key] = float(raw[key]) if not isinstance(raw[key], str) else parse_amount(text[key])
        if amounts[key] is None:
            raise ValueError("min: {0} {1!r} is not a number".format(key, text[key]))
    code = dict(SYMBOLS).get(text["currency"], text["currency"].upper())
    if code not in rates:
        raise ValueError("min: unknown currency {0!r}".format(text["currency"]))
    if abs(amounts["monthly"] * 12 - amounts["annual"]) > 12:
        raise ValueError("min: monthly × 12 must equal annual")
    return yearly_usd(amounts["annual"], code, "year", rates)


def pay_payload(payload: object, rates: Dict[str, float]) -> Tuple[int, Dict[str, object]]:
    shape = "stdin must be an object with a min object and a rows array of {url, salary} strings"
    if not isinstance(payload, dict):
        return 1, {"pay_error": shape}
    rows = payload.get("rows")
    if not isinstance(rows, list) or "min" not in payload:
        return 1, {"pay_error": shape}
    try:
        floor = min_usd_year(payload["min"], rates)
    except ValueError as error:
        return 1, {"pay_error": str(error)}
    out: List[Dict[str, object]] = []
    for index, row in enumerate(rows):
        if (not isinstance(row, dict) or not isinstance(row.get("url"), str)
                or not isinstance(row.get("salary"), str)):
            return 1, {"pay_error": "rows[{0}]: need string url and salary".format(index)}
        values = [
            value for value in (
                yearly_usd(amount, currency, period, rates)
                for amount, currency, period in figures(row["salary"], rates))
            if value is not None
        ]
        if not values:
            out.append({"url": row["url"], "pay_usd_year": "—", "below_min": False})
            continue
        low, high = min(values), max(values)
        out.append({
            "url": row["url"],
            "pay_usd_year": str(high) if low == high else "{0}-{1}".format(low, high),
            "below_min": floor is not None and high < floor,
        })
    return 0, {"min_usd_year": floor, "rows": out}


def main() -> int:
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        rates = json.loads(Path(__file__).with_name("rates.json").read_text(encoding="utf-8"))["usd_per"]
    except (json.JSONDecodeError, UnicodeDecodeError, OSError, KeyError, TypeError) as error:
        code, result = 1, {"pay_error": "invalid input or rates.json: {0}".format(error)}
    else:
        code, result = pay_payload(payload, rates)
    text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()
    return code


if __name__ == "__main__":
    raise SystemExit(main())

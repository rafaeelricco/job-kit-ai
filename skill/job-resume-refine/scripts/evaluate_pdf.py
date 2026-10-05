#!/usr/bin/env python3
"""Evaluate a compiled resume PDF against a source-grounded manifest."""
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import unicodedata

from check_parse import extract, normalize


SCHEMA_VERSION = 1
_LIGATURES = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "st",
    "\ufb06": "st",
}


def _canonical(value):
    """Apply shared body whitespace, quote and dash folds after NFC."""
    return normalize(unicodedata.normalize("NFC", value))


def _term_normalize(value):
    """Normalize term whitespace while preserving every punctuation mark."""
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", value)).strip()


def _issue(severity, code, message, **extra):
    item = {"severity": severity, "code": code, "message": message}
    for key, value in extra.items():
        if value is not None:
            item[key] = value
    return item


def _validate_expected(expected):
    """Return ``(message, terms)`` after validating a manifest's shape."""
    if not isinstance(expected, dict):
        return "expected must be an object", []
    unknown = set(expected) - {"schema_version", "blocks", "terms"}
    if unknown:
        return "unknown expected keys: {}".format(
            ", ".join(sorted(str(key) for key in unknown))
        ), []
    if type(expected.get("schema_version")) is not int:
        return "schema_version must be integer 1", []
    if expected.get("schema_version") != SCHEMA_VERSION:
        return "schema_version must be integer 1", []
    blocks = expected.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return "blocks must be a non-empty array", []
    seen_ids = set()
    for index, block in enumerate(blocks):
        if not isinstance(block, dict):
            return "blocks[{}] must be an object".format(index), []
        unknown = set(block) - {"id", "parts"}
        if unknown:
            return "unknown block keys at {}: {}".format(
                index, ", ".join(sorted(str(key) for key in unknown))
            ), []
        block_id = block.get("id")
        if not isinstance(block_id, str) or not block_id.strip():
            return "blocks[{}].id must be a non-empty string".format(index), []
        if _has_invalid_control(block_id):
            return "blocks[{}].id contains a control character".format(index), []
        if block_id in seen_ids:
            return "block ids must be unique", []
        seen_ids.add(block_id)
        parts = block.get("parts")
        if not isinstance(parts, list) or not parts:
            return "blocks[{}].parts must be a non-empty array".format(index), []
        for part_index, part in enumerate(parts):
            if not isinstance(part, str) or not part.strip():
                return (
                    "blocks[{}].parts[{}] must be a non-empty string".format(
                        index, part_index
                    ),
                    [],
                )
            if _has_invalid_control(part):
                return (
                    "blocks[{}].parts[{}] contains a control character".format(
                        index, part_index
                    ),
                    [],
                )
    terms = expected.get("terms")
    if not isinstance(terms, list) or not all(isinstance(term, str) for term in terms):
        return "terms must be an array of strings", []

    canonical_terms = []
    seen_terms = set()
    for term in terms:
        if not term.strip():
            return "terms cannot contain empty strings", []
        if _has_invalid_control(term):
            return "terms cannot contain control characters", []
        folded = _literal_casefold(_term_normalize(term))
        if not folded:
            return "terms cannot contain empty strings", []
        if folded not in seen_terms:
            seen_terms.add(folded)
            canonical_terms.append((_term_normalize(term), term))
    return None, canonical_terms


def _has_invalid_control(value):
    """Reject C0/C1 controls while permitting ordinary expected line wraps."""
    return any(
        unicodedata.category(char) == "Cs"
        or (unicodedata.category(char) == "Cc" and char not in "\t\n\r\f")
        for char in value
    )


class _Source:
    def __init__(self, raw):
        self.raw = raw
        self.raw_nfc = unicodedata.normalize("NFC", raw)
        marked = self.raw_nfc
        # Use a fresh private-use marker. A literal private-use character in
        # PDF text must remain source text and must never be mistaken for a
        # marker inserted for a line-wrap hyphen.
        self.marker = next(
            chr(codepoint)
            for codepoint in range(0xF0000, 0xFFFFE)
            if chr(codepoint) not in marked
        )
        marked = marked.replace("-\r\n", "-" + self.marker)
        marked = marked.replace("-\n", "-" + self.marker)
        marked = marked.replace("-\r", "-" + self.marker)
        marked = marked.replace("-\f", "-" + self.marker)
        self.canonical = normalize(marked)
        self.nfc_raw_spans = self._map_spans(self.raw, self.raw_nfc)
        self.canonical_raw_spans = []
        for start, end in self._map_spans(self.raw_nfc, self.canonical):
            spans = self.nfc_raw_spans[start:end]
            if not spans:
                spans = self.nfc_raw_spans[max(0, start - 1):start + 1]
            self.canonical_raw_spans.append((spans[0][0], spans[-1][1]))

    @staticmethod
    def _map_spans(source, target):
        """Retain whole source spans, including composed combining marks."""
        mapping = []
        matcher = difflib.SequenceMatcher(None, source, target, autojunk=False)
        for tag, raw_start, raw_end, target_start, target_end in matcher.get_opcodes():
            if tag == "equal":
                mapping.extend((index, index + 1) for index in range(raw_start, raw_end))
                continue
            mapping.extend([(raw_start, raw_end)] * (target_end - target_start))
        return mapping

    def page_for_raw_index(self, index):
        return self.raw.count("\f", 0, max(0, index)) + 1

    def excerpt(self, index):
        left = max(0, index - 32)
        right = min(len(self.raw), index + 33)
        return self.raw[left:right]

    def location(self, span):
        """Return a page and excerpt for a canonical source span."""
        if not self.raw:
            return {}
        raw_start, raw_end = self._raw_bounds(span)
        page = self.raw.count("\f", 0, raw_start) + 1
        excerpt_start = max(0, raw_start - 32)
        excerpt_end = min(len(self.raw), raw_end + 32)
        return {"page": page, "excerpt": self.raw[excerpt_start:excerpt_end]}

    def _raw_bounds(self, span):
        start, end = span
        mapped = self.canonical_raw_spans[start:end]
        return (mapped[0][0], mapped[-1][1]) if mapped else (0, 0)

    def location_raw(self, span):
        """Return a page and excerpt for offsets in NFC source text."""
        start, end = span
        if self.raw:
            spans = self.nfc_raw_spans[start:end]
            raw_start, raw_end = (spans[0][0], spans[-1][1]) if spans else (0, 0)
        else:
            raw_start = raw_end = 0
        page = self.raw.count("\f", 0, raw_start) + 1
        excerpt_start = max(0, raw_start - 32)
        excerpt_end = min(len(self.raw), raw_end + 32)
        return {"page": page, "excerpt": self.raw[excerpt_start:excerpt_end]}

    def needs_normalization(self, span, part):
        """Whether a body span depended on NFC, folding, or whitespace folding."""
        start, end = self._raw_bounds(span)
        segment = self.raw[start:end].strip()
        return segment != part.strip() and _canonical(segment) == _canonical(part)

    def relaxed_source(self):
        """Return source with whitespace removed and canonical offsets retained."""
        regular = self.canonical.replace(self.marker, " ")
        text = []
        mapping = []
        for index, char in enumerate(regular):
            if char.isspace():
                continue
            text.append(char)
            mapping.append(index)
        return "".join(text), mapping


def _source_anomaly_issues(source):
    issues = []
    for index, char in enumerate(source.raw):
        codepoint = ord(char)
        if (codepoint < 32 and char not in "\t\n\r\f") or 0x7F <= codepoint <= 0x9F:
            issues.append(
                _issue(
                    "error",
                    "unexpected_control",
                    "unexpected control character U+{:04X}".format(codepoint),
                    page=source.page_for_raw_index(index),
                    excerpt=source.excerpt(index),
                )
            )
        elif char == "\ufffd":
            issues.append(
                _issue(
                    "warning",
                    "replacement_character",
                    "replacement character in extracted text",
                    page=source.page_for_raw_index(index),
                    excerpt=source.excerpt(index),
                )
            )
        elif unicodedata.category(char) == "Co":
            issues.append(
                _issue(
                    "warning",
                    "private_use_character",
                    "private-use character U+{:04X} in extracted text".format(codepoint),
                    page=source.page_for_raw_index(index),
                    excerpt=source.excerpt(index),
                )
            )
        elif char in _LIGATURES:
            issues.append(
                _issue(
                    "warning",
                    "ligature_expansion",
                    "expanded ligature U+{:04X} for body matching".format(codepoint),
                    page=source.page_for_raw_index(index),
                    excerpt=source.excerpt(index),
                )
            )
    return issues


def _find_part_occurrences(source, part):
    canonical_part = _canonical(part)
    needle = "".join(_LIGATURES.get(char, char) for char in canonical_part)
    expected_ligature = needle != canonical_part
    if not needle:
        return []
    found = {}
    for start in range(len(source.canonical)):
        match = _match_flexible_at(source, start, needle)
        if match is None:
            continue
        end, ligature, dehyphenated, wrapped_hyphen = match
        if (
            needle
            and _is_word_char(needle[0])
            and start > 0
            and _is_word_char(source.canonical[start - 1])
        ) or (
            needle
            and _is_word_char(needle[-1])
            and end < len(source.canonical)
            and _is_word_char(source.canonical[end])
        ):
            continue
        span = (start, end)
        key = span
        candidate = {
            "start": span[0],
            "end": span[1],
            "ligature": ligature or expected_ligature,
            "dehyphenated": dehyphenated,
            "wrapped_hyphen": wrapped_hyphen,
            "normalized": source.needs_normalization(span, part),
        }
        old = found.get(key)
        if old is None or (
            (not candidate["dehyphenated"], not candidate["ligature"])
            > (not old["dehyphenated"], not old["ligature"])
        ):
            found[key] = candidate
    return sorted(found.values(), key=lambda item: (item["end"], item["start"]))


def _relaxed_part_occurrences(source, part):
    """Find whitespace split/glued explanations without affecting matching."""
    hay, mapping = source.relaxed_source()
    needle = "".join(char for char in _canonical(part) if not char.isspace())
    if not needle:
        return []
    found = []
    start = 0
    while True:
        start = hay.find(needle, start)
        if start < 0:
            break
        end = start + len(needle)
        found.append((mapping[start], mapping[end - 1] + 1))
        start += 1
    return found


def _relaxed_term_occurrence(source, term):
    """Find a diagnostic-only whitespace split/glued term occurrence."""
    compact = []
    mapping = []
    for index, char in enumerate(source.raw_nfc):
        if char.isspace():
            continue
        folded = _literal_casefold(char)
        compact.append(folded)
        mapping.extend([index] * len(folded))
    needle = "".join(char for char in _term_normalize(term) if not char.isspace())
    folded_hay = "".join(compact)
    folded_needle = _literal_casefold(needle)
    start = 0
    while True:
        start = folded_hay.find(folded_needle, start)
        if start < 0:
            return None
        end = start + len(folded_needle)
        raw_start, raw_end = mapping[start], mapping[end - 1] + 1
        segment = source.raw_nfc[raw_start:raw_end]
        before = source.raw_nfc[raw_start - 1] if raw_start else ""
        after = source.raw_nfc[raw_end] if raw_end < len(source.raw_nfc) else ""
        if (_literal_casefold(_term_normalize(segment)) != _literal_casefold(_term_normalize(term))
                or before.isalnum() or after.isalnum()):
            return raw_start, raw_end
        start += 1


def _match_flexible_at(source, start, needle):
    """Match one body part while deciding each source line-wrap hyphen.

    A source ``-`` followed by the inserted line-wrap marker can contribute a
    literal hyphen or can be omitted for a discretionary word wrap. The
    expected part controls that choice character by character, which permits a
    part containing both real and discretionary hyphens.
    """
    index = start
    expected_index = 0
    used_ligature = False
    used_dehyphenation = False
    wrapped_hyphen = False
    canonical = source.canonical
    while expected_index < len(needle):
        if index >= len(canonical):
            return None
        char = canonical[index]
        if (
            char == "-"
            and index + 1 < len(canonical)
            and canonical[index + 1] == source.marker
        ):
            wrapped_hyphen = True
            if needle[expected_index] == "-":
                expected_index += 1
            else:
                if (
                    expected_index == 0
                    or not _is_word_char(needle[expected_index - 1])
                    or not _is_word_char(needle[expected_index])
                ):
                    return None
                used_dehyphenation = True
            index += 2
            while index < len(canonical) and canonical[index].isspace():
                index += 1
            continue
        replacement = _LIGATURES.get(char)
        if replacement is not None:
            if needle.startswith(replacement, expected_index):
                expected_index += len(replacement)
                used_ligature = True
                index += 1
                continue
        if char != needle[expected_index]:
            return None
        expected_index += 1
        index += 1
    return index, used_ligature, used_dehyphenation, wrapped_hyphen


def _overlaps(left, right):
    return left["start"] < right["end"] and right["start"] < left["end"]


def _find_group(occurrences, cursor, excluded=None):
    excluded = excluded or []
    available = []
    for options in occurrences:
        values = [
            item
            for item in options
            if item["start"] >= cursor
            and not any(_overlaps(item, used) for used in excluded)
        ]
        if not values:
            return None
        available.append(values)

    order = sorted(range(len(available)), key=lambda index: len(available[index]))
    best = None
    best_key = None

    def visit(depth, chosen):
        nonlocal best, best_key
        if depth == len(order):
            starts = [item["start"] for item in chosen]
            ends = [item["end"] for item in chosen]
            key = (max(ends), min(starts))
            if best_key is None or key < best_key:
                best_key = key
                best = list(chosen)
            return
        part_index = order[depth]
        for candidate in available[part_index]:
            if any(_overlaps(candidate, selected) for selected in chosen):
                continue
            if best_key is not None and candidate["end"] > best_key[0]:
                continue
            visit(depth + 1, chosen + [candidate])

    visit(0, [])
    return best


def _body_issue_for_missing(source, block, part, cursor, occurrences):
    all_occurrences = [item for options in occurrences for item in options]
    if any(item["end"] <= cursor for item in all_occurrences):
        return _issue(
            "error",
            "out_of_order_block_part",
            "block part appears before the preceding block: {!r}".format(part),
            block_id=block["id"],
            **source.location((all_occurrences[0]["start"], all_occurrences[0]["end"]))
        )
    if all_occurrences:
        return _issue(
            "error", "unassigned_block_part",
            "cannot assign this part to a complete non-overlapping block: {!r}".format(part),
            block_id=block["id"],
            **source.location((all_occurrences[0]["start"], all_occurrences[0]["end"]))
        )
    return _issue(
        "error",
        "missing_block_part",
        "missing block part: {!r}".format(part),
        block_id=block["id"],
    )


def _is_word_char(char):
    return bool(char) and (char.isalnum() or char == "_")


def _term_boundary(hay, start, end):
    before = hay[start - 1] if start else ""
    after = hay[end] if end < len(hay) else ""
    if _is_word_char(before) or _is_word_char(after):
        return False
    if before and before in "+#":
        return False
    if after and after in "+#":
        return False
    if before and before in "&-" and start >= 2 and _is_word_char(hay[start - 2]):
        return False
    if after and after in "&-" and end + 1 < len(hay) and _is_word_char(hay[end + 1]):
        return False
    # A line wrap cannot turn a compound's prefix or suffix into a term hit.
    if after == "-" and hay[end + 1:].lstrip()[:1].isalnum():
        return False
    prefix = hay[:start].rstrip()
    if before.isspace() and len(prefix) >= 2 and prefix[-1] == "-" and _is_word_char(prefix[-2]):
        return False
    if before == ".":
        return False
    if after == "." and end + 1 < len(hay) and _is_word_char(hay[end + 1]):
        return False
    return True


def _term_matches(hay, term):
    folded_hay = _literal_casefold(hay)
    folded_term = _literal_casefold(term)
    start = 0
    while True:
        start = folded_hay.find(folded_term, start)
        if start < 0:
            return False
        end = start + len(folded_term)
        if _term_boundary(folded_hay, start, end):
            return True
        start += 1


def _literal_casefold(value):
    """Case-fold without Unicode's compatibility expansion of ligatures."""
    return "".join(
        char if char in _LIGATURES else char.casefold() for char in value
    )


def _mode_error(message, expected=None, severity="error", code="evaluation_error"):
    blocks = expected.get("blocks") if isinstance(expected, dict) else None
    terms = expected.get("terms") if isinstance(expected, dict) else None
    total_blocks = len(blocks) if isinstance(blocks, list) else 0
    unique_terms = set()
    if isinstance(terms, list):
        unique_terms = {
            _literal_casefold(_term_normalize(term))
            for term in terms
            if isinstance(term, str)
        }
    return {
        "verdict": "ERROR",
        "blocks": {"recovered": 0, "total": total_blocks},
        "terms": {"matched": 0, "total": len(unique_terms)},
        "issues": [_issue(severity, code, message)],
    }


def evaluate_text(text, expected):
    """Evaluate one pdftotext text stream and return a mode-shaped result."""
    message, canonical_terms = _validate_expected(expected)
    if message is not None:
        return _mode_error(message, expected)
    if not isinstance(text, str):
        return _mode_error("extracted text must be a string", expected)

    source = _Source(text)
    issues = _source_anomaly_issues(source)
    if not source.canonical.replace(source.marker, " ").strip():
        issues.append(_issue("error", "empty_extraction", "pdftotext returned no text"))

    cursor = 0
    recovered = 0
    consumed = []
    recovered_ids = set()
    blocks = expected["blocks"]
    block_occurrences = []
    for block in blocks:
        occurrences = [_find_part_occurrences(source, part) for part in block["parts"]]
        block_occurrences.append(occurrences)
        group = _find_group(occurrences, cursor)
        if group is None:
            for part, part_occurrences in zip(block["parts"], occurrences):
                relaxed = _relaxed_part_occurrences(source, part) if not part_occurrences else []
                if relaxed:
                    nearest = next((span for span in relaxed if span[0] >= cursor), relaxed[0])
                    location = source.location(nearest)
                    issues.append(
                        _issue(
                            "warning",
                            "relaxed_spacing_diagnostic",
                            "possible word-spacing issue; relaxed match does not establish recovery",
                            block_id=block["id"],
                            **location
                        )
                    )
                issues.append(
                    _body_issue_for_missing(source, block, part, cursor, [part_occurrences])
                )
            # Continue collecting diagnostics and any later recoverable
            # groups. The missing earlier group remains a hard failure and
            # cannot be bypassed by a later block.
            continue
        recovered += 1
        recovered_ids.add(block["id"])
        consumed.extend(group)
        cursor = max(item["end"] for item in group)
        for item in group:
            location = source.location((item["start"], item["end"]))
            if item["normalized"]:
                issues.append(
                    _issue(
                        "warning",
                        "body_normalization",
                        "body match depended on NFC, punctuation, or whitespace normalization",
                        block_id=block["id"],
                        **location
                    )
                )
            if item["ligature"]:
                issues.append(
                    _issue(
                        "warning",
                        "ligature_expansion",
                        "body match used a ligature expansion",
                        block_id=block["id"],
                        **location
                    )
                )
            if item["dehyphenated"]:
                issues.append(
                    _issue(
                        "warning",
                        "source_dehyphenation",
                        "body match used a source line-wrap hyphenation",
                        block_id=block["id"],
                        **location
                    )
                )
            elif item["wrapped_hyphen"]:
                issues.append(_issue(
                    "warning", "source_hyphen_wrap",
                    "body match retained a source hyphen across a line break",
                    block_id=block["id"], **location
                ))

    for block, occurrences in zip(blocks, block_occurrences):
        if block["id"] not in recovered_ids:
            continue
        extra = _find_group(occurrences, 0, excluded=consumed)
        if extra:
            start = min(item["start"] for item in extra)
            end = max(item["end"] for item in extra)
            issues.append(
                _issue(
                    "error",
                    "extra_block_occurrence",
                    "additional complete block occurrence remains after assignment",
                    block_id=block["id"],
                    **source.location((start, end))
                )
            )

    regular_hay = _term_normalize(source.raw)
    matched_terms = 0
    for canonical_term, original_term in canonical_terms:
        if _term_matches(regular_hay, canonical_term):
            matched_terms += 1
        else:
            relaxed = _relaxed_term_occurrence(source, original_term)
            if relaxed:
                issues.append(
                    _issue(
                        "warning",
                        "relaxed_spacing_term_diagnostic",
                        "possible word-spacing issue; relaxed match does not establish an exact hit",
                        term=original_term,
                        **source.location_raw(relaxed)
                    )
                )
            issues.append(
                _issue("error", "missing_term", "missing term: {!r}".format(original_term), term=original_term)
            )

    if recovered != len(blocks) or matched_terms != len(canonical_terms):
        verdict = "FAIL"
    elif any(item["severity"] == "error" for item in issues):
        verdict = "FAIL"
    else:
        verdict = "PASS"
    return {
        "verdict": verdict,
        "blocks": {"recovered": recovered, "total": len(blocks)},
        "terms": {"matched": matched_terms, "total": len(canonical_terms)},
        "issues": issues,
    }


def _tool_version():
    try:
        result = subprocess.run(
            ["pdftotext", "-v"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=5,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired, UnicodeDecodeError):
        return None
    if result.returncode != 0:
        return None
    output = result.stderr or result.stdout or ""
    for line in output.splitlines():
        line = line.strip()
        if line and "version" in line.lower():
            return line
    return None


def _top_error(expected, message, pdf_sha256=None, tool_version=None, modes=None):
    return {
        "schema_version": SCHEMA_VERSION,
        "verdict": "ERROR",
        "pdf_sha256": pdf_sha256,
        "expected": expected,
        "tool": {"name": "pdftotext", "version": tool_version},
        "modes": modes or {},
        "issues": [_issue("error", "evaluation_error", message)],
    }


def evaluate_pdf(pdf_path, expected):
    """Extract and evaluate both pdftotext modes for one absolute PDF path."""
    message, _ = _validate_expected(expected)
    if message is not None:
        return _top_error(expected, message)
    if not isinstance(pdf_path, (str, bytes, os.PathLike)):
        return _top_error(expected, "pdf path must be a path")
    pdf_path = os.fspath(pdf_path)
    if not os.path.isabs(pdf_path):
        return _top_error(expected, "pdf path must be absolute")
    try:
        with open(pdf_path, "rb") as handle:
            pdf_bytes = handle.read()
    except (OSError, TypeError, ValueError) as error:
        return _top_error(expected, "unable to read PDF: {}".format(error))
    pdf_sha256 = hashlib.sha256(pdf_bytes).hexdigest()
    version = _tool_version()
    modes = {}
    for mode_name, layout in (("default", False), ("layout", True)):
        try:
            text = extract(pdf_path, layout=layout)
        except FileNotFoundError as error:
            modes[mode_name] = _mode_error("pdftotext is not installed: {}".format(error), expected)
        except (RuntimeError, OSError, UnicodeDecodeError) as error:
            modes[mode_name] = _mode_error(str(error), expected)
        else:
            modes[mode_name] = evaluate_text(text, expected)

    top_issues = []
    for mode_name in ("default", "layout"):
        for issue in modes[mode_name]["issues"]:
            item = dict(issue)
            item["mode"] = mode_name
            top_issues.append(item)
    if modes["default"]["verdict"] == "ERROR" or modes["layout"]["verdict"] == "ERROR":
        verdict = "ERROR"
    else:
        verdict = "PASS" if all(
            modes[name]["verdict"] == "PASS" for name in ("default", "layout")
        ) else "FAIL"
        if modes["default"]["verdict"] != modes["layout"]["verdict"]:
            top_issues.append(
                _issue(
                    "error",
                    "mode_disagreement",
                    "default and layout extraction modes disagree",
                )
            )
        elif _mode_signature(modes["default"]) != _mode_signature(modes["layout"]):
            top_issues.append(
                _issue(
                    "warning",
                    "mode_diagnostic_difference",
                    "default and layout evaluation diagnostics differ",
                )
            )
    return {
        "schema_version": SCHEMA_VERSION,
        "verdict": verdict,
        "pdf_sha256": pdf_sha256,
        "expected": expected,
        "tool": {"name": "pdftotext", "version": version},
        "modes": modes,
        "issues": top_issues,
    }


def _mode_signature(mode):
    """Compare semantic recovery diagnostics, ignoring raw layout whitespace."""
    diagnostics = tuple(
        (
            item.get("severity"),
            item.get("code"),
            item.get("block_id"),
            item.get("term"),
        )
        for item in mode.get("issues", [])
        if item.get("severity") == "error"
    )
    return mode.get("verdict"), mode.get("blocks"), mode.get("terms"), diagnostics


def main():
    try:
        payload = getattr(sys.stdin, "buffer", sys.stdin).read()
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        expected = json.loads(payload, parse_constant=_invalid_json_constant)
    except (ValueError, UnicodeDecodeError) as error:
        _emit(_top_error(None, "invalid JSON: {}".format(error)))
        return 2
    if len(sys.argv) != 2:
        _emit(_top_error(expected, "usage: evaluate_pdf.py <absolute-pdf>"))
        return 2
    result = evaluate_pdf(sys.argv[1], expected)
    _emit(result)
    return {"PASS": 0, "FAIL": 1, "ERROR": 2}.get(result["verdict"], 2)


def _emit(payload):
    # Escaping also keeps ERROR reports valid when invalid input contains a
    # lone surrogate escaped inside otherwise valid JSON.
    json.dump(payload, sys.stdout, ensure_ascii=True, sort_keys=False)
    sys.stdout.write("\n")


def _invalid_json_constant(value):
    raise ValueError("invalid JSON constant: " + value)


if __name__ == "__main__":
    raise SystemExit(main())

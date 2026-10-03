import os
import tempfile
import unittest
from typing import Callable, List, Tuple

from validate_dossier import validate, validate_payload

MARKER = "<!-- scout never writes below this line -->"

# A job-apply stub shaped like the real Cosuno dossier: no scout run, so no
# Verdict/Posting facts/The role/Provenance body, just the heading, the
# marker, and the append-only log below it.
CLEAN = """---
company: "Cosuno"
title: "Senior Full Stack Developer (TypeScript)"
url: "https://jobs.ashbyhq.com/cosuno/424ba681-0989-4961-82ad-10286e4aae71"
status: applied
first_seen: 2026-09-11
last_seen: 2026-09-11
score: —
bucket: unbucketed
channel: ats
---

# Cosuno — Senior Full Stack Developer (TypeScript)

<!-- scout never writes below this line -->

- 2026-09-11 · dossier opened by application, no scout run — job-apply
- 2026-09-11 · applied via ats — job-apply
"""


def identity(text: str) -> str:
    return text


def swap(old: str, new: str) -> Callable[[str], str]:
    """Replace the one occurrence of ``old`` in the fixture with ``new``."""

    def transform(text: str) -> str:
        assert text.count(old) == 1, "fixture drifted: {0!r} not found once".format(old)
        return text.replace(old, new, 1)

    return transform


def range_frontmatter(text: str) -> str:
    """2026-09-11 Range defect: the four keys folded into a `source` line."""
    block = (
        "first_seen: 2026-09-11\n"
        "last_seen: 2026-09-11\n"
        "score: —\n"
        "bucket: unbucketed\n"
    )
    assert block in text
    return text.replace(block, "source: jack-and-jill-web-sourced\n", 1)


def scout_dossier_with_verdict(text: str) -> str:
    """A scored, bucketed dossier with a scout `## Verdict` section above the marker."""
    text = swap("score: —", "score: 10")(text)
    text = swap("bucket: unbucketed", "bucket: direct")(text)
    verdict = "## Verdict\n\nStrong direct-hire match on required skills.\n\n"
    assert MARKER in text
    return text.replace(MARKER, verdict + MARKER, 1)


def drop_marker(text: str) -> str:
    assert text.count(MARKER + "\n\n") == 1
    return text.replace(MARKER + "\n\n", "", 1)


def double_marker(text: str) -> str:
    assert text.count(MARKER) == 1
    return text.replace(MARKER, MARKER + "\n" + MARKER, 1)


def double_status(text: str) -> str:
    assert text.count("status: applied") == 1
    return text.replace("status: applied", "status: applied\nstatus: new", 1)


def no_opening_fence(text: str) -> str:
    assert text.startswith("---\n")
    return text[len("---\n"):]


def outreach_record(text: str) -> str:
    """A job-outreach send: one log line and its blockquoted block below the marker."""
    assert text.endswith("applied via ats — job-apply\n")
    return text + (
        "- 2026-09-12 · outreach sent: first · account:a@x.com · thread:t1 — job-outreach\n"
        "\n"
        "#### Outreach 2026-09-12 · first\n"
        "\n"
        "> to: Ana Lima <ana@cosuno.com> · CTO\n"
        "> found: company site · https://cosuno.com/team\n"
        "> account: a@x.com\n"
        "> thread: t1\n"
        "> subject: Senior Full Stack Developer (TypeScript) at Cosuno\n"
        "> Hi Ana,\n"
    )


# (transform on CLEAN, expected errors). The first is the 2026-09-11 Range defect.
CASES: Tuple[Tuple[Callable[[str], str], List[str]], ...] = (
    (
        range_frontmatter,
        ["missing first_seen", "missing last_seen", "missing score", "missing bucket", "unknown key source"],
    ),
    (identity, []),
    (scout_dossier_with_verdict, []),
    (outreach_record, []),
    (swap("status: applied", "status: open"), ["status: not in new|applied|rejected|interview|offer|dropped"]),
    (swap("bucket: unbucketed", "bucket: EU"), ["bucket: not in direct|EOR|restricted-geo|unbucketed"]),
    (swap("channel: ats", "channel: —"), ["channel: not in ats|direct_email|dm_request|founder"]),
    (swap("first_seen: 2026-09-11", "first_seen: 2026-02-30"), ["first_seen: not YYYY-MM-DD"]),
    (swap("score: —", "score: 11"), ["score: not 0–10 or —"]),
    (swap('url: "https://', 'url: "ftp://'), ["url: not an http(s) url"]),
    (drop_marker, ["marker: expected once, found 0"]),
    (double_marker, ["marker: expected once, found 2"]),
    (double_status, ["frontmatter: duplicate key status"]),
    (
        no_opening_fence,
        [
            "frontmatter: no --- on line 1",
            "missing company",
            "missing title",
            "missing url",
            "missing status",
            "missing first_seen",
            "missing last_seen",
            "missing score",
            "missing bucket",
            "missing channel",
        ],
    ),
)


class ValidateTests(unittest.TestCase):
    def test_golden_table(self):
        for transform, expected in CASES:
            with self.subTest(transform=getattr(transform, "__name__", repr(transform))):
                self.assertEqual(validate(transform(CLEAN)), expected)


class PayloadTests(unittest.TestCase):
    def test_bad_shape(self):
        for payload in ({"paths": "x"}, [1]):
            with self.subTest(payload=payload):
                code, result = validate_payload(payload)
                self.assertEqual(code, 1)
                self.assertIn("paths array", str(result["validate_error"]))

    def test_missing_path_is_one_error(self):
        code, result = validate_payload({"paths": ["/no/such/file-does-not-exist.md"]})
        self.assertEqual(code, 0)
        errors = result["dossiers"][0]["errors"]
        self.assertEqual(len(errors), 1)
        self.assertTrue(errors[0].startswith("unreadable: "))

    def test_order_follows_input(self):
        with tempfile.TemporaryDirectory() as tmp:
            clean_path = os.path.join(tmp, "clean.md")
            broken_path = os.path.join(tmp, "broken.md")
            with open(clean_path, "w", encoding="utf-8") as handle:
                handle.write(CLEAN)
            with open(broken_path, "w", encoding="utf-8") as handle:
                handle.write(swap("status: applied", "status: open")(CLEAN))

            code, result = validate_payload({"paths": [broken_path, clean_path]})

            self.assertEqual(code, 0)
            self.assertEqual([d["path"] for d in result["dossiers"]], [broken_path, clean_path])
            self.assertEqual(
                result["dossiers"][0]["errors"],
                ["status: not in new|applied|rejected|interview|offer|dropped"],
            )
            self.assertEqual(result["dossiers"][1]["errors"], [])


if __name__ == "__main__":
    unittest.main()

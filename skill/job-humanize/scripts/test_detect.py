import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent
SCRIPT = SKILL_DIR / "scripts" / "detect.py"
sys.path.insert(0, str(SKILL_DIR / "scripts"))
import detect  # noqa: E402


def kinds(hits, kind):
    return [h for h in hits if h[2] == kind]


def sample_for(phrase):
    """The phrase as it would appear in prose: every placeholder becomes a word."""
    text = phrase.replace("…", " word")
    return re.sub(r"\b[XYZ]\b", "word", text)


class Phrases(unittest.TestCase):
    def test_every_skill_phrase_is_caught(self):
        phrases, _ = detect.load_skill()
        for phrase, rx in phrases:
            with self.subTest(phrase=phrase):
                text = f"Intro text {sample_for(phrase)} end."
                found = rx.search(text)
                self.assertIsNotNone(found)
                self.assertIn(found.group(0), [h[3] for h in kinds(detect.scan(text), "phrase")])

    def test_skill_yields_phrases_and_limit(self):
        phrases, limit = detect.load_skill()
        names = [p for p, _ in phrases]
        self.assertGreaterEqual(len(names), 70)
        self.assertIn("I hope this helps", names)
        self.assertNotIn("passionate, results-driven expert", names)
        self.assertNotIn("Signs of AI writing", names)
        self.assertEqual(limit, 25)

    def test_wrapped_phrase_inflection_and_case(self):
        for text in [
            "I hope this\nhelps you.",
            "We are leveraging it.",
            "We leveraged it.",
            "It runs seamlessly.",
            "You\u2019re absolutely right about that.",
            "In order to ship, we cut scope.",
        ]:
            with self.subTest(text=text):
                self.assertTrue(kinds(detect.scan(text), "phrase"))
        self.assertEqual(kinds(detect.scan("The unleveraged position held."), "phrase"), [])

    def test_placeholder_phrases_need_the_whole_word(self):
        for text in [
            "Nothing broke during the cutover, but we added alerts anyway.",
            "Notion held the runbook, but we moved it to the wiki.",
            "Stopwatch data was noisy, start times were wrong.",
            "Nobody paged. Nothing failed. Just a quiet release.",
        ]:
            with self.subTest(text=text):
                self.assertEqual(kinds(detect.scan(text), "phrase"), [])
        for text in ["Not speed, but safety.", "Stop guessing, start measuring.", "No meetings. No tickets. Just code."]:
            with self.subTest(text=text):
                self.assertTrue(kinds(detect.scan(text), "phrase"))

    def test_load_skill_rejects_a_skill_without_the_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "SKILL.md"
            path.write_text("# Nothing here\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                detect.load_skill(path)


class Structure(unittest.TestCase):
    def test_code_and_urls_ignored(self):
        text = (
            "```\n"
            "Certainly! leverage\n"
            "```\n"
            "Use `seamless` here. See https://example.com/pivotal-landscape or [docs](https://x.com/leverage).\n"
            "We delve deeper.\n"
        )
        self.assertEqual(detect.scan(text), [(5, 4, "phrase", "delve")])

    def test_url_keeps_its_period(self):
        _, limit = detect.load_skill()
        text = "See https://example.com/delve. " + " ".join(["word"] * (limit - 1)) + "."
        self.assertEqual(detect.scan(text, max_words=limit), [])

    def test_overlapping_hits_count_once(self):
        self.assertEqual(kinds(detect.scan("It shipped, showcasing speed."), "phrase"), [(1, 11, "phrase", ", showcasing")])

    def test_dashes_unless_allowed(self):
        self.assertEqual(len(kinds(detect.scan("a \u2014 b \u2013 c"), "dash")), 2)
        self.assertEqual(detect.scan("a \u2014 b \u2013 c", allow_dashes=True), [])
        self.assertEqual(detect.scan("a well-known - plain hyphen"), [])

    def test_long_sentence_at_limit(self):
        _, limit = detect.load_skill()
        at_limit = " ".join(["word"] * limit) + "."
        over = " ".join(["word"] * (limit + 1)) + "."
        wrapped = " ".join(["word"] * 13) + "\n" + " ".join(["word"] * (limit + 1 - 13)) + "."
        self.assertEqual(kinds(detect.scan(at_limit, max_words=limit), "long-sentence"), [])
        self.assertEqual(len(kinds(detect.scan(over, max_words=limit), "long-sentence")), 1)
        self.assertEqual(len(kinds(detect.scan(wrapped, max_words=limit), "long-sentence")), 1)
        self.assertEqual(kinds(detect.scan(over, max_words=None), "long-sentence"), [])

    def test_sentence_ends_after_closing_mark(self):
        _, limit = detect.load_skill()
        half = " ".join(["word"] * (limit - 5))
        for end in ['."', ".\u201d", ".)", "!)", ".]", "\u2026"]:
            with self.subTest(end=end):
                self.assertEqual(kinds(detect.scan(f"{half}{end} {half}.", max_words=limit), "long-sentence"), [])
        quoted = '"' + " ".join(["word"] * (limit + 1)) + '." Done.'
        self.assertEqual(len(kinds(detect.scan(quoted, max_words=limit), "long-sentence")), 1)

    def test_markdown_tells(self):
        self.assertEqual(len(kinds(detect.scan("- **Speed:** fast\n"), "bold-label")), 1)
        self.assertEqual(kinds(detect.scan("- a plain bullet with **one** bold word\n"), "bold-label"), [])
        self.assertEqual(len(kinds(detect.scan("## Why It Matters Now\n"), "title-case")), 1)
        self.assertEqual(len(kinds(detect.scan("## The Future of Work\n"), "title-case")), 1)
        for heading in ["## Why this matters\n", "## LinkedIn About\n", "## LinkedIn post: the result\n"]:
            with self.subTest(heading=heading):
                self.assertEqual(kinds(detect.scan(heading), "title-case"), [])
        self.assertEqual(len(kinds(detect.scan("## \U0001F680 Launch\n"), "heading-emoji")), 1)


class Cli(unittest.TestCase):
    def run_cli(self, *args, stdin=""):
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )

    def test_exit_codes_and_format(self):
        clean = self.run_cli(stdin="Plain words here.\n")
        self.assertEqual((clean.returncode, clean.stdout), (0, ""))

        sloppy = self.run_cli(stdin="Certainly! This works.\n")
        self.assertEqual(sloppy.returncode, 1)
        self.assertIn('<stdin>:1:1: phrase: "Certainly!"', sloppy.stdout)

        self.assertEqual(self.run_cli("--nope").returncode, 2)
        self.assertEqual(self.run_cli("--max-words", "-1", stdin="Short one.\n").returncode, 2)
        self.assertEqual(self.run_cli("/no/such/draft.md").returncode, 2)

    def test_non_utf8_input_is_still_scanned(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input=b"caf\xe9 delve\n", capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn(b'phrase: "delve"', result.stdout)

    def test_file_argument(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "draft.md"
            path.write_text("Fine line.\nWe delve in.\n", encoding="utf-8")
            result = self.run_cli(str(path))
        self.assertEqual(result.returncode, 1)
        self.assertIn(f'{path}:2:4: phrase: "delve"', result.stdout)

    def test_paragraph_counts(self):
        result = self.run_cli(stdin="Certainly! We leverage a pivotal tool.\n\nPlain words here.\n")
        self.assertIn("paragraph 1 (line 1): 3 tells", result.stdout)
        self.assertNotIn("paragraph 2", result.stdout)
        repeated = self.run_cli(stdin="We delve, delve, and delve.\n")
        self.assertIn("paragraph 1 (line 1): 1 tell\n", repeated.stdout)
        for brk in [" ", "\f"]:
            with self.subTest(brk=repr(brk)):
                odd = self.run_cli(stdin=f"I fixed the build{brk}cache.\n\nWe leverage a vibrant platform.\nIt is pivotal and seamless.\n")
                self.assertIn("paragraph 2 (line 3): 4 tells", odd.stdout)
                self.assertNotIn("paragraph 1", odd.stdout)

    def test_flags(self):
        self.assertEqual(self.run_cli(stdin="a \u2014 b\n").returncode, 1)
        self.assertEqual(self.run_cli("--allow-dashes", stdin="a \u2014 b\n").returncode, 0)
        over = " ".join(["word"] * 30) + ".\n"
        long_run = self.run_cli(stdin=over)
        self.assertEqual(long_run.returncode, 1)
        self.assertIn("long-sentence", long_run.stdout)
        self.assertEqual(self.run_cli("--max-words", "0", stdin=over).returncode, 0)


if __name__ == "__main__":
    unittest.main()

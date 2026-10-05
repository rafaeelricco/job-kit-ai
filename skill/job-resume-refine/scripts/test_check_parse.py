import copy
import contextlib
import io
import json
import subprocess
import unittest
from unittest import mock
from types import SimpleNamespace

from check_parse import check, extract, main

# Shaped like pdftotext default-mode output of the real base: a table row
# splits into blocks, bullets wrap, "--" renders as an en dash.
TEXT = """Jane Doe
+1 555 010 0000 | jane.doe@example.com | github.com/janedoe

SUMMARY
Most recently I built Widget at Acme Corp for regional retailers.

EXPERIENCE
Senior Software Engineer

Sep. 2025 – Present

Acme Corp
London, United Kingdom | Remote
• Shipped Widget, a white-label AI sales assistant, from day two to production. It crawls the
client site and answers visitors by text or voice.
Software Engineer

Jun. 2025 – Sep. 2025

Globex
London, United Kingdom | Remote

TECHNICAL SKILLS
Full-Stack: TypeScript, JavaScript, Next.js, Node.js
Backend & Architecture: Event Sourcing, CQRS, OAuth2/OpenID Connect
"""


class ParseCheckTests(unittest.TestCase):
    def setUp(self):
        self.expected = {
            "identity": ["Jane Doe", "jane.doe@example.com", "+1 555 010 0000"],
            "roles": [
                {"company": "Acme Corp", "position": "Senior Software Engineer", "date": "Sep. 2025 -- Present"},
                {"company": "Globex", "position": "Software Engineer", "date": "Jun. 2025 -- Sep. 2025"},
            ],
            "skills": ["TypeScript", "Next.js", "Event Sourcing", "OAuth2/OpenID Connect"],
        }

    def test_accepts_round_trip(self):
        result = check(TEXT, self.expected)
        self.assertEqual(result, {"verdict": "PASS", "missing": [], "order": [], "error": None})

    def test_accepts_wrapped_line_and_dash_variants(self):
        expected = copy.deepcopy(self.expected)
        expected["skills"].append("from day two to production. It crawls the client site")
        expected["roles"][0]["date"] = "Sep. 2025 — Present"
        self.assertEqual(check(TEXT, expected)["verdict"], "PASS")

    def test_rejects_missing_identity_naming_token(self):
        expected = copy.deepcopy(self.expected)
        expected["identity"][2] = "+1 555 010-0000"
        result = check(TEXT, expected)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["missing"], [{"kind": "identity", "token": "+1 555 010-0000"}])

    def test_ignores_blank_optional_identity_tokens(self):
        expected = copy.deepcopy(self.expected)
        expected["identity"] = ["Jane Doe", "", "  "]

        self.assertEqual(
            check(TEXT, expected),
            {"verdict": "PASS", "missing": [], "order": [], "error": None},
        )

    def test_rejects_missing_skill_and_role_field(self):
        with self.subTest("skill"):
            expected = copy.deepcopy(self.expected)
            expected["skills"].append("GraphQL")
            self.assertIn({"kind": "skill", "token": "GraphQL"}, check(TEXT, expected)["missing"])
        with self.subTest("company"):
            expected = copy.deepcopy(self.expected)
            expected["roles"][1]["company"] = "Invented Inc"
            self.assertIn({"kind": "company", "token": "Invented Inc"}, check(TEXT, expected)["missing"])

    def test_short_skill_matches_only_as_whole_token(self):
        for skill in ("C", "Go", "R"):
            with self.subTest(skill=skill):
                expected = copy.deepcopy(self.expected)
                expected["skills"] = [skill]
                text = TEXT + "Coordinated Google rollouts across regions.\n"
                self.assertIn(
                    {"kind": "skill", "token": skill}, check(text, expected)["missing"]
                )
        expected = copy.deepcopy(self.expected)
        expected["skills"] = ["C", "Go"]
        text = TEXT.replace("TypeScript, JavaScript", "C, Go, TypeScript, JavaScript")
        self.assertEqual(check(text, expected)["verdict"], "PASS")

    def test_short_skill_does_not_match_inside_unicode_word(self):
        for skill, text in (("R", "Résumé"), ("C", "César")):
            with self.subTest(skill=skill, text=text):
                expected = copy.deepcopy(self.expected)
                expected["skills"] = [skill]
                self.assertIn(
                    {"kind": "skill", "token": skill},
                    check(text, expected)["missing"],
                )

    def test_punctuated_skills_still_match(self):
        expected = copy.deepcopy(self.expected)
        expected["skills"] = ["C++", "C#", ".NET", "Node.js"]
        text = TEXT.replace("Node.js", "Node.js, C++, C#, .NET")
        self.assertEqual(check(text, expected), {"verdict": "PASS", "missing": [], "order": [], "error": None})
        expected["skills"] = ["Node.js"]
        self.assertIn(
            {"kind": "skill", "token": "Node.js"},
            check(TEXT.replace("Node.js", "NodeX.js"), expected)["missing"],
        )

    def test_summary_fields_cannot_mask_reversed_roles(self):
        text = TEXT.replace(
            "Most recently I built Widget at Acme Corp for regional retailers.",
            "Software Engineer at Acme Corp. Most recently I built Widget for regional retailers.",
        ).replace("\nGlobex\n", "\nAcme Corp\n")
        expected = copy.deepcopy(self.expected)
        expected["roles"][1]["company"] = "Acme Corp"
        expected["roles"].reverse()

        result = check(text, expected)

        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["missing"], [])
        self.assertTrue(
            any("Senior Software Engineer" in line for line in result["order"])
        )

    def test_rejects_roles_out_of_page_order(self):
        expected = copy.deepcopy(self.expected)
        expected["roles"].reverse()
        result = check(TEXT, expected)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["missing"], [])
        self.assertTrue(any("Senior Software Engineer" in line for line in result["order"]))

    def test_extract_reports_missing_pdftotext(self):
        with mock.patch("check_parse.subprocess.run", side_effect=FileNotFoundError):
            with self.assertRaises(FileNotFoundError):
                extract("/nonexistent.pdf")

    def test_extract_modes_explicit_encoding_and_timeout(self):
        for layout in (False, True):
            with mock.patch("check_parse.subprocess.run", return_value=SimpleNamespace(
                    returncode=0, stdout="Resume", stderr="")) as run:
                self.assertEqual(extract("/resume.pdf", layout=layout), "Resume")
            args, kwargs = run.call_args
            self.assertEqual("-layout" in args[0], layout)
            self.assertIn("UTF-8", args[0])
            self.assertIn("unix", args[0])
            self.assertEqual(args[0][-2:], ["/resume.pdf", "-"])
            self.assertEqual(kwargs["encoding"].lower(), "utf-8")
            self.assertGreater(kwargs["timeout"], 0)
            self.assertLessEqual(kwargs["timeout"], 60)
            self.assertFalse(kwargs.get("shell", False))

    def test_new_extraction_errors_preserve_legacy_json_and_exit(self):
        for error in (subprocess.TimeoutExpired("pdftotext", 30),
                      UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid")):
            out = io.StringIO()
            with mock.patch("check_parse.subprocess.run", side_effect=error), \
                    mock.patch("sys.argv", ["check_parse.py", "/resume.pdf"]), \
                    mock.patch("sys.stdin", io.StringIO(json.dumps(self.expected))), \
                    contextlib.redirect_stdout(out):
                self.assertEqual(main(), 0)
            result = json.loads(out.getvalue())
            self.assertEqual(set(result), {"verdict", "missing", "order", "error"})
            self.assertEqual(result["verdict"], "FAIL")
            self.assertTrue(result["error"])

    def test_legacy_boundary_semantics_are_unchanged(self):
        for text, token in (("C++", "C"), ("R&D", "R")):
            self.assertEqual(check(text, {"identity": [token], "roles": [], "skills": []})["verdict"], "PASS")


if __name__ == "__main__":
    unittest.main()

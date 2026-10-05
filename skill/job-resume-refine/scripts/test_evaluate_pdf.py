"""Source-grounded extraction checks; Poppler is mocked only in unit tests."""
import contextlib
import copy
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import evaluate_pdf as evaluator


def manifest(*parts, terms=()):
    return {
        "schema_version": 1,
        "blocks": [
            {"id": "block-{}".format(i), "parts": [part] if isinstance(part, str) else part}
            for i, part in enumerate(parts)
        ],
        "terms": list(terms),
    }


EXPECTED = manifest(
    ["Jane Doe", "jane@example.com"],
    "SUMMARY",
    "Built a product at Acme.",
    "EXPERIENCE",
    ["Senior Software Engineer", "Acme", "Sep. 2025 – Present"],
    "Built a production service using AWS.",
    ["Software Engineer", "Globex", "Jun. 2024 – Aug. 2025"],
    "Shipped accessible interfaces.",
    "SKILLS",
    "AWS, C++, Node.js",
    "EDUCATION",
    ["Example University", "2024"],
    terms=["AWS", "C++", "Node.js"],
)
TEXT = """Jane Doe | jane@example.com
SUMMARY
Built a product at Acme.
EXPERIENCE
Senior Software Engineer | Sep. 2025 – Present
Acme
Built a production service using AWS.
Software Engineer | Jun. 2024 – Aug. 2025
Globex
Shipped accessible interfaces.
SKILLS
AWS, C++, Node.js
EDUCATION
Example University | 2024
"""


class ContentTests(unittest.TestCase):
    def test_complete_manifest_passes(self):
        result = evaluator.evaluate_text(TEXT, EXPECTED)
        self.assertEqual(result["verdict"], "PASS")
        self.assertEqual(result["blocks"], {"recovered": 12, "total": 12})
        self.assertEqual(result["terms"], {"matched": 3, "total": 3})

    def test_normal_wrapping_page_breaks_and_dash_variants(self):
        text = TEXT.replace("production service", "production\nservice")
        text = text.replace("\nSKILLS", "\fSKILLS").replace("–", "--")
        self.assertEqual(evaluator.evaluate_text(text, EXPECTED)["verdict"], "PASS")

    def test_missing_truncated_and_reordered_content_fails(self):
        bullet = "Built a production service using AWS."
        cases = [TEXT.replace(bullet, ""), TEXT.replace(bullet, "Built a service."),
                 TEXT.replace(bullet, "").replace("\nEDUCATION", "\n" + bullet + "\nEDUCATION"),
                 TEXT.replace("EXPERIENCE\n", "")]
        for text in cases:
            with self.subTest(text=text):
                self.assertEqual(evaluator.evaluate_text(text, EXPECTED)["verdict"], "FAIL")

    def test_summary_cannot_supply_missing_heading_part(self):
        text = TEXT.replace("Built a product at Acme.", "Senior Software Engineer at Acme.")
        expected = copy.deepcopy(EXPECTED)
        expected["blocks"][2]["parts"] = ["Senior Software Engineer at Acme."]
        text = text.replace("Senior Software Engineer |", "SeniorSoftwareEngineer |")
        self.assertEqual(evaluator.evaluate_text(text, expected)["verdict"], "FAIL")

    def test_duplicate_expected_parts_need_distinct_occurrences(self):
        expected = manifest(["Engineer", "Engineer"])
        self.assertEqual(evaluator.evaluate_text("Engineer", expected)["verdict"], "FAIL")
        self.assertEqual(evaluator.evaluate_text("Engineer | Engineer", expected)["verdict"], "PASS")

    def test_duplicate_blocks_need_distinct_occurrences(self):
        expected = manifest("Shipped a product.", "Shipped a product.")
        self.assertEqual(evaluator.evaluate_text("Shipped a product.", expected)["verdict"], "FAIL")
        self.assertEqual(evaluator.evaluate_text("Shipped a product.\nShipped a product.", expected)["verdict"], "PASS")

    def test_overlapping_parts_find_nonoverlapping_assignment_in_any_order(self):
        for parts in (["Engineer", "Senior Engineer"], ["Senior Engineer", "Engineer"]):
            expected = manifest(parts)
            self.assertEqual(evaluator.evaluate_text("Senior Engineer", expected)["verdict"], "FAIL")
            self.assertEqual(evaluator.evaluate_text("Senior Engineer | Engineer", expected)["verdict"], "PASS")
            self.assertEqual(evaluator.evaluate_text("Engineer | Senior Engineer", expected)["verdict"], "PASS")

    def test_strict_technical_term_boundaries(self):
        for term, text in [("C", "C++"), ("C", "C#"), ("R", "R&D"),
                           ("NET", ".NET"), ("Node", "Node.js"), ("AWS", "AWS_SDK"),
                           ("Go", "Google"), ("R", "Résumé")]:
            with self.subTest(term=term, text=text):
                result = evaluator.evaluate_text(text, manifest(text, terms=[term]))
                self.assertEqual(result["verdict"], "FAIL")
                self.assertEqual(result["terms"]["matched"], 0)

    def test_literal_punctuation_casefold_and_sentence_period(self):
        text = "C++, C#, .NET, Node.js, AWS."
        result = evaluator.evaluate_text(text, manifest(text, terms=["C++", "C#", ".NET", "node.JS", "aws"]))
        self.assertEqual(result["verdict"], "PASS")
        self.assertEqual(result["terms"], {"matched": 5, "total": 5})

    def test_term_deduplication_and_empty_terms(self):
        result = evaluator.evaluate_text("AWS", manifest("AWS", terms=["AWS", "aws", "AWS"]))
        self.assertEqual(result["terms"], {"matched": 1, "total": 1})
        result = evaluator.evaluate_text("AWS", manifest("AWS"))
        self.assertEqual(result["terms"], {"matched": 0, "total": 0})
        self.assertEqual(result["verdict"], "PASS")

    def test_split_and_glued_words_fail_with_diagnostics(self):
        for text, parts in [("V AD", ["VAD"]), ("SeniorSoftwareEngineer", ["Senior Software Engineer"]),
                            ("EngineerSep. 2025", ["Engineer", "Sep. 2025"])]:
            result = evaluator.evaluate_text(text, manifest(parts))
            self.assertEqual(result["verdict"], "FAIL")
            self.assertTrue(result["issues"])

    def test_unicode_canonical_equivalence_preserves_accents(self):
        self.assertEqual(evaluator.evaluate_text("Jose\u0301 Ricco", manifest("José Ricco"))["verdict"], "PASS")
        self.assertEqual(evaluator.evaluate_text("Jose Ricco", manifest("José Ricco"))["verdict"], "FAIL")

    def test_ligature_body_match_is_reported_but_not_exact_term(self):
        text = "Built an o\ufb03ce application."
        expected = manifest("Built an office application.")
        result = evaluator.evaluate_text(text, expected)
        self.assertEqual(result["verdict"], "PASS")
        self.assertTrue(any(i["severity"] == "warning" for i in result["issues"]))
        expected["terms"] = ["office"]
        self.assertEqual(evaluator.evaluate_text(text, expected)["verdict"], "FAIL")
        reversed_result = evaluator.evaluate_text("office", manifest("o\ufb03ce"))
        self.assertEqual(reversed_result["verdict"], "PASS")
        self.assertTrue(reversed_result["issues"])
        self.assertEqual(evaluator.evaluate_text("office", manifest("o\ufb03ce", terms=["o\ufb03ce"]))["verdict"], "FAIL")

    def test_source_grounded_discretionary_hyphenation(self):
        expected = manifest("Built internationalization support.")
        text = "Built interna-\ntionalization support."
        result = evaluator.evaluate_text(text, expected)
        self.assertEqual(result["verdict"], "PASS")
        self.assertTrue(any(i["severity"] == "warning" for i in result["issues"]))
        expected["terms"] = ["internationalization"]
        self.assertEqual(evaluator.evaluate_text(text, expected)["verdict"], "FAIL")
        self.assertEqual(evaluator.evaluate_text("Built interna-tionalization support.", expected)["verdict"], "FAIL")

    def test_real_hyphens_are_preserved(self):
        expected = manifest("Built a full-stack product.")
        wrapped = evaluator.evaluate_text("Built a full-\nstack product.", expected)
        self.assertEqual(wrapped["verdict"], "PASS")
        self.assertTrue(wrapped["issues"])
        self.assertEqual(evaluator.evaluate_text("Built a fullstack product.", expected)["verdict"], "FAIL")

    def test_compound_wrap_does_not_manufacture_term_boundaries(self):
        for term in ("AWS", "SDK", "AWS-SDK"):
            result = evaluator.evaluate_text("AWS-\nSDK", manifest("AWS-SDK", terms=[term]))
            self.assertEqual(result["verdict"], "FAIL", (term, result))
        for text, term in (("C++", "C"), ("R&D", "R"), ("Node.js", "Node")):
            result = evaluator.evaluate_text(text, manifest(text, terms=[term]))
            self.assertFalse(any("spacing" in i["code"] for i in result["issues"]), result)

    def test_source_decides_each_hyphen_without_vocabulary_heuristics(self):
        self.assertEqual(evaluator.evaluate_text("A non-\nempty value.", manifest("A nonempty value."))["verdict"], "PASS")
        expected = manifest("A full-stack internationalization project.")
        text = "A full-\nstack interna-\ntionalization project."
        self.assertEqual(evaluator.evaluate_text(text, expected)["verdict"], "PASS")

    def test_long_s_ligature_and_private_use_do_not_corrupt_matches(self):
        self.assertEqual(evaluator.evaluate_text("A \ufb05able service.", manifest("A stable service."))["verdict"], "PASS")
        self.assertEqual(evaluator.evaluate_text("interna-\uef00tionalization", manifest("internationalization"))["verdict"], "FAIL")

    def test_character_anomalies_are_located(self):
        result = evaluator.evaluate_text("Heading\f\ue000 \ufffd Body", manifest("Heading", "Body"))
        self.assertEqual(result["verdict"], "PASS")
        self.assertTrue(any(i.get("page") == 2 and i["severity"] == "warning" for i in result["issues"]))
        self.assertEqual(evaluator.evaluate_text("Bo\ufffddy", manifest("Body"))["verdict"], "FAIL")
        self.assertEqual(evaluator.evaluate_text("Body\x00", manifest("Body"))["verdict"], "FAIL")

    def test_empty_extraction_fails(self):
        self.assertEqual(evaluator.evaluate_text(" \n\f", manifest("Body"))["verdict"], "FAIL")

    def test_hyphenation_has_no_word_length_heuristics(self):
        for extracted, expected in [("ca-\nt", "cat"), ("word-\nbreak", "wordbreak"),
                                    ("inter-\n    national", "international")]:
            with self.subTest(extracted=extracted):
                self.assertEqual(evaluator.evaluate_text(extracted, manifest(expected))["verdict"], "PASS")
        self.assertEqual(evaluator.evaluate_text("A -\nB", manifest("A B"))["verdict"], "FAIL")

    def test_exact_terms_preserve_punctuation_and_allow_normal_wrapping(self):
        text = "Amazon Web\nServices; full–stack; o\ufb03ce"
        result = evaluator.evaluate_text(text, manifest(text, terms=["Amazon Web Services"]))
        self.assertEqual(result["verdict"], "PASS")
        for term in ("full-stack", "office"):
            self.assertEqual(evaluator.evaluate_text(text, manifest(text, terms=[term]))["verdict"], "FAIL")

    def test_ligature_terms_are_not_deduplicated_into_ascii_terms(self):
        text = "office o\ufb03ce"
        result = evaluator.evaluate_text(text, manifest(text, terms=["office", "o\ufb03ce"]))
        self.assertEqual(result["verdict"], "PASS")
        self.assertEqual(result["terms"], {"matched": 2, "total": 2})

    def test_spacing_diagnostics_are_located_but_never_rescue_a_match(self):
        for text, part in [("V AD", "VAD"), ("SeniorSoftwareEngineer", "Senior Software Engineer"),
                           ("EngineerSep. 2025", "Engineer")]:
            result = evaluator.evaluate_text("Heading\f" + text, manifest("Heading", part, terms=[part]))
            self.assertEqual(result["verdict"], "FAIL")
            findings = [i for i in result["issues"] if "spacing" in i["code"]]
            self.assertTrue(findings, result)
            self.assertTrue(any(i.get("block_id") == "block-1" for i in findings))
            self.assertTrue(any(i.get("term") == part for i in findings))
            self.assertTrue(all(i.get("page") == 2 and i.get("excerpt") for i in findings))

    def test_basic_normalization_matches_are_reported(self):
        for text, expected in [("Jose\u0301", "José"), ("A\nB", "A B"), ("2024–2025", "2024-2025")]:
            result = evaluator.evaluate_text(text, manifest(expected))
            self.assertEqual(result["verdict"], "PASS")
            self.assertTrue(any(i.get("block_id") == "block-0" and i.get("page") == 1
                                and i.get("excerpt") for i in result["issues"]), result)

    def test_locations_follow_raw_unicode_offsets(self):
        text = "e\u0301" * 100 + "\fV AD"
        result = evaluator.evaluate_text(text, manifest("é" * 100, "VAD"))
        findings = [i for i in result["issues"] if "spacing" in i["code"]]
        self.assertTrue(findings, result)
        self.assertTrue(all(i.get("page") == 2 and "V AD" in i.get("excerpt", "") for i in findings))
        clean = evaluator.evaluate_text("Body\n", manifest("Body"))
        self.assertFalse(any("normaliz" in i["code"] for i in clean["issues"]), clean)

    def test_unexpected_duplicate_bullet_or_section_fails(self):
        for extra in ("Built a production service using AWS.\n", "SKILLS\nAWS, C++, Node.js\n"):
            self.assertEqual(evaluator.evaluate_text(TEXT + extra, EXPECTED)["verdict"], "FAIL")
        self.assertEqual(evaluator.evaluate_text("AWS\nAWS", manifest("AWS", "AWS"))["verdict"], "PASS")

    def test_malformed_evaluate_text_never_raises(self):
        for expected in ({"schema_version": 1, "blocks": None, "terms": []},
                         {**manifest("Text"), "terms": [{}]},
                         {**manifest("Text"), "unexpected": True}):
            self.assertEqual(evaluator.evaluate_text("Text", expected)["verdict"], "ERROR")


class PdfAndCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.pdf = Path(self.temp.name) / "resume.pdf"
        self.pdf.write_bytes(b"%PDF-1.4\nsynthetic bytes; extraction is mocked\n")
        self.version = mock.patch("evaluate_pdf.subprocess.run", return_value=SimpleNamespace(
            returncode=0, stdout="", stderr="pdftotext version test\n"))
        self.version.start()
        self.addCleanup(self.version.stop)

    def test_both_modes_are_evaluated_and_report_is_reproducible(self):
        import hashlib
        with mock.patch("evaluate_pdf.extract", return_value=TEXT) as extract:
            result = evaluator.evaluate_pdf(str(self.pdf), EXPECTED)
        self.assertEqual(result["verdict"], "PASS")
        self.assertEqual(set(result["modes"]), {"default", "layout"})
        self.assertEqual(extract.call_count, 2)
        self.assertEqual(
            [call.kwargs.get("layout", call.args[1] if len(call.args) > 1 else False)
             for call in extract.call_args_list],
            [False, True],
        )
        self.assertEqual(result["pdf_sha256"], hashlib.sha256(self.pdf.read_bytes()).hexdigest())
        self.assertEqual(result["expected"], EXPECTED)

    def test_mode_disagreement_and_shared_damage_fail(self):
        for outputs in ([TEXT, TEXT.replace("Node.js", "Node . js")],
                        [TEXT.replace("Node.js", ""), TEXT.replace("Node.js", "")]):
            with mock.patch("evaluate_pdf.extract", side_effect=outputs):
                result = evaluator.evaluate_pdf(str(self.pdf), EXPECTED)
            self.assertEqual(result["verdict"], "FAIL")
            if outputs[0] != outputs[1]:
                self.assertTrue(result["issues"])

    def test_invalid_manifest_is_rejected_before_extraction(self):
        cases = [None, [], {}, manifest(), {**manifest("Text"), "schema_version": True},
                 {**manifest("Text"), "schema_version": 2},
                 {**manifest("Text"), "blocks": [{"id": "x", "parts": []}]},
                 {**manifest("Text"), "blocks": [{"id": "x", "parts": [" "]}]},
                 {**manifest("Text"), "terms": [""]},
                 manifest("Text\x00"), manifest("Text", terms=["Text\x00"]) ]
        duplicate = manifest("A", "B")
        duplicate["blocks"][1]["id"] = duplicate["blocks"][0]["id"]
        cases.append(duplicate)
        for expected in cases:
            with self.subTest(expected=expected), mock.patch("evaluate_pdf.extract") as extract:
                self.assertEqual(evaluator.evaluate_pdf(str(self.pdf), expected)["verdict"], "ERROR")
                extract.assert_not_called()

    def test_unavailable_file_and_extraction_errors(self):
        self.assertEqual(evaluator.evaluate_pdf(str(self.pdf) + ".missing", EXPECTED)["verdict"], "ERROR")
        self.assertEqual(evaluator.evaluate_pdf(str(self.pdf) + "\x00", EXPECTED)["verdict"], "ERROR")
        for error in (FileNotFoundError("pdftotext"), RuntimeError("pdftotext failed: permissions"),
                      RuntimeError("pdftotext timed out"), RuntimeError("invalid UTF-8 output")):
            with self.subTest(error=error), mock.patch("evaluate_pdf.extract", side_effect=error):
                result = evaluator.evaluate_pdf(str(self.pdf), EXPECTED)
                self.assertEqual(result["verdict"], "ERROR")
                self.assertTrue(result["issues"])

    def test_cli_rejects_invalid_utf8_and_non_json_constants(self):
        self.version.stop()  # This test launches the real CLI subprocess.
        for payload in (b'{"schema_version":1,"blocks":[{"id":"b","parts":["\xff"]}],"terms":[]}',
                        b'{"schema_version":NaN,"blocks":[],"terms":[]}'):
            result = subprocess.run([sys.executable, evaluator.__file__, str(self.pdf)],
                                    input=payload, capture_output=True)
            self.assertEqual(result.returncode, 2)
            report = json.loads(result.stdout.decode("utf-8"))
            self.assertEqual(report["verdict"], "ERROR")
            self.assertIn("invalid JSON", report["issues"][0]["message"])

    def test_cli_exit_codes_and_json(self):
        for text, wanted in [(TEXT, 0), ("missing content", 1)]:
            out = io.StringIO()
            with mock.patch("evaluate_pdf.extract", return_value=text), \
                    mock.patch("sys.argv", ["evaluate_pdf.py", str(self.pdf)]), \
                    mock.patch("sys.stdin", io.StringIO(json.dumps(EXPECTED))), \
                    contextlib.redirect_stdout(out):
                code = evaluator.main()
            self.assertEqual(code, wanted)
            self.assertIn(json.loads(out.getvalue())["verdict"], ("PASS", "FAIL"))
        for stdin in ("{", json.dumps(manifest())):
            out = io.StringIO()
            with mock.patch("sys.argv", ["evaluate_pdf.py", str(self.pdf)]), \
                    mock.patch("sys.stdin", io.StringIO(stdin)), contextlib.redirect_stdout(out):
                self.assertEqual(evaluator.main(), 2)
            self.assertEqual(json.loads(out.getvalue())["verdict"], "ERROR")


if __name__ == "__main__":
    unittest.main()

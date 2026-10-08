"""Offline checks for the opt-in job-resume-review evals: report contract, parser, fixtures."""
import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

from harness import SKILL, load

EVALS = Path(__file__).resolve().parent / "evals"
sys.path.insert(0, str(EVALS))
import report_parse  # noqa: E402
import resume_review  # noqa: E402
from pdf_fixture import write_pdf  # noqa: E402

REPORT_MD = SKILL / "job-resume-review" / "references" / "report.md"
UNCHANGED = {
    "bullet_anchors", "hidden_text_pdf", "implicit_terms",
    "public_snapshot", "public_unavailable",
}
SAMPLE = """\
Score: 40/100 · coverage 100% · final · capped from 71

| Criterion | Rating | Points | Evidence |
| --- | ---: | ---: | --- |
| Positioning | 2 | 7.5/15 | generic summary |
| Achievement bullets | 2.67 | 20/30 | mixed |

| Location | Weight | Rating | Finding |
| --- | ---: | ---: | --- |
| **E1.B3** | 2 | 1 | duty only |

| Requirement | Weight | Evidence | Credit |
| --- | ---: | --- | ---: |
| Kubernetes in production | 2 | Skills only | 0.5 |
"""


class ReportContractTests(unittest.TestCase):
    def test_report_md_declares_the_parsed_anchors(self):
        text = REPORT_MD.read_text(encoding="utf-8")
        self.assertIn("Score: {score}/100 · coverage {coverage}% · {final|provisional}", text)
        self.assertIn("capped from {weighted_score}", text)
        for header in (report_parse.CRITERIA, report_parse.BULLETS, report_parse.MATRIX):
            self.assertIn("| " + " | ".join(header) + " |", text)


class ParseTests(unittest.TestCase):
    def test_sample_report(self):
        report = report_parse.parse(SAMPLE)
        self.assertEqual((report.score, report.coverage, report.provisional, report.capped_from), (40, 100, False, 71))
        self.assertEqual(report.criteria, {"positioning": 2.0, "achievement bullets": 2.67})
        self.assertEqual(report.bullets, {"E1.B3": 1.0})
        self.assertEqual(report.matrix, {"kubernetes in production": 0.5})

    def test_missing_anchors_parse_as_empty(self):
        report = report_parse.parse("no report here")
        self.assertEqual((report.score, report.criteria, report.bullets, report.matrix), (None, {}, {}, {}))

    def test_diagnostics_preserve_numeric_anchors(self):
        extra = "\nCareer positioning: management evidence not demonstrated.\n\n" \
                "| Surface | Term | Evidence | Finding |\n" \
                "| --- | --- | --- | --- |\n" \
                "| CV | deployment automation | E1.B2 | supported but implicit |\n"
        before, after = report_parse.parse(SAMPLE), report_parse.parse(SAMPLE + extra)
        for field in ("score", "coverage", "provisional", "capped_from",
                      "criteria", "bullets", "matrix"):
            self.assertEqual(getattr(before, field), getattr(after, field))


class RunnerTests(unittest.TestCase):
    def test_read_stream_takes_final_result_and_bash_commands(self):
        events = [
            {"type": "system", "subtype": "init"},
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "Bash", "input": {"command": "python3 x/review_score.py < in.json"}},
                {"type": "tool_use", "name": "Read", "input": {"file_path": "cv.md"}}]}},
            {"type": "result", "result": SAMPLE},
        ]
        run = resume_review.read_stream("\n".join(json.dumps(e) for e in events) + "\nnot json\n")
        self.assertEqual(run.commands, ["python3 x/review_score.py < in.json"])
        self.assertEqual(run.report.score, 40)
        self.assertIsNone(resume_review.ran("review_score.py")(run))
        self.assertIsNotNone(resume_review.ran("scan_cv.py")(run))

    def test_missing_tools_exit_2(self):
        with mock.patch.object(resume_review.shutil, "which", return_value=None), redirect_stderr(io.StringIO()):
            self.assertEqual(resume_review.main([]), 2)

    def test_supplied_context_reaches_prompt(self):
        case = next(c for c in resume_review.CASES if c.name == "public_snapshot")
        with tempfile.TemporaryDirectory() as tmp:
            prompt = resume_review.prompt_for(case, Path(tmp))
        self.assertIn(case.context, prompt)


class FixtureTests(unittest.TestCase):
    def test_visibility_checks_accept_report_variants_and_reject_wrong_findings(self):
        samples = (
            ("implicit_terms", -1,
             "| CV | deployment automation | E1.B2 | The work is there but not named. |", True),
            ("implicit_terms", -1,
             "| CV | deployment automation | E1.B2 | Absent; no demonstrated deployment automation. |", False),
            ("implicit_terms", -1,
             "| CV | deployment automation | E1.B2 | Visible and supported. |", False),
            ("skills_only_requirement", -1,
             "| CV | Kubernetes / K8s | Skills only | Listed only. |", True),
            ("skills_only_requirement", -1,
             "| CV | Kubernetes | E1.B1 | Visible and supported in production. |", False),
            ("public_snapshot", 2,
             "| Page snapshot | Deployment automation, CI/CD | Supplied text | Absent from the snapshot. |", True),
            ("public_snapshot", 2,
             "| https://example.com/alexdoe | deployment automation | Supplied text | Not visible. |", True),
            ("public_snapshot", 2,
             "| CV | deployment automation | E1.B2 | Absent from the CV. |", False),
        )
        for name, index, text, accepted in samples:
            with self.subTest(case=name, text=text):
                case = next(c for c in resume_review.CASES if c.name == name)
                run = resume_review.Run(report_parse.parse(text), [])
                self.assertEqual(case.checks[index](run) is None, accepted)

    def test_seniority_check_accepts_missing_evidence_not_title_only_approval(self):
        case = next(c for c in resume_review.CASES if c.name == "seniority_title_only")
        for text, accepted in (
            ("| Management | Not shown. No direct reports or hiring evidence. |", True),
            ("Management is established solely by the Engineering Director title.", False),
        ):
            with self.subTest(text=text):
                run = resume_review.Run(report_parse.parse(text), [])
                self.assertEqual(case.checks[-1](run) is None, accepted)

    def test_every_edit_matches_the_base_fixture(self):
        base = (resume_review.FIXTURES / "base.md").read_text(encoding="utf-8")
        for case in resume_review.CASES:
            with self.subTest(case=case.name):
                self.assertEqual(case.edit(base) != base, case.name not in UNCHANGED)

    def test_case_names_are_unique(self):
        names = [case.name for case in resume_review.CASES]
        self.assertEqual(len(names), len(set(names)))

    @unittest.skipUnless(shutil.which("pdftotext"), "needs Poppler pdftotext")
    def test_pdf_fixture_extracts_hidden_lines_and_blank_pdf_blocks(self):
        scan_cv = load(SKILL / "job-resume-review" / "scripts" / "scan_cv.py")
        with tempfile.TemporaryDirectory() as tmp:
            text = scan_cv.extract_pdf(write_pdf(Path(tmp) / "cv.pdf", ["São Paulo – 2022"], hidden=["Kubernetes"]))
            blank = scan_cv.scan_pdf_text(scan_cv.extract_pdf(write_pdf(Path(tmp) / "blank.pdf", [])))[1]
        self.assertIn("São Paulo – 2022", text)
        self.assertIn("Kubernetes", text)
        self.assertEqual([i["code"] for i in blank], ["no_text_layer"])

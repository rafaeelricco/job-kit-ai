"""Offline checks for the opt-in job-resume-review evals: report contract, parser, fixtures."""
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
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
    "linkedin_mismatch", "public_snapshot", "public_unavailable",
}
SAMPLE = """\
Score: 40/100 · coverage 100% · final · capped from 71

| Criterion | Rating | Points | Evidence |
| --- | ---: | ---: | --- |
| Positioning | 2 | 7.5/15 | generic summary |
| Achievement bullets | 2.67 | 20/30 | mixed |

| Location | Weight | Rating | Finding | Direction |
| --- | ---: | ---: | --- | --- |
| **E1.B3** | 2 | 1 | duty only | Name one owned delivery with scope |

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


class ReviewOpportunityChecks(unittest.TestCase):
    def run_check(self, name, text):
        case = next(case for case in resume_review.CASES if case.name == name)
        return case.checks[-1](resume_review.Run(report_parse.parse(text), []))

    def assert_outcome(self, name, valid, invalid):
        self.assertIsNone(self.run_check(name, valid))
        for text in invalid:
            with self.subTest(case=name, text=text):
                self.assertIsNotNone(self.run_check(name, text))

    def test_summary_ownership_requires_grounded_rewrites(self):
        valid = (
            "Summary\nCurrent: Senior Software Engineer building web and AI products with TypeScript and Python.\n"
            "Proposed: Senior Software Engineer building support products for 20 companies, "
            "including a LangGraph agent runtime handling 900 monthly conversations.\n"
            "Rationale: Concrete delivery makes the broad summary specific.\n"
            "Source: private data/experiences.yml, Lumen Systems summary[3]; absent from the CV.\n"
            "E1.B1\nCurrent: Launched a support assistant serving 20 companies and handling "
            "900 customer conversations per month.\n"
            "Proposed: Built the LangGraph runtime for the support assistant serving 20 companies "
            "and handling 900 monthly conversations, with retrieval and deterministic staff handoff.\n"
            "Rationale: Surface supported ownership without crediting private facts to the current CV.\n"
        )
        insertion = valid.replace("Current: Launched a support assistant serving 20 companies and handling "
                                  "900 customer conversations per month.", "Current: Missing.")
        insertion = insertion.replace("900 monthly conversations", "monthly conversations")
        self.assertIsNone(self.run_check("summary_ownership", insertion))
        self.assertIsNone(self.run_check("summary_ownership", insertion.replace(
            "Current: Missing.", "Current: The Skills line lists LangGraph, but no bullet names it.")))
        self.assertIsNone(self.run_check("summary_ownership", insertion.replace(
            "Current: Missing.", "Current: E1 has three bullets. LangGraph appears only in Skills.")))
        for stage_limit in (
            "The source does not establish production usage.",
            "Delivery stage (E1.B1): is the assistant in production, a pilot, or internal use?",
            "Confirm whether the source documents external rollout.",
            "State the assistant's delivery stage (production, pilot or internal) once you confirm it.",
        ):
            with self.subTest(stage_limit=stage_limit):
                self.assertIsNone(self.run_check("summary_ownership", valid + stage_limit))
        self.assert_outcome("summary_ownership", valid, [
            "", "LangGraph runtime 20 900 E1.B1 private experiences.yml rationale",
            valid.replace("Proposed:", "Current:"),
            valid.replace("private data/experiences.yml", "the profile"),
            valid.replace("Proposed: Senior Software Engineer", "Proposed: Senior AI Engineer"),
            valid + " E1.B1 demonstrates production usage.",
            valid + " | Achievement bullets | 3 | E1.B1 demonstrates live deployment. |",
            valid + " Rationale: The production assistant demonstrates customer adoption.",
            valid + " For: a Senior title with concrete production usage in E1.B1.\n"
                    "Delivery stage: is the assistant in production, a pilot, or internal use?",
            insertion.replace("Current: Missing.", "Current: Skills lists LangGraph."),
        ])

    def test_publication_preserves_delivery_and_limits_adoption(self):
        valid = (
            "E1.B1\nCurrent: Published the app in about three months.\n"
            "Proposed: Published the app on the App Store and Google Play in about three months, "
            "with use limited to internal testing.\n"
            "Rationale: Distinguish publication from adoption.\n"
            "Source: data/experiences.yml, Lumen Systems summary[2].\n"
        )
        self.assertIsNone(self.run_check("publication_internal_testing",
                                        valid.replace("internal testing", "tested internally")))
        # These representative excerpts came from a safe live review output.
        source_limits = (
            "Was it in production, a pilot or internal testing? "
            'Source: "No external staff rollout occurred."\n'
            "Rationale: a reader can otherwise assume production use."
        )
        self.assertIsNone(self.run_check("publication_internal_testing", valid + source_limits))
        self.assert_outcome("publication_internal_testing", valid, [
            "", "App Store Google Play three months internal testing experiences.yml",
            valid.replace("internal testing", "external customer use"),
            valid.replace("three months", "several months"),
            valid.replace("internal testing.", "internal testing with zero duplicate submissions."),
            valid + " The CV overstates publication because use was internal.",
            valid + " E1.B1 conflicts with internal testing.",
            valid.replace("internal testing", "internal testing with the client team"),
            valid + " | Recruiter evidence | The app demonstrates production use. |",
            valid + " Rationale: Both stores prove external adoption.",
            valid + " The app was deployed externally and used by field staff.",
        ])

    def test_consolidation_distinguishes_history_from_public_timeline(self):
        valid = (
            "The intentional consolidated engagement remains May 2025 to Sep 2026. "
            "The historical vendor record is Jun 2025 to Sep 2025. "
            "As of 2026-11-07, these are historical dates. Keep the user-approved timeline."
        )
        self.assert_outcome("intentional_consolidation", valid, [
            "", "May 2025 Sep 2026",
            valid + " You should split the consolidated entry.",
            valid + " The experience is future-dated.",
        ])

    def test_unverified_scope_requires_question_and_exact_date_conflict(self):
        valid = (
            "LangGraph is listed-only in Skills. Which LangGraph components did you implement?\n"
            "E1 header: Sep 2026 to May 2025 is reversed: the end is before the start. "
            "Confirm the actual dates before editing."
        )
        self.assertIsNone(self.run_check("unverified_scope_invalid_dates", valid +
                                        "\nProposed: Keep the account management you built. "
                                        "Remove LangGraph unless a role used it.\n"))
        self.assert_outcome("unverified_scope_invalid_dates", valid, [
            "", "LangGraph Skills Sep 2026 May 2025",
            valid.replace("Which LangGraph components did you implement?", "LangGraph is a useful tool."),
            valid.replace("May 2025", "May 2026"),
            valid + "\nProposed: Built the LangGraph runtime for the customer portal.\n",
        ])

    def test_stage_check_scopes_questions_and_negation_to_each_claim(self):
        for text in (
            "The source does not establish production usage.",
            "The counts don't establish production deployment; don't call it production.",
            "I haven't called this production.",
            "What was your role and what is its deployment stage (pilot or production)?",
            "Production usage is not established.",
            "No external staff rollout occurred.",
            "Was this production use or internal testing?",
            "Question: Did the source document external adoption?",
            "Confirm whether the app was used externally.",
        ):
            with self.subTest(allowed=text):
                self.assertFalse(resume_review.unsupported_stage_assertion(text, external_use=True))
        for text in (
            "Production usage is unconfirmed; the production assistant serves 20 companies.",
            "The source does not establish production use, but external rollout occurred.",
            "Can you confirm production use? E1.B1 shows production deployment.",
            "Which production services did you own?",
            "Not a prototype, but a production assistant.",
            "Traffic metrics alone suggest production use.",
            "Production use is not only established but quantified.",
        ):
            with self.subTest(unsupported=text):
                self.assertTrue(resume_review.unsupported_stage_assertion(text, external_use=True))

    def test_effective_cv_accepts_retention_and_rejects_forced_rewrites(self):
        valid = "Do next\nKeep the effective summary and bullets. No material wording change is needed."
        for retained in (
            valid,
            "Do next\n1. Retain current summary and bullets.",
            "Do next\nNo substantive edits are needed to this CV.",
            "The existing summary and experience bullets are effective as written.",
            "Recruiter read\nWhat changed for staff using the ingestion pipeline?\n\n"
            "Do next\nPreserve existing CV wording. The CV states a production support assistant.",
        ):
            with self.subTest(retained=retained):
                self.assertIsNone(self.run_check("already_effective_cv", retained))
        self.assert_outcome("already_effective_cv", valid, [
            "", "Software Engineer 20 companies 900 conversations",
            "Keep contact information current.",
            "The honest internal-testing wording is worth keeping.\nProposed: none yet.",
            valid + "\nProposed: Staff Engineer who increased revenue by 50%.\n",
            valid + "\nProposed: Keep the existing summary but add Docker.\n",
            valid + " But retain existing copy and add tenure.",
            valid + "\nProposed: no wording yet. Ask whether there is testing experience.\n",
            valid + "\nProposed: optionally split the existing two-sentence bullet.\n",
            valid + "\n1. Add outcome evidence if the numbers exist.\nProposed: none.\n",
            valid + "\n1. Retain current summary.\nQuestion: can you add pipeline metrics?\n",
            valid + " Brazilian postings require Docker.",
            valid + " Brazilian postings commonly screen on cloud keywords.",
            valid + " The CV does not establish production usage.",
            # Representative excerpts from the previous false-pass live report:
            'The "production" and delivery stage of the assistant is not established by the CV.\n'
            "The CV says 'production support assistant', but that stage isn't established.\n"
            "Do next\n"
            "1. Edit the base CV, E1.B1 or Summary (confirm the stage first).\n"
            "2. Add outcome evidence with /job-stories add, if one exists.\n"
            "Keep the Summary, E1.B2 and the layout as they are.",
            # Representative earlier output with three manufactured edit tasks:
            "Do next\n1. E1.B2 (edit the base CV, if the numbers exist).\nProposed: none yet.\n"
            "2. E1.B3 (edit the base CV).\nProposed: Split it into two bullets.\n"
            "3. Summary (edit the base CV).\nProposed: Add tenure, for example 4+ years.\n"
            "The internal-testing wording is worth keeping.",
        ])

    def test_followup_wording_variants_keep_claim_scope(self):
        self.assertIsNone(self.run_check(
            "already_effective_cv", "Do next\nNo action passes; retain the CV as is."))
        for text in (
            "Launched doesn't say who owned the build or whether it ran in production for customers.",
            "The proposed wording stops a reader from inferring production use.",
            '"Published" alone suggests a live rollout.',
            'A recruiter reading "published" may assume production use.',
        ):
            self.assertFalse(resume_review.unsupported_stage_assertion(text, external_use=True))
            self.assertTrue(resume_review.unsupported_stage_assertion(
                text + " The production assistant serves 20 companies.", external_use=True))
        self.assertFalse(resume_review.unsupported_stage_assertion(
            'It says "published", not "in production" or "launched".', external_use=True))
        retained = "Do next\nNo action passes the materiality gate; retain the current text."
        self.assertIsNone(self.run_check("already_effective_cv", retained))
        self.assertIsNotNone(self.run_check(
            "already_effective_cv", retained +
            "\nIf you want a later improvement, answer the hesitations. "
            "Add a user outcome only if it is true."))

    def test_control_praise_does_not_upgrade_performance_to_production(self):
        for case in ("strongest_proof_gaps", "ownership_inflation"):
            self.assert_outcome(
                case,
                "- **For:** E1.B1 shows measured API performance work.\n"
                "- **Against:** Production Kubernetes is not shown.\n",
                ["- **For:** E1.B1 shows measured production performance work.\n"
                 "- **Hesitations:** Was Kubernetes used in production?"])
        text = "- **For:** E1.B1 shows performance work; production stage is unverified."
        self.assertIsNone(self.run_check("strongest_proof_gaps", text))

    def test_proposal_extraction_excludes_current_and_sources(self):
        text = (
            "1. E1.B1\n**Current:** Current scope.\n"
            "**Proposed:** New wording.\n> Supporting continuation.\n"
            "**Rationale:** Why this helps.\n**Sources:** Private fact.\n"
            "2. Summary\n- Suggested wording: Another proposal.\n- Evidence: Another fact.\n"
        )
        self.assertEqual(resume_review.proposed_passages(text),
                         ["New wording. Supporting continuation.", "Another proposal."])

    def test_effective_cv_allows_benign_market_wording(self):
        valid = "Do next\nKeep the effective summary and bullets. No material wording change is needed."
        for line in (
            "Target: Software Engineer roles in Brazil (your request); no posting supplied, "
            "so no requirement matrix.",
            "Residence matches the Brazil target, so no work-authorization line is required.",
            "Target: Software Engineer roles in Brazil, no screening assumptions applied.",
        ):
            with self.subTest(line=line):
                self.assertIsNone(self.run_check("already_effective_cv", line + "\n" + valid))
        for claim in (
            "In Brazil, Docker is required.",
            "Brazil roles must have Docker.",
            "ATS tools screen for Docker.",
        ):
            with self.subTest(claim=claim):
                self.assertIsNotNone(self.run_check("already_effective_cv", valid + " " + claim))

    def test_stage_check_accepts_unknown_and_limited_wording(self):
        for text in (
            "It is unclear whether the assistant reached production.",
            "Production use is not stated in the CV.",
            "The CV is silent on production use.",
            "Use was internal testing rather than external users.",
            "The app was published before any external rollout.",
            "Published the app in about three months, used in internal testing, not by external staff.",
        ):
            with self.subTest(allowed=text):
                self.assertFalse(resume_review.unsupported_stage_assertion(text, external_use=True))
        for text in (
            "Production use is stated in the CV.",
            "It is clear that the assistant reached production.",
            "Use was external users rather than internal testing.",
            "The app was published after external rollout.",
            "Used by external staff, not internal testing.",
            "It is unclear who owned it; the assistant reached production.",
            "Production use is not stated in the CV, but the production assistant serves 20 companies.",
            "The CV is silent on ownership of the production assistant.",
        ):
            with self.subTest(unsupported=text):
                self.assertTrue(resume_review.unsupported_stage_assertion(text, external_use=True))

    def test_control_praise_ignores_posting_requirements(self):
        self.assertIsNone(self.run_check(
            "strongest_proof_gaps", "- **For:** The posting's Kubernetes in production requirement."))
        for praise in (
            "- **For:** The posting asks for Kubernetes; E1.B1 ran it in production.",
            "- **For:** E1.B1 meets the posting's Kubernetes requirement with a production assistant.",
        ):
            with self.subTest(praise=praise):
                self.assertIsNotNone(self.run_check("strongest_proof_gaps", praise))

    def test_effective_cv_stage_denial_skips_publication_only_bullet(self):
        valid = "Do next\nKeep the effective summary and bullets. No material wording change is needed."
        for line in (
            "E1.B3: store publication alone does not establish production use, "
            "and the CV correctly limits it to internal testing.",
            "E1.B3: production use is not established by the store release",
        ):
            with self.subTest(line=line):
                self.assertIsNone(self.run_check("already_effective_cv", line + "\n" + valid))
        self.assertIsNotNone(self.run_check(
            "already_effective_cv", "E1.B1 production is not established, unlike E1.B3 internal testing.\n" + valid))

    def test_effective_cv_reads_tasks_under_heading_variants(self):
        tasks = "1. Add Docker to Skills.\n2. Split E1.B3 into two bullets.\nKeep the effective summary and bullets."
        retained = "Keep the effective summary and bullets. No material wording change is needed."
        for heading in ("8. Do next", "8. Do next:", "## 8. Do next", "**Do next:**", "### Do next (up to three)"):
            with self.subTest(heading=heading):
                self.assertIsNotNone(self.run_check("already_effective_cv", heading + "\n" + tasks))
                self.assertIsNone(self.run_check("already_effective_cv", heading + "\n" + retained))
        self.assertIsNotNone(self.run_check(
            "already_effective_cv", "8. Do next: Add Docker to Skills. Keep the effective summary and bullets."))

    def test_consolidation_ignores_negated_advice(self):
        valid = (
            "The intentional consolidated engagement remains May 2025 to Sep 2026. "
            "The historical vendor record is Jun 2025 to Sep 2025. "
            "As of 2026-11-07, these are historical dates. Keep the user-approved timeline."
        )
        for sentence in (
            "Do not change the May 2025 start to Sep 2025.",
            "Don't replace the May 2025 start with the Sep 2025 direct-employment date.",
            "There is no need to split the entry.",
            "No dates are future-dated.",
        ):
            with self.subTest(sentence=sentence):
                self.assertIsNone(self.run_check("intentional_consolidation", valid + " " + sentence))
        for sentence in (
            "Change the May 2025 start to Sep 2025.",
            "You need to split the entry.",
            "Do not keep it; change the May 2025 start to Sep 2025.",
            "Change the May 2025 start to Sep 2025, not Jun 2025.",
        ):
            with self.subTest(sentence=sentence):
                self.assertIsNotNone(self.run_check("intentional_consolidation", valid + " " + sentence))

    def test_proposal_extraction_stops_at_question_labels(self):
        proposal = "Built React account-management workflows and Python endpoints."
        ask = "Which LangGraph parts have you built or operated?"
        for label in ("Questions: ", "Open question: ", "Confirm: ", "**Questions:** ", "- Questions: ",
                      "Clarifying question: ", "To confirm: ", "### Questions\n"):
            with self.subTest(label=label):
                self.assertEqual(resume_review.proposed_passages(f"Proposed: {proposal}\n{label}{ask}\n"), [proposal])
        for body in ("Confirmed zero data loss with reconciliation checks.", "Languages: TypeScript, Python"):
            with self.subTest(body=body):
                self.assertEqual(resume_review.proposed_passages(f"Proposed: {proposal}\n{body}\n"),
                                 [f"{proposal} {body}"])
        valid = (
            "LangGraph is listed-only in Skills. Which LangGraph components did you implement?\n"
            "E1 header: Sep 2026 to May 2025 is reversed: the end is before the start.\n"
        )
        self.assertIsNone(self.run_check(
            "unverified_scope_invalid_dates", f"{valid}Proposed: {proposal}\nQuestions: {ask}\n"))

    def test_new_profiles_prepare_without_gold_in_the_prompt(self):
        for name in ("summary_ownership", "publication_internal_testing", "intentional_consolidation"):
            with self.subTest(case=name), tempfile.TemporaryDirectory() as tmp:
                case = next(case for case in resume_review.CASES if case.name == name)
                prompt = resume_review.prompt_for(case, Path(tmp), isolated=True)
                profile = Path(tmp) / "profile"
                self.assertTrue((profile / "data" / "experiences.yml").is_file())
                self.assertTrue((profile / "data" / "job_search.yaml").is_file())
                self.assertNotIn("ground_truth", prompt)
                self.assertNotIn("required review behavior", prompt.lower())


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

    def test_linkedin_check_flags_a_title_mismatch(self):
        case = next(c for c in resume_review.CASES if c.name == "linkedin_mismatch")
        for text, accepted in (
            ("LinkedIn title Staff Platform Engineer differs from the CV's Senior Backend Engineer.", True),
            ("LinkedIn agrees with the CV.", False),
        ):
            with self.subTest(text=text):
                run = resume_review.Run(report_parse.parse(text), [])
                self.assertEqual(case.checks[-1](run) is None, accepted)

    def test_every_edit_matches_the_base_fixture(self):
        base = (resume_review.FIXTURES / "base.md").read_text(encoding="utf-8")
        for case in resume_review.CASES:
            if getattr(case, "profile", False):
                continue  # Complete smoke profiles are checked separately below.
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


class EvidenceBenchmarkTests(unittest.TestCase):
    def benchmark(self):
        import evidence_benchmark
        return evidence_benchmark

    def gold(self):
        return {
            "supported": {"R1": ["E1.B1"], "R2": ["E2.B3"]},
            "actions": {"R1": {"support": "direct", "actions": ["clarify_wording"]},
                        "R2": {"support": "listed_only", "actions": ["request_example"]}},
            "strongest": ["E1.B1"], "pdf": ["extraction_failure", "source_mismatch"],
        }

    def test_snapshot_is_frozen_and_cannot_overwrite(self):
        bench = self.benchmark()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source"
            source.mkdir()
            (source / "SKILL.md").write_text("before", encoding="utf-8")
            metadata = bench.snapshot_skills(source, root / "snapshot")
            (source / "SKILL.md").write_text("after", encoding="utf-8")
            self.assertEqual((root / "snapshot" / "SKILL.md").read_text(), "before")
            self.assertTrue(metadata["hash"])
            with self.assertRaises(FileExistsError):
                bench.snapshot_skills(source, root / "snapshot")

    def test_production_answers_have_explicit_source_context(self):
        bench = self.benchmark()
        self.assertEqual(bench.BENCHMARK_VERSION, 2)
        source = (EVALS / "fixtures/resume_review/profiles/selected_job_evidence/data/experiences.yml").read_text(encoding="utf-8")
        self.assertIn("Operated production Go services on AWS EKS (Kubernetes)", source)
        self.assertIn("PostgreSQL partitioning for production route queries", source)

    def test_comparison_rejects_mixed_benchmark_versions(self):
        bench = self.benchmark()
        shared = {"model": "fixed", "benchmark_hash": "same", "cli_version": "same"}
        before = dict(shared, phase="before", benchmark_version=2)
        after = dict(shared, phase="after", benchmark_version=1)
        control = dict(shared, phase="control", benchmark_version=2)
        with self.assertRaisesRegex(ValueError, "benchmark version mismatch"):
            bench._validate_phase_bundle(before, after, control)

    def test_comparison_rejects_matching_stale_benchmark_hashes_before_judging(self):
        bench = self.benchmark()
        shared = {"model": "fixed", "benchmark_hash": bench.benchmark_digest(),
                  "cli_version": "same", "actual_model": "fixed"}
        phases = [dict(shared, phase=phase) for phase in ("before", "after", "control")]
        self.assertEqual(bench._validate_phase_bundle(*phases)["benchmark_hash"], shared["benchmark_hash"])
        with mock.patch.object(bench, "benchmark_digest", return_value="changed"):
            with self.assertRaisesRegex(ValueError, "current assessor inputs"):
                bench._validate_phase_bundle(*phases)

    @unittest.skipIf(os.name == "nt", "executable script fixture is POSIX-specific")
    def test_assessor_passes_large_prompt_via_stdin(self):
        bench = self.benchmark()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli = root / "claude"
            cli.write_text(
                "#!/usr/bin/env python3\n"
                "import json, sys\n"
                "print(json.dumps({'args': sys.argv[1:], 'prompt': sys.stdin.read()}))\n",
                encoding="utf-8",
            )
            cli.chmod(0o755)
            report = "report content " * 90000
            items = [{"phase": "after", "run_id": "run-1", "report": report}]
            with mock.patch.object(bench.shutil, "which", return_value=str(cli)):
                result = bench._assess_case("selected_job_evidence", items, "model", "model", root)
            self.assertEqual(result["returncode"], 0, result["error"])
            received = json.loads((root / "assessments" / "selected_job_evidence" / "stdout.json").read_text())
            self.assertIn(report, received["prompt"])
            self.assertGreater(len(received["prompt"].encode("utf-8")), 1048576)
            self.assertEqual(received["args"][:3], ["-p", "--output-format", "json"])
            self.assertNotIn(report, received["args"])

    def test_runtime_summary_excludes_unmeasured_placeholders(self):
        bench = self.benchmark()
        items = [
            {"status": "runner_error", "runtime_seconds": 0.0, "tool_count": 0},
            {"status": "missing_record", "runtime_seconds": 0.0, "tool_count": 0},
            {"status": "complete", "runtime_seconds": 1.24, "tool_count": 3},
            {"status": "cli_error", "runtime_seconds": 2.0, "tool_count": 1},
        ]
        result = bench._runtime_tool_summary(items)
        self.assertEqual(result["scheduled_runs"], 4)
        self.assertEqual(result["runtime_seconds"], {"median": 1.62, "min": 1.24, "max": 2.0})
        self.assertEqual(result["tool_count"], {"median": 2.0, "min": 1, "max": 3})
        empty = bench._runtime_tool_summary(items[:2])
        self.assertEqual(empty["scheduled_runs"], 2)
        self.assertEqual(empty["runtime_seconds"], {"median": None, "min": None, "max": None})
        self.assertEqual(empty["tool_count"], {"median": None, "min": None, "max": None})

    def test_duplicate_links_do_not_inflate_precision_or_coverage(self):
        result = self.benchmark().score_claims(self.gold(), {
            "links": [["R1", "E1.B1"], ["R1", "E1.B1"], ["R2", "invented"]],
            "actions": {"R1": {"support": "direct", "action": "clarify_wording"},
                        "R2": {"support": "direct", "action": "request_example"}},
            "strongest": "E1.B1", "pdf": ["extraction_failure"],
            "ownership_violation": False, "private_credit_violation": False,
        })
        self.assertEqual(result["link_precision"], [1, 2])
        self.assertEqual(result["requirement_coverage"], [1, 2])
        self.assertEqual(result["gap_actions"], [1, 2])
        self.assertEqual(result["strongest_proof"], [1, 1])
        self.assertEqual(result["pdf_diagnosis"], [1, 2])

    def test_no_links_are_not_perfect_precision(self):
        result = self.benchmark().score_claims(self.gold(), {
            "links": [], "actions": {}, "strongest": None, "pdf": [],
            "ownership_violation": False, "private_credit_violation": False,
        })
        self.assertEqual(result["link_precision"], [0, 0])
        self.assertEqual(result["requirement_coverage"], [0, 2])

    def test_zero_denominator_has_no_rate_or_delta(self):
        self.assertIsNone(self.benchmark()._ratio([0, 0]))

    def test_safety_allows_no_violations_while_behavior_allows_one_miss(self):
        bench = self.benchmark()
        self.assertEqual(bench._required_successes("ownership_safe", 3), 3)
        self.assertEqual(bench._required_successes("private_credit_safe", 3), 3)
        self.assertEqual(bench._required_successes("link:R1", 3), 2)

    def test_phase_identity_prevents_overwriting_judgments(self):
        bench = self.benchmark()
        run_id = "selected_job_evidence-r1"
        claims = {("before", run_id): {"links": [], "actions": {}, "strongest": None, "pdf": []},
                  ("after", run_id): {"links": [["R1", "E1.B1"]], "actions": {}, "strongest": None, "pdf": []}}
        results = {}
        for phase in ("before", "after"):
            items = [{"phase": phase, "run_id": run_id, "status": "complete"}]
            results[phase] = bench._aggregate_case_scores("selected_job_evidence", items, claims)
        self.assertEqual(results["before"]["metrics"]["requirement_coverage"][0], 0)
        self.assertEqual(results["after"]["metrics"]["requirement_coverage"][0], 1)

    def test_failed_runs_keep_quality_denominators_and_cannot_earn_credit(self):
        bench = self.benchmark()
        key = ("after", "selected_job_evidence-r1")
        items = [{"phase": key[0], "run_id": key[1], "status": "cli_error"}]
        claims = {key: {"links": [["R1", "E1.B1"]], "actions": {}, "strongest": None, "pdf": []}}
        result = bench._aggregate_case_scores("selected_job_evidence", items, claims)
        self.assertEqual(result["metrics"]["requirement_coverage"],
                         [0, len(bench.GOLD["selected_job_evidence"]["supported"])])
        self.assertEqual(result["failed_runs"], 1)
        self.assertEqual(result["scheduled_runs"], 1)

    def test_safety_counts_assessed_failed_reports_and_excludes_unassessed_runs(self):
        bench = self.benchmark()
        items = [{"phase": "after", "run_id": f"r{i}", "status": status}
                 for i, status in enumerate(("complete", "cli_error", "missing_report"))]
        claims = {("after", "r0"): {"ownership_violation": True, "private_credit_violation": False},
                  ("after", "r1"): {"ownership_violation": True, "private_credit_violation": True,
                                    "links": [["R1", "E1.B1"]]}}
        result = bench._aggregate_case_scores("ownership_inflation", items, claims)
        self.assertEqual(result["metrics"]["ownership_violation"], [2, 2])
        self.assertEqual(result["metrics"]["private_credit_violation"], [1, 2])
        self.assertEqual(result["metrics"]["requirement_coverage"][0], 0)
        self.assertEqual(result["assertions"]["ownership_safe"], [0, 3])

    def test_strongest_proof_accepts_one_of_several_equivalent_sources(self):
        gold = self.gold()
        gold["strongest"] = ["E1.B1", "E1.B2", "E2.B3"]
        result = self.benchmark().score_claims(gold, {
            "links": [], "actions": {}, "strongest": "E1.B2", "pdf": [],
            "ownership_violation": False, "private_credit_violation": False,
        })
        self.assertEqual(result["strongest_proof"], [1, 1])

    def test_pdf_false_positive_is_penalized(self):
        result = self.benchmark().score_claims(self.gold(), {
            "links": [], "actions": {}, "strongest": None,
            "pdf": ["extraction_failure", "source_mismatch", "invented_failure"],
            "ownership_violation": False, "private_credit_violation": False,
        })
        self.assertEqual(result["pdf_diagnosis"], [2, 3])

    def test_all_four_cases_and_gold_are_defined(self):
        bench = self.benchmark()
        expected = {"selected_job_evidence", "strongest_proof_gaps", "ownership_inflation", "pdf_with_source"}
        self.assertEqual(set(bench.GOLD), expected)
        names = {case.name for case in resume_review.CASES}
        self.assertTrue(expected <= names)

    def test_new_smokes_build_valid_private_profiles_and_keep_gold_out_of_prompts(self):
        for case in resume_review.CASES:
            if case.name not in self.benchmark().GOLD:
                continue
            with self.subTest(case=case.name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                prompt = resume_review.prompt_for(case, root)
                self.assertTrue((root / "profile" / "data" / "job_search.yaml").is_file())
                self.assertTrue((root / "profile" / "data" / "basics.yaml").is_file())
                self.assertNotIn("ground_truth", prompt)
                self.assertNotIn("GOLD", prompt)
                self.assertFalse((root / "profile" / "tmp").exists())

    def test_runner_uses_snapshot_and_isolated_profile(self):
        case = next(c for c in resume_review.CASES if c.name == "ownership_inflation")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "work"
            root.mkdir()
            snapshot = Path(tmp) / "snapshot"
            skill = snapshot / "job-resume-review"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text("frozen", encoding="utf-8")
            completed = mock.Mock(returncode=0, stdout='{"type":"result","result":"done"}\n', stderr="")
            with mock.patch.object(resume_review.subprocess, "run", return_value=completed) as run:
                resume_review.run_case(case, root, "fixed-model-id", snapshot, True)
            args, kwargs = run.call_args
            self.assertIn("--safe-mode", args[0])
            self.assertIn("--no-session-persistence", args[0])
            self.assertIn(str(skill / "SKILL.md"), args[0][2])
            self.assertEqual(kwargs["env"]["PROFILE_ROOT"], str(root / "profile"))
            self.assertEqual(kwargs["env"]["TMPDIR"], str(root / "tmp"))
            self.assertEqual(kwargs["env"]["PYTHONDONTWRITEBYTECODE"], "1")

    def test_prompt_hash_normalizes_symlinked_run_and_skill_paths(self):
        bench = self.benchmark()
        case = next(c for c in resume_review.CASES if c.name == "selected_job_evidence")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real = root / "real"
            real.mkdir()
            link = root / "link"
            try:
                link.symlink_to(real, target_is_directory=True)
            except OSError as error:
                self.skipTest(f"symlinks unavailable: {error}")
            hashes = []
            for name in ("one", "two"):
                work = link / name
                work.mkdir()
                skills = link / "skills"
                prompt = resume_review.prompt_for(case, work, skills, isolated=True)
                hashes.append(bench._normal_prompt_hash(prompt, work, skills))
            self.assertEqual(hashes[0], hashes[1])

    def test_formatting_and_tools_are_not_quality_inputs(self):
        text = self.benchmark().JUDGE_INSTRUCTIONS.lower()
        self.assertIn("format", text)
        self.assertIn("tool", text)
        self.assertIn("do not reward", text)

    def test_assessor_cannot_award_an_action_without_a_report_excerpt(self):
        bench = self.benchmark()
        claims = {
            "links": [], "strongest": [], "pdf": [],
            "actions": {key: {"support": item["support"], "action": item["actions"][0],
                              "excerpt": "", "reason": "The report omitted this action."}
                        for key, item in self.gold()["actions"].items()},
            "ownership_violation": {"value": False, "excerpt": "", "reason": "No claim."},
            "private_credit_violation": {"value": False, "excerpt": "", "reason": "No claim."},
        }
        normalized, error = bench._validate_assessment({"reports": [{"id": "A", "claims": claims}]},
                                                      {"A": "No actions were given."}, self.gold())
        self.assertEqual(error, "")
        self.assertEqual(bench.score_claims(self.gold(), normalized["A"])["gap_actions"], [0, 2])

    def test_phase_refuses_invalid_repeats_and_existing_output(self):
        bench = self.benchmark()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValueError):
                bench.run_phase("before", SKILL, "model", root / "out", 0)
            with self.assertRaises(FileExistsError):
                bench.run_phase("before", SKILL, "model", root, 1)

    def test_phase_persists_worker_exceptions_and_normal_completion(self):
        bench = self.benchmark()
        def run(case, repeat, work, skills, model):
            if case == bench.CASE_NAMES[0]:
                raise RuntimeError("worker failed")
            return {"case": case, "repeat": repeat, "status": "complete", "actual_model_ids": [model]}
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(bench, "_cli_version", return_value="stub"), \
                mock.patch.object(bench, "_run_one", side_effect=run):
            output = Path(tmp) / "phase"
            result = bench.run_phase("before", SKILL, "model", output, 1)
            metadata = json.loads((output / "metadata.json").read_text())
            self.assertEqual(result["status"], "completed_with_failures")
            self.assertEqual(len(result["runs"]), len(bench.CASE_NAMES))
            self.assertEqual(metadata["failed_run_count"], 1)

    @unittest.skipIf(os.name == "nt", "SIGINT process behavior is POSIX-specific")
    def test_interrupt_cancels_queued_runs_and_persists_state(self):
        script = '''\
import sys, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import evidence_benchmark as b
started = Path(sys.argv[4])
def worker(case, repeat, work, skills, model):
    with started.open("a") as stream:
        stream.write(case + "\\n")
    time.sleep(2)
    return {"case": case, "repeat": repeat, "status": "complete", "actual_model_ids": [model]}
b._cli_version = lambda: "stub"
b._run_one = worker
b.run_phase("before", Path(sys.argv[2]), "model", Path(sys.argv[3]), 3)
'''
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            output, starts = root / "phase", root / "starts"
            proc = subprocess.Popen([sys.executable, "-c", script, str(EVALS), str(SKILL),
                                     str(output), str(starts)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if starts.exists() and len(starts.read_text().splitlines()) >= 3:
                        break
                    if proc.poll() is not None:
                        self.fail(f"phase exited before starting workers: {proc.communicate()}")
                    time.sleep(0.02)
                else:
                    self.fail("workers did not start")
                proc.send_signal(signal.SIGINT)
                proc.communicate(timeout=10)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(len(starts.read_text().splitlines()), 3)
                metadata = json.loads((output / "metadata.json").read_text())
                results = json.loads((output / "results.json").read_text())
                self.assertEqual((metadata["status"], results["status"]), ("interrupted", "interrupted"))
                self.assertEqual(metadata["cancelled_run_count"], 9)
                self.assertEqual(metadata["completed_run_count"], len(results["runs"]))
                self.assertEqual(metadata["unrecorded_run_count"], 12 - len(results["runs"]))
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.communicate()

    def test_comparison_refuses_model_mismatch_before_judging(self):
        bench = self.benchmark()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for phase, model in (("before", "one"), ("after", "two"), ("control", "one")):
                directory = root / phase
                directory.mkdir()
                (directory / "results.json").write_text(json.dumps({
                    "phase": phase, "model": model, "benchmark_hash": "same",
                    "cli_version": "same", "runs": [],
                }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "model"):
                bench.compare(root / "before", root / "after", root / "control", root / "report")

    @unittest.skipUnless(shutil.which("pdftotext"), "needs Poppler pdftotext")
    def test_actual_text_fixture_changes_extraction_not_visible_text(self):
        scan_cv = load(SKILL / "job-resume-review" / "scripts" / "scan_cv.py")
        with tempfile.TemporaryDirectory() as tmp:
            path = write_pdf(Path(tmp) / "actual.pdf", [], positioned=[(56, 760, "PostgreSQL", "Postgre SQL")])
            extracted = scan_cv.extract_pdf(path)
            self.assertIn("Postgre SQL", extracted)
            self.assertIn(b"(PostgreSQL)", path.read_bytes())


@unittest.skipUnless(shutil.which("pdftotext"), "needs Poppler pdftotext")
class SourceGroundedPdfRegressionTests(unittest.TestCase):
    def evaluator(self):
        return load(SKILL / "job-resume-refine" / "scripts" / "evaluate_pdf.py")

    def manifest(self, lines):
        return {"schema_version": 1,
                "blocks": [{"id": "B" + str(i), "parts": [line]} for i, line in enumerate(lines)],
                "terms": []}

    def test_english_and_portuguese_recover_equivalent_independent_inventories(self):
        results = []
        for lines in (["Experience", "Software Engineer", "Built Python services.", "Education"],
                      ["Experiência", "Engenheiro de Software", "Criei serviços Python.", "Formação"]):
            with tempfile.TemporaryDirectory() as tmp:
                expected = self.manifest(lines)
                path = write_pdf(Path(tmp) / "cv.pdf", lines)
                result = self.evaluator().evaluate_pdf(path, expected)
                self.assertEqual(result["verdict"], "PASS")
                results.append({mode: value["blocks"] for mode, value in result["modes"].items()})
        self.assertEqual(results[0], results[1])

    def test_repeated_summary_text_cannot_mask_a_missing_achievement(self):
        expected = self.manifest(["Built Python services.", "EXPERIENCE", "Built Python services."])
        with tempfile.TemporaryDirectory() as tmp:
            path = write_pdf(Path(tmp) / "missing.pdf", ["Built Python services.", "EXPERIENCE"])
            result = self.evaluator().evaluate_pdf(path, expected)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertTrue(all(mode["blocks"]["recovered"] < mode["blocks"]["total"]
                            for mode in result["modes"].values()))

    def test_columns_fail_on_observed_interleaving(self):
        expected = self.manifest(["EXPERIENCE", "Engineer at Lumen", "Built production services.",
                                  "SKILLS", "Python and Go"])
        positioned = [(56, 780, "EXPERIENCE", None), (320, 780, "SKILLS", None),
                      (56, 760, "Engineer at Lumen", None), (320, 760, "Python and Go", None),
                      (56, 740, "Built production services.", None)]
        with tempfile.TemporaryDirectory() as tmp:
            path = write_pdf(Path(tmp) / "columns.pdf", [], positioned=positioned)
            result = self.evaluator().evaluate_pdf(path, expected)
        self.assertEqual(result["modes"]["layout"]["verdict"], "FAIL")
        self.assertTrue(result["modes"]["layout"]["issues"])

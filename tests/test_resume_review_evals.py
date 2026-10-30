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

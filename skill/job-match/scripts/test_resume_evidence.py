import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from resume_evidence import validate_payload


class EvidenceValidationTests(unittest.TestCase):
    def payload(self, support="direct", visibility="unassessed", origin="profile", kind="achievement"):
        return {
            "cases": [{"target": "job:1", "requirements": [{"id": "R1", "kind": "required", "text": "Python"}],
                       "sources": [{"id": "S1", "origin": origin, "kind": kind,
                                    "location": "data/experiences.yml[0].summary[0]", "text": "Built Python services."}],
                       "cv_assessed": visibility != "unassessed"}],
            "assessments": [{"target": "job:1", "requirements": [{"requirement_id": "R1", "support": support,
                             "source_ids": ["S1"], "cv_visibility": visibility, "question": None}]}],
        }

    def row(self, payload):
        return payload["assessments"][0]["requirements"][0]

    def assert_invalid(self, payload):
        result = validate_payload(payload)
        self.assertEqual(result["valid"], [])
        self.assertTrue(result["invalid"])
        self.assertTrue(result["invalid"][0]["errors"])

    def test_trusted_citations_and_inputs_are_preserved(self):
        payload = self.payload()
        original = copy.deepcopy(payload)
        result = validate_payload(payload)
        self.assertEqual(result["invalid"], [])
        row = result["valid"][0]["requirements"][0]
        self.assertEqual(row["action"], "inspect_cv")
        self.assertEqual(row["sources"], original["cases"][0]["sources"])
        self.assertEqual(payload, original)

    def test_direct_visibility_actions(self):
        for visibility, origin, action in (("explicit", "cv", "keep"), ("implicit", "cv", "clarify_wording"),
                                           ("absent", "profile", "surface_fact"), ("unassessed", "profile", "inspect_cv")):
            with self.subTest(visibility=visibility):
                result = validate_payload(self.payload(visibility=visibility, origin=origin))
                self.assertEqual(result["invalid"], [])
                self.assertEqual(result["valid"][0]["requirements"][0]["action"], action)

    def test_question_actions(self):
        for support, kind, action in (("partial", "achievement", "clarify_scope"), ("listed_only", "skill", "request_example"),
                                       ("unresolved", "skill", "confirm")):
            with self.subTest(support=support):
                payload = self.payload(support=support, kind=kind)
                self.row(payload)["question"] = "What was your contribution?"
                if support == "unresolved":
                    self.row(payload)["source_ids"] = []
                result = validate_payload(payload)
                self.assertEqual(result["invalid"], [])
                self.assertEqual(result["valid"][0]["requirements"][0]["action"], action)

    def test_confirmed_unmet_needs_explicit_limitation(self):
        self.assert_invalid(self.payload(support="confirmed_unmet"))
        payload = self.payload(support="confirmed_unmet", kind="limitation", origin="user")
        payload["cases"][0]["sources"][0]["text"] = "I have not used Python."
        result = validate_payload(payload)
        self.assertEqual(result["invalid"], [])
        self.assertEqual(result["valid"][0]["requirements"][0]["action"], "report_gap")

    def test_direct_and_partial_need_achievement_evidence(self):
        for support in ("direct", "partial"):
            for kind in ("skill", "summary", "limitation"):
                payload = self.payload(support=support, kind=kind)
                self.row(payload)["question"] = "What was your role?"
                with self.subTest(support=support, kind=kind):
                    self.assert_invalid(payload)

    def test_listed_only_does_not_accept_achievement_or_limitation(self):
        for kind in ("achievement", "limitation"):
            payload = self.payload(support="listed_only", kind=kind)
            self.row(payload)["question"] = "Which example supports this?"
            self.assert_invalid(payload)

    def test_questions_are_required_for_incomplete_support(self):
        for support in ("partial", "listed_only", "unresolved"):
            payload = self.payload(support=support, kind="skill" if support == "listed_only" else "achievement")
            self.assert_invalid(payload)
            self.row(payload)["question"] = " "
            self.assert_invalid(payload)

    def test_private_sources_cannot_establish_cv_visibility(self):
        for visibility in ("explicit", "implicit"):
            self.assert_invalid(self.payload(visibility=visibility))
        payload = self.payload(visibility="explicit", origin="cv")
        payload["cases"][0]["cv_assessed"] = False
        self.assert_invalid(payload)
        self.assert_invalid(self.payload(visibility="absent", origin="cv"))

    def test_cv_skill_mention_cannot_make_private_achievement_visible(self):
        payload = self.payload(visibility="explicit")
        payload["cases"][0]["sources"].append({"id": "CV.skills", "origin": "cv", "kind": "skill",
                                               "location": "Skills", "text": "Python"})
        self.row(payload)["source_ids"].append("CV.skills")
        self.assert_invalid(payload)
        self.row(payload)["source_ids"] = ["S1"]
        self.row(payload)["cv_visibility"] = "absent"
        result = validate_payload(payload)
        self.assertEqual(result["invalid"], [])
        self.assertEqual(result["valid"][0]["requirements"][0]["action"], "surface_fact")

    def test_missing_source_or_requirement_and_extra_worker_fields_are_rejected(self):
        for field, value in (("source_ids", ["invented"]), ("source_ids", ["S1", "S1"]),
                             ("requirement_id", "invented"), ("support", "excellent"),
                             ("cv_visibility", "probably"), ("quote", "Led a Python team.")):
            payload = self.payload()
            self.row(payload)[field] = value
            with self.subTest(field=field, value=value):
                self.assert_invalid(payload)

    def test_missing_duplicate_and_reordered_rows_are_rejected(self):
        for rows in ([], [self.row(self.payload()), self.row(self.payload())]):
            payload = self.payload()
            payload["assessments"][0]["requirements"] = rows
            self.assert_invalid(payload)
        payload = self.payload()
        payload["cases"][0]["requirements"].append({"id": "R2", "kind": "preferred", "text": "Python"})
        other = copy.deepcopy(self.row(payload))
        other["requirement_id"] = "R2"
        payload["assessments"][0]["requirements"].insert(0, other)
        self.assert_invalid(payload)
        payload["assessments"][0]["requirements"].reverse()
        self.assertEqual(validate_payload(payload)["invalid"], [])

    def test_invalid_case_does_not_drop_valid_target(self):
        payload = self.payload()
        bad_case = copy.deepcopy(payload["cases"][0])
        bad_case["target"] = "job:2"
        bad_assessment = copy.deepcopy(payload["assessments"][0])
        bad_assessment["target"] = "job:2"
        bad_assessment["requirements"][0]["source_ids"] = ["unknown"]
        payload["cases"].append(bad_case)
        payload["assessments"].append(bad_assessment)
        result = validate_payload(payload)
        self.assertEqual([row["target"] for row in result["valid"]], ["job:1"])
        self.assertEqual([row["target"] for row in result["invalid"]], ["job:2"])

    def test_empty_catalog_is_valid_and_unicode_is_verbatim(self):
        payload = self.payload()
        payload["cases"][0]["requirements"] = []
        payload["cases"][0]["sources"] = []
        payload["assessments"][0]["requirements"] = []
        self.assertEqual(validate_payload(payload)["invalid"], [])
        payload = self.payload()
        text = "Apoiei implantações em São Paulo — sem liderança."
        payload["cases"][0]["sources"][0]["text"] = text
        self.assertEqual(validate_payload(payload)["valid"][0]["requirements"][0]["sources"][0]["text"], text)

    def test_invalid_payload_types_and_duplicate_trusted_ids(self):
        for payload in (None, [], {}, {"cases": [], "assessments": [], "extra": True}):
            self.assert_invalid(payload)
        for key in ("sources", "requirements"):
            payload = self.payload()
            payload["cases"][0][key].append(copy.deepcopy(payload["cases"][0][key][0]))
            self.assert_invalid(payload)
        payload = self.payload()
        payload["cases"][0]["cv_assessed"] = 1
        self.assert_invalid(payload)

    def test_container_values_for_scalar_fields_return_errors_not_exceptions(self):
        for field in ("support", "cv_visibility"):
            for value in ([], {}, 1, None):
                payload = self.payload()
                self.row(payload)[field] = value
                with self.subTest(worker_field=field, value=value):
                    self.assert_invalid(payload)
        for field in ("origin", "kind", "location", "text"):
            payload = self.payload(support="listed_only", kind="skill")
            self.row(payload)["question"] = "Which example supports this?"
            payload["cases"][0]["sources"][0][field] = []
            with self.subTest(source_field=field):
                self.assert_invalid(payload)

    def test_empty_requirements_and_citations_are_not_evidence(self):
        for field in ("text", "location"):
            payload = self.payload()
            payload["cases"][0]["sources"][0][field] = " "
            with self.subTest(source_field=field):
                self.assert_invalid(payload)
        payload = self.payload()
        payload["cases"][0]["requirements"][0]["text"] = ""
        self.assert_invalid(payload)

    def test_cli_from_another_directory_and_malformed_json(self):
        script = Path(__file__).with_name("resume_evidence.py")
        proc = subprocess.run([sys.executable, str(script)], input=json.dumps(self.payload()), text=True,
                              cwd=tempfile.gettempdir(), capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["invalid"], [])
        bad = subprocess.run([sys.executable, str(script)], input="{", text=True,
                             cwd=tempfile.gettempdir(), capture_output=True)
        self.assertEqual(bad.returncode, 1)
        self.assertTrue(json.loads(bad.stdout)["invalid"])

    def test_cli_utf8_is_independent_of_console_encoding(self):
        payload = self.payload()
        text = "Criei serviços em São Paulo. 日本語"
        payload["cases"][0]["sources"][0]["text"] = text
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("resume_evidence.py"))],
                                input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                capture_output=True, env={**os.environ, "PYTHONIOENCODING": "ascii"})
        self.assertEqual(result.returncode, 0, result.stderr.decode("ascii", "replace"))
        value = json.loads(result.stdout.decode("utf-8"))
        self.assertEqual(value["valid"][0]["requirements"][0]["sources"][0]["text"], text)

    def test_cli_preserves_batch_with_unpaired_surrogate(self):
        payload = self.payload()
        source_text = "Serviços em São Paulo \ud83d"
        payload["cases"][0]["sources"][0]["text"] = source_text
        peer = self.payload()
        peer["cases"][0]["target"] = peer["assessments"][0]["target"] = "job:2"
        peer["cases"][0]["sources"][0]["text"] = "日本語 😀"
        payload["cases"].extend(peer["cases"])
        payload["assessments"].extend(peer["assessments"])

        proc = subprocess.run([sys.executable, str(Path(__file__).with_name("resume_evidence.py"))],
                              input=json.dumps(payload).encode("utf-8"), capture_output=True)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace"))
        value = json.loads(proc.stdout.decode("utf-8"))
        self.assertEqual(value["invalid"], [])
        self.assertEqual([row["target"] for row in value["valid"]], ["job:1", "job:2"])
        self.assertEqual(value["valid"][0]["requirements"][0]["sources"][0]["text"], source_text)
        self.assertEqual(value["valid"][1]["requirements"][0]["sources"][0]["text"], "日本語 😀")


if __name__ == "__main__":
    unittest.main()

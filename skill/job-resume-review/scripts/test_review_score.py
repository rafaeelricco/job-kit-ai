"""Tests for review_score.py: rubric v2 arithmetic and its drift against rubric.md."""
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

from review_score import CAP, RATED, WEIGHTS, InputError, score

HERE = Path(__file__).resolve().parent
RUBRIC = HERE.parent / "references" / "rubric.md"
NAMES = {"Positioning": "positioning", "Achievement bullets": "bullets", "Skills and relevance": "skills",
         "Logical organization": "organization", "Visual presentation": "visual", "Writing": "writing",
         "Parsing readiness": "parsing"}
ALL = {name: 3 for name in RATED}


def bullets(*ratings, recent=False):
    return [{"id": f"E1.B{i + 1}", "rating": r, "recent": recent} for i, r in enumerate(ratings)]


class RubricDriftTests(unittest.TestCase):
    def test_weights_match_rubric_table(self):
        rows = re.findall(r"^\| ([A-Z][a-z ]+?) +\| +(\d+) \|", RUBRIC.read_text(encoding="utf-8"), re.M)
        self.assertEqual({NAMES[name]: int(weight) for name, weight in rows}, WEIGHTS)

    def test_cap_matches_rubric(self):
        self.assertIn(f"capped at {CAP}", RUBRIC.read_text(encoding="utf-8"))


class ScoreTests(unittest.TestCase):
    def test_full_coverage_all_threes_scores_75(self):
        result = score({"criteria": ALL, "bullets": bullets(3, 3)})
        self.assertEqual((result["score"], result["coverage"], result["provisional"]), (75, 100, False))

    def test_recent_bullets_weigh_double(self):
        result = score({"bullets": bullets(4, recent=True) + bullets(1)})
        self.assertEqual(result["criteria"][1]["rating"], 3.0)  # (2*4 + 1) / 3

    def test_unassessed_criterion_lowers_coverage_and_marks_provisional(self):
        result = score({"criteria": {**ALL, "parsing": None}, "bullets": bullets(3)})
        self.assertEqual((result["coverage"], result["provisional"], result["score"]), (85, True, 75))

    def test_rounds_half_up(self):
        result = score({"criteria": {"positioning": 4, "visual": 2}})  # 17.5 / 20 = 87.5
        self.assertEqual(result["score"], 88)

    def test_blocking_caps_a_high_score(self):
        result = score({"criteria": {n: 4 for n in RATED}, "bullets": bullets(4), "blocking": ["hidden text"]})
        self.assertEqual((result["weighted_score"], result["score"], result["capped"]), (100, CAP, True))

    def test_blocking_below_cap_is_not_capped(self):
        result = score({"criteria": {n: 1 for n in RATED}, "bullets": bullets(1), "blocking": ["no text layer"]})
        self.assertEqual((result["score"], result["capped"]), (25, False))

    def test_no_bullets_rates_zero(self):
        result = score({"criteria": ALL, "bullets": []})  # 70 weight at 3/4 = 52.5 of 100
        self.assertEqual((result["criteria"][1]["rating"], result["coverage"], result["score"]), (0.0, 100, 53))

    def test_nothing_assessed(self):
        result = score({})
        self.assertEqual((result["score"], result["coverage"], result["alignment"]), (None, 0, None))

    def test_alignment_weights_musts_double(self):
        reqs = [{"id": "R1", "kind": "must", "credit": 0.5}, {"id": "R2", "kind": "preference", "credit": 1}]
        self.assertEqual(score({"requirements": reqs})["alignment"], 67)  # (2*0.5 + 1) / 3


class InvalidInputTests(unittest.TestCase):
    def test_rejects(self):
        for payload in ({"criteria": {"positioning": 5}}, {"criteria": {"positioning": 2.5}},
                        {"criteria": {"positioning": True}}, {"criteria": {"bullets": 3}}, {"criteria": {"tone": 3}},
                        {"bullets": [{"rating": 3}]}, {"requirements": [{"kind": "must", "credit": 0.7}]},
                        {"requirements": [{"kind": "nice", "credit": 1}]}, {"blocking": [""]}, []):
            with self.subTest(payload=payload), self.assertRaises(InputError):
                score(payload)

    def test_cli_reports_errors_as_json_and_exits_1(self):
        proc = subprocess.run([sys.executable, str(HERE / "review_score.py")], input="{not json",
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("review_score_error", json.loads(proc.stdout))

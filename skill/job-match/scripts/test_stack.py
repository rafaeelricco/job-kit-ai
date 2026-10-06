import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from stack import rank_all

SCRIPT = Path(__file__).resolve().parent / "stack.py"


def ranked(skills, required):
    return rank_all({"skills": skills, "jobs": [{"url": "u", "required_skills": required}]})[0]


class RankTests(unittest.TestCase):
    def test_share_rounds_half_up(self):
        row = ranked(["React", "Go", "SQL"], ["react", "go", "sql", "rust"])
        self.assertEqual((row["score"], row["covered"], row["required"]), (8, 3, 4))

    def test_direct_hold_only(self):
        self.assertEqual(ranked(["React.js"], ["React"])["score"], 10)
        self.assertEqual(ranked(["Vue"], ["React"])["score"], 0)

    def test_stored_comma_list(self):
        self.assertEqual(ranked(["TypeScript"], "TypeScript, Python")["score"], 5)
        self.assertIsNone(ranked(["TypeScript"], "—")["score"])

    def test_empty_list_is_unscored(self):
        self.assertIsNone(ranked([], ["React"])["score"])
        self.assertIsNone(ranked(["React"], [])["score"])

    def test_order_and_malformed_input(self):
        rows = rank_all({"skills": ["Go"], "jobs": [
            {"url": "a", "required_skills": ["Go"]},
            {"url": "b", "required_skills": ["Rust"]},
        ]})
        self.assertEqual([(row["url"], row["score"]) for row in rows], [("a", 10), ("b", 0)])
        for payload in ([], {"skills": "Go", "jobs": []}, {"skills": [], "jobs": [{"url": 1}]}):
            with self.assertRaises(ValueError):
                rank_all(payload)


class CliTests(unittest.TestCase):
    def run_cli(self, data):
        env = dict(os.environ, PYTHONIOENCODING="cp1252")
        with tempfile.TemporaryDirectory() as cwd:
            return subprocess.run([sys.executable, str(SCRIPT)], input=data, capture_output=True, cwd=cwd, env=env)

    def test_utf8_bom_and_dash_on_any_locale(self):
        payload = {"skills": ["Go"], "jobs": [{"url": "u", "required_skills": "—"}]}
        result = self.run_cli(b"\xef\xbb\xbf" + json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIsNone(json.loads(result.stdout)[0]["score"])

    def test_malformed_input_exits_1(self):
        result = self.run_cli(b'{"skills": "Go", "jobs": []}')
        self.assertEqual(result.returncode, 1)
        self.assertIn("stack_error", json.loads(result.stdout))


if __name__ == "__main__":
    unittest.main()

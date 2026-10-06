"""Characterize the standalone JSON interfaces from outside the repository."""

import json
import subprocess
import sys
import unittest
from pathlib import Path


SCRIPTS = Path(__file__).parent.resolve()
FACTORS = (
    "primary_stack",
    "experience",
    "seniority",
    "role_type",
    "location",
    "domain",
    "language",
    "preferences",
)


def breakdown(**cells):
    value = {name: None for name in FACTORS}
    value.update(cells)
    return value


def run_script(name, payload):
    return subprocess.run(
        [sys.executable, str(SCRIPTS / name)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        check=False,
        cwd="/tmp",
    )


class CliContractTests(unittest.TestCase):
    def test_score_object_and_legacy_array_inputs(self):
        object_result = run_script(
            "score.py",
            {
                "candidate": {
                    "roles": ["Engineer"],
                    "skills": ["TypeScript"],
                    "years_experience": 6,
                },
                "jobs": [
                    {
                        "url": "u",
                        "title": "Engineer",
                        "years_experience": "8+ years",
                    }
                ],
                "matches": [
                    {
                        "url": "u",
                        "score_breakdown": breakdown(
                            experience=99, role_type="ignored", seniority=15
                        ),
                    }
                ],
            },
        )
        legacy_result = run_script(
            "score.py",
            [
                {
                    "url": "u",
                    "score_breakdown": breakdown(experience=20),
                }
            ],
        )

        self.assertEqual(object_result.returncode, 0)
        self.assertTrue(object_result.stdout.endswith("\n"))
        object_row = json.loads(object_result.stdout)[0]
        self.assertEqual(object_row["score_breakdown"]["experience"], 10)
        self.assertEqual(object_row["score_breakdown"]["role_type"], 15)
        self.assertEqual(legacy_result.returncode, 0)
        self.assertEqual(json.loads(legacy_result.stdout)[0]["match_score"], 100)

    def test_scaffold_preserves_order_duplicates_spelling_and_warnings(self):
        result = run_script(
            "scaffold_guidance.py",
            {
                "candidate": {"skills": ["TypeScript", "React.js"]},
                "jobs": [
                    {
                        "url": "u",
                        "required_skills": ["typescript", "typescript"],
                        "preferred_skills": ["Go"],
                    },
                    {"url": "empty", "required_skills": []},
                    {"url": "react", "required_skills": ["React"]},
                ],
            },
        )
        warnings_result = run_script(
            "scaffold_guidance.py",
            {
                "candidate": {"skills": []},
                "jobs": [{"url": "empty", "required_skills": []}],
            },
        )

        self.assertEqual(result.returncode, 0)
        self.assertTrue(result.stdout.endswith("\n"))
        output = json.loads(result.stdout)
        self.assertEqual(
            [(item["kind"], item["job_term"]) for item in output[0]["requirements"]],
            [
                ("required", "typescript"),
                ("required", "typescript"),
                ("preferred", "Go"),
            ],
        )
        self.assertEqual(output[0]["requirements"][0]["profile_term"], "TypeScript")
        self.assertEqual(output[1]["warnings"], ["no_required_skills", "no_relevant_role"])
        self.assertEqual(output[2]["requirements"][0]["status"], "held")
        self.assertEqual(output[2]["requirements"][0]["profile_term"], "React.js")
        self.assertEqual(
            json.loads(warnings_result.stdout)[0]["warnings"],
            ["candidate_skills_empty", "no_required_skills", "no_relevant_role"],
        )

    def test_scaffold_fills_priority_roles(self):
        result = run_script(
            "scaffold_guidance.py",
            {
                "candidate": {
                    "skills": ["React"],
                    "experience": [
                        {"company": "Acme", "position": "Senior Frontend Engineer"},
                        {"company": "Acme", "position": "Senior Frontend Engineer"},
                        {"company": "Beta", "position": "Sales Manager"},
                        {"company": "Gamma", "position": "Staff Engineer"},
                    ],
                },
                "jobs": [
                    {
                        "url": "u",
                        "title": "Senior Frontend Engineer",
                        "seniority": "senior",
                        "required_skills": ["React"],
                    }
                ],
            },
        )
        row = json.loads(result.stdout)[0]
        self.assertEqual(
            row["priority_roles"],
            [
                {
                    "company": "Acme",
                    "position": "Senior Frontend Engineer",
                    "matched_on": ["role_type", "seniority"],
                },
                {
                    "company": "Gamma",
                    "position": "Staff Engineer",
                    "matched_on": ["seniority"],
                },
            ],
        )
        self.assertNotIn("no_relevant_role", row["warnings"])

    def test_scaffold_matches_seniority_one_step_either_way(self):
        experience = [
            {"company": "Z", "position": position}
            for position in ("Intern Analyst", "Junior Analyst", "Staff Analyst")
        ]
        result = run_script(
            "scaffold_guidance.py",
            {
                "candidate": {"skills": ["SQL"], "experience": experience},
                "jobs": [
                    {"url": level, "title": "Designer", "seniority": level}
                    for level in ("junior", "mid", "principal")
                ],
            },
        )
        self.assertTrue(result.stdout.startswith('[\n  {\n    "schema_version"'))
        positions = {
            row["url"]: [role["position"] for role in row["priority_roles"]]
            for row in json.loads(result.stdout)
        }
        self.assertEqual(
            positions,
            {
                "junior": ["Intern Analyst", "Junior Analyst"],
                "mid": ["Junior Analyst"],
                "principal": ["Staff Analyst"],
            },
        )

    def test_validator_preserves_valid_rows_and_exit_codes(self):
        job = {
            "url": "u",
            "required_skills": ["TypeScript"],
            "preferred_skills": [],
        }
        guidance = {
            "schema_version": 1,
            "url": "u",
            "requirements": [
                {
                    "kind": "required",
                    "job_term": "TypeScript",
                    "status": "held",
                    "profile_term": "TypeScript",
                }
            ],
            "priority_roles": [],
            "warnings": ["no_relevant_role"],
        }
        result = run_script(
            "validate_guidance.py",
            {
                "candidate": {"skills": ["TypeScript"], "experience": []},
                "jobs": [job],
                "guidance": [guidance],
            },
        )
        invalid_json = subprocess.run(
            [sys.executable, str(SCRIPTS / "validate_guidance.py")],
            input="{",
            capture_output=True,
            text=True,
            check=False,
            cwd="/tmp",
        )

        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {"valid": [guidance], "invalid": []})
        self.assertEqual(invalid_json.returncode, 1)
        self.assertTrue(json.loads(invalid_json.stdout)["invalid"])


if __name__ == "__main__":
    unittest.main()

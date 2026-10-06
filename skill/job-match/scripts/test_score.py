import copy
import unittest

from models import CandidateProfile, JobProfile, MatchResult
from score import (
    _contains_token,
    experience_points,
    keep_quoted,
    role_type_points,
    score_all,
)


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


class ExperienceTests(unittest.TestCase):
    def test_points(self):
        cases = (
            (6, "6+ years", 20),
            (6, "1099 contract, 5+ years", 20),
            (9, "8-10 years", 20),
            (5, "8-10 years", 10),
            (5, "senior", None),
            (None, "6+", None),
            (5, None, None),
        )
        for candidate, required, expected in cases:
            with self.subTest(candidate=candidate, required=required):
                self.assertEqual(
                    experience_points(candidate, required), expected
                )


class RoleTypeTests(unittest.TestCase):
    def test_points(self):
        cases = (
            ("Senior Full-Stack Engineer (Remote)", ["full stack engineer"], 15),
            ("Engineering Lead", ["Engineer"], 0),
            ("Engineer", [], None),
        )
        for title, roles, expected in cases:
            with self.subTest(title=title, roles=roles):
                self.assertEqual(role_type_points(title, roles), expected)


class KeepQuotedTests(unittest.TestCase):
    def test_returns_filtered_copy_without_mutating_input(self):
        source = {
            "score_breakdown": breakdown(),
            "strengths": ["Holds TypeScript", "Great culture fit"],
            "gaps": [],
            "blockers": [],
        }
        original = copy.deepcopy(source)

        result = keep_quoted(
            MatchResult.from_json(source),
            CandidateProfile.from_json({"skills": ["TypeScript"]}),
            JobProfile.from_json({"url": "u"}),
        ).to_json()

        self.assertEqual(source, original)
        self.assertEqual(result["strengths"], ["Holds TypeScript"])
        self.assertEqual(
            result["evidence_dropped"],
            [{"list": "strengths", "item": "Great culture fit"}],
        )

    def test_recursive_source_tokens_and_no_empty_marker(self):
        source = {
            "score_breakdown": breakdown(),
            "strengths": ["Worked at Example Co"],
            "gaps": [],
            "blockers": [],
        }
        result = keep_quoted(
            MatchResult.from_json(source),
            CandidateProfile.from_json(
                {"experience": [{"company": "Example Co", "position": "Engineer"}]}
            ),
            JobProfile.from_json({"url": "u"}),
        ).to_json()

        self.assertEqual(result["strengths"], ["Worked at Example Co"])
        self.assertNotIn("evidence_dropped", result)


    def test_short_tokens_ground_only_whole_words(self):
        source = {
            "score_breakdown": breakdown(),
            "strengths": [
                "Experience with ongoing migrations",
                "Shipped Go services to production",
                "Built services in C",
            ],
            "gaps": ["Delivered results with a strong customer focus"],
            "blockers": [],
        }
        result = keep_quoted(
            MatchResult.from_json(source),
            CandidateProfile.from_json({"skills": ["C", "Go"]}),
            JobProfile.from_json({"url": "u", "required_skills": ["US"]}),
        ).to_json()

        self.assertEqual(
            result["strengths"],
            ["Shipped Go services to production", "Built services in C"],
        )
        self.assertEqual(result["gaps"], [])
        self.assertEqual(
            result["evidence_dropped"],
            [
                {"list": "strengths", "item": "Experience with ongoing migrations"},
                {"list": "gaps", "item": "Delivered results with a strong customer focus"},
            ],
        )

    def test_punctuated_tokens_still_ground(self):
        source = {
            "score_breakdown": breakdown(),
            "strengths": ["Maintains C++ and Node.js services"],
            "gaps": [],
            "blockers": [],
        }
        result = keep_quoted(
            MatchResult.from_json(source),
            CandidateProfile.from_json({"skills": ["C++", "Node.js"]}),
            JobProfile.from_json({"url": "u"}),
        ).to_json()

        self.assertEqual(result["strengths"], ["Maintains C++ and Node.js services"])
        self.assertNotIn("evidence_dropped", result)


class ContainsTokenTests(unittest.TestCase):
    def test_boundaries_ignore_punctuation_but_not_letters(self):
        cases = (
            ("reactñ stack", "react", False),
            ("maintains c# services", "c#", True),
            ("ships .net internals", ".net", True),
            ("node.js services in production", "node.js", True),
            ("built c++ tooling", "c++", True),
        )
        for text, token, expected in cases:
            with self.subTest(text=text, token=token):
                self.assertEqual(_contains_token(text, token), expected)


class ScoreAllTests(unittest.TestCase):
    def test_object_payload_derives_then_scores(self):
        payload = {
            "candidate": {
                "roles": ["Senior Software Engineer"],
                "skills": ["TypeScript"],
                "years_experience": 6,
            },
            "jobs": [
                {
                    "url": "u1",
                    "title": "Senior Software Engineer (Remote)",
                    "years_experience": "8+ years",
                    "required_skills": ["TypeScript", "Go"],
                }
            ],
            "matches": [
                {
                    "url": "u1",
                    "strengths": ["Holds TypeScript"],
                    "gaps": [],
                    "blockers": [],
                    "score_breakdown": breakdown(
                        primary_stack={"held": 1, "required": 2},
                        experience=99,
                        role_type="worker value is ignored",
                        seniority=15,
                    ),
                },
                {
                    "url": "missing",
                    "strengths": [],
                    "gaps": [],
                    "blockers": [],
                    "score_breakdown": breakdown(),
                },
            ],
        }

        output = score_all(payload)

        self.assertEqual(output[0]["score_breakdown"]["experience"], 10)
        self.assertEqual(output[0]["score_breakdown"]["role_type"], 15)
        self.assertEqual(output[0]["match_score"], 71)
        self.assertEqual(output[0]["decision"], "possible_match")
        self.assertEqual(
            output[1]["score_error"], "no JobProfile for this url"
        )

    def test_primary_stack_is_derived_from_profiles(self):
        for sent in ("3/5", {"held": 2, "required": 2}):
            with self.subTest(sent=sent):
                payload = {
                    "candidate": {"skills": ["TypeScript"]},
                    "jobs": [
                        {"url": "u1", "required_skills": ["TypeScript", "Go"]}
                    ],
                    "matches": [
                        {
                            "url": "u1",
                            "strengths": [],
                            "gaps": [],
                            "blockers": [],
                            "score_breakdown": breakdown(primary_stack=sent),
                        }
                    ],
                }

                output = score_all(payload)

                self.assertNotIn("score_error", output[0])
                self.assertEqual(
                    output[0]["score_breakdown"]["primary_stack"],
                    {"held": 1, "required": 2},
                )

    def test_legacy_array_scores_cells_as_given(self):
        output = score_all(
            [
                {
                    "url": "x",
                    "score_breakdown": breakdown(
                        primary_stack={"held": 2, "required": 2},
                        experience=20,
                        role_type=15,
                    ),
                }
            ]
        )

        self.assertEqual(output[0]["match_score"], 100)
        self.assertEqual(output[0]["confidence"], 0.6)

    def test_duplicate_job_url_is_a_row_error(self):
        payload = {
            "candidate": {"roles": ["Engineer"], "skills": []},
            "jobs": [
                {"url": "u", "title": "Manager"},
                {"url": "u", "title": "Engineer"},
                {"url": "unique", "title": "Engineer"},
            ],
            "matches": [
                {"url": "u", "score_breakdown": breakdown(seniority=15)},
                {"url": "u", "score_breakdown": breakdown(seniority=8)},
                {"url": "unique", "score_breakdown": breakdown(seniority=15)},
            ],
        }

        output = score_all(payload)

        cases = (
            (0, "duplicate JobProfile url"),
            (1, "duplicate JobProfile url"),
        )
        for index, expected in cases:
            with self.subTest(index=index):
                self.assertEqual(output[index]["score_error"], expected)
                self.assertNotIn("match_score", output[index])

        self.assertNotIn("score_error", output[2])
        self.assertEqual(output[2]["score_breakdown"]["role_type"], 15)
        self.assertEqual(output[2]["match_score"], 100)

    def test_score_all_does_not_mutate_payload(self):
        payload = [
            {
                "url": "x",
                "score_breakdown": breakdown(experience=20),
            }
        ]
        original = copy.deepcopy(payload)

        score_all(payload)

        self.assertEqual(payload, original)


if __name__ == "__main__":
    unittest.main()

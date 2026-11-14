"""Pin the TypeSafe match adapter without touching the network."""

import json
import os
import re
import socket
import subprocess
import sys
import threading
import unittest
from pathlib import Path
from typing import Dict, cast, get_args
from unittest import mock

import typesafe_match
from score import score_all
from typesafe_match import (
    DOMAIN,
    FLOOR,
    QUESTIONS,
    SENIORITY,
    Answer,
    Cell,
    Choices,
    Failure,
    Option,
    Payload,
    Question,
    Reply,
    http_post,
    match_all,
)


SCRIPTS = Path(__file__).parent.resolve()
CANDIDATE = {
    "roles": ["Backend Engineer"],
    "skills": ["Python", "React.js"],
    "years_experience": 6,
    "experience": [
        {"company": "Acme", "position": "Senior Backend Engineer", "date": "2019 - 2025"}
    ],
}
JOB = {
    "url": "u",
    "title": "Senior Backend Engineer",
    "seniority": "Senior",
    "years_experience": "5+ years",
    "required_skills": ["Python", "React", "Go"],
}
ANSWERS = {
    "seniority": {"type": "choice", "choice": "same", "confidence": 0.97},
    "location": {"type": "choice", "choice": "work_model_only", "confidence": 0.91},
    "domain": {"type": "choice", "choice": "no_cue", "confidence": 0.88},
    "language": {"type": "choice", "choice": "none", "confidence": 0.99},
    "preferences": {"type": "choice", "choice": "conflict", "confidence": 0.84},
}


def replying(answers):
    sent = []

    def post(body):
        sent.append(body)
        return Reply({"model": "jev-1.13.0", "answers": answers})

    return sent, post


def run(jobs, post):
    return match_all(Payload.from_json({"candidate": CANDIDATE, "jobs": jobs}), post)


class CatalogTests(unittest.TestCase):
    def test_covers_each_cell_once(self):
        self.assertEqual(
            sorted(question.cell for question in QUESTIONS), sorted(get_args(Cell))
        )

    def test_rejects_points_outside_the_weight(self):
        with self.assertRaises(ValueError):
            Question("domain", "x", (Option("a", "a", 6), Option("b", "b", None)))

    def test_rejects_duplicate_options(self):
        with self.assertRaises(ValueError):
            Question("domain", "x", (Option("a", "a", 5), Option("a", "b", 0)))

    def test_choices_reject_an_option_from_another_question(self):
        same = SENIORITY.options[0]
        with self.assertRaises(ValueError):
            Choices(*(Answer(same, 0.9),) * 5)
        own = tuple(Answer(question.options[0], 0.9) for question in QUESTIONS)
        self.assertEqual(Choices(*own).domain.option, DOMAIN.options[0])

    def test_answer_rejects_confidence_outside_the_unit_interval(self):
        for bad in (-0.01, 1.01):
            with self.subTest(confidence=bad), self.assertRaises(ValueError):
                Answer(SENIORITY.options[0], bad)

    def test_the_floor_is_inclusive(self):
        """At the floor Jev is believed; one step below it, the cell is `—`."""
        scoring = SENIORITY.options[0]
        self.assertEqual(Answer(scoring, FLOOR).points, scoring.points)
        self.assertIsNone(Answer(scoring, FLOOR - 0.01).points)


class MatchTests(unittest.TestCase):
    def test_request_asks_one_choice_per_worker_cell(self):
        sent, post = replying(ANSWERS)
        run([JOB], post)
        body = sent[0]
        self.assertEqual(body["model"], "jev-latest")
        self.assertEqual(body["state"], {"candidate": CANDIDATE, "job": JOB})
        self.assertEqual(set(body["questions"]), set(get_args(Cell)))
        for question in QUESTIONS:
            sent_question = body["questions"][question.cell]
            self.assertEqual(sent_question["type"], "choice")
            self.assertEqual(
                list(sent_question["criteria"]),
                [option.name for option in question.options],
            )

    def test_request_projects_profile_schema_and_drops_legacy_pay_and_extras(self):
        candidate = {
            "roles": ["Backend Engineer"],
            "skills": ["Python"],
            "domains": ["fintech", {"legacy": "candidate-secret-domain"}],
            "languages": {
                "English": "fluent",
                "Mandarin": "native",
                "Legacy": {"salary": "candidate-secret-language"},
            },
            "experience": [
                {
                    "company": "Acme",
                    "position": "Senior Backend Engineer",
                    "date": "2019 - 2025",
                    "summary": "candidate-secret-compensation",
                }
            ],
            "years_experience": 6,
            "preferences": {
                "remote": "Yes",
                "in_person": "No",
                "relocation": "No",
                "legacy": "candidate-secret-preference",
            },
            "constraints": {
                "work_model": {
                    "remote": True,
                    "hybrid": False,
                    "onsite": False,
                    "future_model": True,
                },
                "location": {
                    "search_in": [
                        "United States",
                        {"legacy": "candidate-secret-search-scope"},
                    ],
                    "exclude_hire_from": ["Canada"],
                    "legacy": "candidate-secret-location",
                },
                "residence": {
                    "country": "United States",
                    "regions": ["New York"],
                    "legacy": "candidate-secret-residence",
                },
                "exclude_companies": ["Bad Corp", {"legacy": "secret"}],
                "pay_min_usd_year": 250000,
                "work_authorization": {
                    "citizenships": ["United States"],
                    "permits": ["H-1B"],
                    "legacy": "candidate-secret-authorization",
                },
                "legacy": "candidate-secret-constraint",
            },
            "salary": "candidate-secret-top-level-pay",
            "legacy": "candidate-secret-top-level-extra",
        }
        job = {
            "url": "u",
            "company": "Example",
            "title": "Senior Backend Engineer",
            "scout_score": 4,
            "seniority": "Senior",
            "work_model": "Remote",
            "location": "New York",
            "salary": "job-secret-compensation",
            "years_experience": "5+ years",
            "work_auth": "US work authorization",
            "hiring_route": "Direct",
            "eligibility": "Compatible",
            "eligibility_evidence": "US only",
            "required_skills": ["Python"],
            "preferred_skills": ["Go"],
            "languages_required": [
                {"name": "English", "level": "C1", "legacy": "job-secret-language"}
            ],
            "languages_preferred": [
                {"name": "German", "level": None},
                {"name": "French", "level": {"salary": "job-secret-language"}},
            ],
            "domain": "fintech",
            "legacy": "job-secret-top-level-extra",
        }
        payload = Payload.from_json({"candidate": candidate, "jobs": [job]})
        sent, post = replying(ANSWERS)
        match_all(payload, post)

        self.assertEqual(
            sent[0]["state"],
            {
                "candidate": {
                    "roles": ["Backend Engineer"],
                    "skills": ["Python"],
                    "domains": ["fintech"],
                        "languages": {"English": "fluent", "Mandarin": "native"},
                    "experience": [
                        {
                            "company": "Acme",
                            "position": "Senior Backend Engineer",
                            "date": "2019 - 2025",
                        }
                    ],
                    "years_experience": 6,
                    "preferences": {
                        "remote": "Yes",
                        "in_person": "No",
                        "relocation": "No",
                    },
                    "constraints": {
                        "work_model": {
                            "remote": True,
                            "hybrid": False,
                            "onsite": False,
                        },
                        "location": {
                            "search_in": ["United States"],
                            "exclude_hire_from": ["Canada"],
                        },
                        "residence": {
                            "country": "United States",
                            "regions": ["New York"],
                        },
                        "exclude_companies": ["Bad Corp"],
                        "work_authorization": {
                            "citizenships": ["United States"],
                            "permits": ["H-1B"],
                        },
                    },
                },
                "job": {
                    "url": "u",
                    "company": "Example",
                    "title": "Senior Backend Engineer",
                    "scout_score": 4,
                    "seniority": "Senior",
                    "work_model": "Remote",
                    "location": "New York",
                    "years_experience": "5+ years",
                    "work_auth": "US work authorization",
                    "hiring_route": "Direct",
                    "eligibility": "Compatible",
                    "eligibility_evidence": "US only",
                    "required_skills": ["Python"],
                    "preferred_skills": ["Go"],
                    "languages_required": [{"name": "English", "level": "C1"}],
                    "languages_preferred": [
                        {"name": "German", "level": None},
                        {"name": "French"},
                    ],
                    "domain": "fintech",
                },
            },
        )
    def test_request_keeps_worldwide_scope_and_drops_nested_scalar_values(self):
        candidate = dict(
            CANDIDATE,
            languages={"English": {"pay": "secret"}},
            constraints={"location": {"search_in": "worldwide"}},
        )
        job = dict(
            JOB,
            work_auth={"pay": "secret"},
            languages_required=[
                {"name": "English", "level": {"pay": "secret"}}
            ],
        )
        body = typesafe_match.request(candidate, job)
        state = body["state"]
        projected_candidate = cast(Dict[str, object], state["candidate"])
        projected_constraints = cast(
            Dict[str, object], projected_candidate["constraints"]
        )
        projected_location = cast(
            Dict[str, object], projected_constraints["location"]
        )
        projected_job = cast(Dict[str, object], state["job"])
        self.assertEqual(
            projected_location["search_in"], "worldwide"
        )
        self.assertEqual(projected_candidate["languages"], {})
        self.assertNotIn("work_auth", projected_job)
        self.assertEqual(
            projected_job["languages_required"], [{"name": "English"}]
        )

    def test_request_keeps_candidate_languages_with_null_level(self):
        candidate = dict(
            CANDIDATE,
            languages={"English": None, "Spanish": "", "Portuguese": "native"},
        )
        body = typesafe_match.request(candidate, JOB)
        projected_candidate = cast(Dict[str, object], body["state"]["candidate"])
        self.assertEqual(
            projected_candidate["languages"],
            {"English": None, "Spanish": "", "Portuguese": "native"},
        )

    def test_choices_map_to_contract_points(self):
        _, post = replying(ANSWERS)
        [row] = run([JOB], post)
        self.assertEqual(
            row,
            {
                "url": "u",
                "score_breakdown": {
                    "primary_stack": {"held": 2, "required": 3},
                    "experience": None,
                    "seniority": 15,
                    "role_type": None,
                    "location": 5,
                    "domain": None,
                    "language": None,
                    "preferences": 0,
                },
                "strengths": ["Python", "React"],
                "gaps": ["Go"],
                "blockers": [],
            },
        )

    def test_rows_score_cleanly(self):
        _, post = replying(ANSWERS)
        rows = run([JOB], post)
        [scored] = score_all({"candidate": CANDIDATE, "jobs": [JOB], "matches": rows})
        self.assertNotIn("score_error", scored)
        self.assertNotIn("evidence_dropped", scored)
        # 17 + 20 + 15 + 15 + 5 + 0 = 72 of 90 scored weight → 80.
        self.assertEqual((scored["match_score"], scored["decision"]), (80, "strong_match"))

    def test_no_required_skills_leaves_stack_unscored(self):
        _, post = replying(ANSWERS)
        [row] = run([dict(JOB, required_skills=[])], post)
        self.assertIsNone(row["score_breakdown"]["primary_stack"])

    def test_an_unsure_cell_scores_as_unknown_not_as_zero(self):
        """The contract's rule: no evidence is `—`, never `0`."""
        unsure = dict(
            ANSWERS,
            preferences={"type": "choice", "choice": "conflict", "confidence": 0.22},
        )
        _, post = replying(unsure)
        [row] = run([JOB], post)
        # `conflict` carries 0 points, so a collapse is only visible as None.
        self.assertIsNone(row["score_breakdown"]["preferences"])
        _, confident = replying(ANSWERS)
        [scored] = run([JOB], confident)
        self.assertEqual(scored["score_breakdown"]["preferences"], 0)

    def test_collapsed_cells_lower_the_rows_scored_confidence(self):
        """What makes `flow-match.md`'s `confidence < 0.7` re-check fire."""
        unsure = dict(
            ANSWERS,
            seniority={"type": "choice", "choice": "same", "confidence": 0.31},
            location={
                "type": "choice",
                "choice": "work_model_only",
                "confidence": 0.29,
            },
        )
        rows = {}
        for name, answers in (("sure", ANSWERS), ("unsure", unsure)):
            _, post = replying(answers)
            [scored] = score_all(
                {"candidate": CANDIDATE, "jobs": [JOB], "matches": run([JOB], post)}
            )
            rows[name] = scored
        self.assertGreater(rows["sure"]["confidence"], rows["unsure"]["confidence"])
        self.assertGreaterEqual(rows["sure"]["confidence"], 0.7)
        self.assertLess(rows["unsure"]["confidence"], 0.7)

    def test_a_collapsed_cell_is_named_on_the_row(self):
        """What makes `flow-match-gate.md`'s re-review fire when `0.9` cannot."""
        unsure = dict(
            ANSWERS,
            domain={"type": "choice", "choice": "held", "confidence": 0.59},
        )
        _, post = replying(unsure)
        [row] = run([JOB], post)
        self.assertEqual(row["match_uncertain"], ["domain"])
        [scored] = score_all(
            {"candidate": CANDIDATE, "jobs": [JOB], "matches": [row]}
        )
        # A lone 5-point collapse leaves `confidence` at or above 0.9, so the
        # list is the only signal the gate has.
        self.assertEqual(scored["match_uncertain"], ["domain"])
        self.assertGreaterEqual(scored["confidence"], 0.9)
        _, confident = replying(ANSWERS)
        [sure] = run([JOB], confident)
        self.assertNotIn("match_uncertain", sure)

    def test_an_off_ladder_seniority_can_be_unknown(self):
        """The contract makes a posting token off the ladder `—`, whatever the
        candidate prints, so no scoring option may be true for one."""
        scoring = [
            option for option in SENIORITY.options if option.points is not None
        ]
        self.assertEqual(len(scoring), 3)
        for option in scoring:
            self.assertIn("on the ladder", option.criterion)
        unknown = next(
            option for option in SENIORITY.options if option.points is None
        )
        self.assertNotIn("candidate", unknown.criterion)
        answers = dict(
            ANSWERS,
            seniority={"type": "choice", "choice": "unknown", "confidence": 0.93},
        )
        _, post = replying(answers)
        [row] = run([dict(JOB, seniority="Lead")], post)
        self.assertIsNone(row["score_breakdown"]["seniority"])

    def test_preferences_are_unknown_when_the_job_prints_neither_field(self):
        """No evidence is `—`: `blank` covers only the candidate's own side."""
        answers = dict(
            ANSWERS,
            preferences={"type": "choice", "choice": "unknown", "confidence": 0.9},
        )
        _, post = replying(answers)
        [row] = run([dict(JOB, work_model=None, location=None)], post)
        self.assertIsNone(row["score_breakdown"]["preferences"])


class FailureTests(unittest.TestCase):
    def test_unexpected_choice(self):
        _, post = replying(dict(ANSWERS, seniority={"choice": "maybe"}))
        self.assertEqual(
            run([JOB], post),
            [{"url": "u", "match_error": "seniority: unexpected choice 'maybe'"}],
        )

    def test_reply_without_answers(self):
        self.assertEqual(
            run([JOB], lambda body: Reply({"error": "x"})),
            [{"url": "u", "match_error": "response has no answers object"}],
        )

    def test_transport_failure_stays_per_row(self):
        self.assertEqual(
            run([JOB, dict(JOB, url="v")], lambda body: Failure("timed out")),
            [
                {"url": "u", "match_error": "timed out"},
                {"url": "v", "match_error": "timed out"},
            ],
        )

    def test_malformed_payload_is_rejected(self):
        with self.assertRaises(ValueError):
            Payload.from_json({"candidate": CANDIDATE, "jobs": ["x"]})

    def test_http_reply_and_truncated_reply(self):
        reply = json.dumps({"answers": ANSWERS}).encode()
        responses = [
            b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s" % (len(reply), reply),
            b"HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n{\"answers\":",
        ]
        headers = []
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(2)

        def serve():
            for response in responses:
                connection, _ = server.accept()
                # Drain the whole request first: closing on unread bytes sends a
                # reset, which the client would report instead of the reply.
                data = b""
                while b"\r\n\r\n" not in data:
                    data += connection.recv(65536)
                head, _, body = data.partition(b"\r\n\r\n")
                length = int(re.search(rb"Content-Length: (\d+)", head, re.I).group(1))
                while len(body) < length:
                    body += connection.recv(65536)
                headers.append(head)
                connection.sendall(response)
                connection.close()

        threading.Thread(target=serve, daemon=True).start()
        url = "http://127.0.0.1:%d/v1/systemone" % server.getsockname()[1]
        with mock.patch.object(typesafe_match, "ENDPOINT", url):
            rows = run([JOB, dict(JOB, url="v")], http_post("secret"))
        server.close()
        self.assertIn(b"Authorization: Bearer secret", headers[0])
        self.assertEqual(rows[0]["score_breakdown"]["seniority"], 15)
        self.assertEqual(rows[1]["url"], "v")
        self.assertTrue(rows[1]["match_error"].startswith("IncompleteRead: "))

    def test_cli_without_key_exits_1(self):
        env = {k: v for k, v in os.environ.items() if k != "TYPESAFE_API_KEY"}
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "typesafe_match.py")],
            input=json.dumps({"candidate": CANDIDATE, "jobs": [JOB]}),
            capture_output=True,
            text=True,
            check=False,
            cwd="/tmp",
            env=env,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(
            json.loads(result.stdout), {"match_error": "TYPESAFE_API_KEY is not set"}
        )


if __name__ == "__main__":
    unittest.main()

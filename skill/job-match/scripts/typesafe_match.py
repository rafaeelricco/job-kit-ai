#!/usr/bin/env python3
"""Fill MatchResult rows from TypeSafe Jev choices instead of a worker.

Reads ``{"candidate": CandidateProfile, "jobs": [JobProfile]}`` on stdin and
writes one row per job for ``scripts/score.py``: a MatchResult, or
``{"url", "match_error"}`` when that job's call or answer fails, so one bad
job never aborts the batch. Primary stack is counted in code with the Skill
hold rule. Every other worker cell is one Jev ``choice`` question; each
question and the points its options carry live in ``QUESTIONS``.

A choice Jev is less than ``FLOOR`` sure of scores as the contract's ``—``
rather than as its points: an answer we do not believe is evidence we do not
have. Collapsing the cell lowers the row's ``confidence`` in ``score.py``,
and the cells it collapsed are named on the row's ``match_uncertain``, which
is what tells a caller to re-check the row.
"""

import http.client
import json
import os
import sys
import urllib.request
from dataclasses import dataclass
from typing import (
    Callable,
    Dict,
    List,
    Literal,
    Mapping,
    Optional,
    Tuple,
    TypedDict,
    Union,
    cast,
    get_args,
)

from models import (
    CandidateProfile,
    JobProfile,
    MatchResult,
    ScoreBreakdown,
    held_terms,
    stack_score,
)
from score import WEIGHTS


ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
TIMEOUT = 10.0
# Jev's own certainty in one answer. Below this the cell is the contract's `—`:
# a pick we do not believe is evidence we do not have, and the contract's rule
# is that a factor without evidence is never scored `0`.
FLOOR = 0.60

Cell = Literal["seniority", "location", "domain", "language", "preferences"]


@dataclass(frozen=True)
class Option:
    """One answer Jev may choose; ``points`` None is the contract's ``—``."""

    name: str
    criterion: str
    points: Optional[int]


@dataclass(frozen=True)
class Answer:
    """One Jev choice with the certainty behind it; cannot exist uncalibrated.

    ``option`` stays the catalog's own object so ``Choices`` can keep checking
    membership by equality; the certainty rides beside it rather than on it.
    """

    option: Option
    confidence: float

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence <= 1.0:
            raise ValueError(f"confidence {self.confidence!r} outside 0..1")

    @property
    def points(self) -> Optional[int]:
        """Points, or ``—`` when Jev was not sure enough to be believed."""
        return None if self.confidence < FLOOR else self.option.points


@dataclass(frozen=True)
class Question:
    """One worker cell as a Jev ``choice``; cannot exist with illegal points."""

    cell: Cell
    instructions: str
    options: Tuple[Option, ...]

    def __post_init__(self) -> None:
        names = [option.name for option in self.options]
        if len(names) < 2 or len(set(names)) != len(names):
            raise ValueError(f"{self.cell}: needs two or more distinct options")
        weight = WEIGHTS[self.cell]
        if any(
            option.points is not None and not 0 <= option.points <= weight
            for option in self.options
        ):
            raise ValueError(f"{self.cell}: points must be within 0..{weight}")


def catalog(*questions: Question) -> Tuple[Question, ...]:
    """Accept exactly one question per worker cell."""
    cells = sorted(question.cell for question in questions)
    if cells != sorted(get_args(Cell)):
        raise ValueError(f"questions must cover each cell once, got {cells}")
    return questions


SENIORITY = Question(
    "seniority",
    "Compare job.seniority with the titles in candidate.experience[].position"
    " on the ladder intern, junior, mid, senior, staff, principal.",
    (
        Option(
            "same",
            "job.seniority is on the ladder, and a candidate position prints the"
            " same seniority token.",
            15,
        ),
        Option(
            "one_step",
            "job.seniority is on the ladder, no position prints that token, and the"
            " nearest candidate position is one ladder step from it.",
            8,
        ),
        Option(
            "further",
            "job.seniority is on the ladder, and no candidate position is within one"
            " step of it, including positions that print no ladder token.",
            0,
        ),
        Option(
            "unknown",
            "job.seniority is null, or it is off the ladder.",
            None,
        ),
    ),
)
LOCATION = Question(
    "location",
    "Compare job.work_model and job.location with candidate.constraints"
    " work_model flags and location.search_in.",
    (
        Option(
            "full",
            "They share a work model, and the job is remote or in a named"
            " candidate location.",
            10,
        ),
        Option(
            "work_model_only",
            "They share a work model, but the job is neither remote nor in a named"
            " candidate location.",
            5,
        ),
        Option(
            "none",
            "They share no known work model, and the job's work model or location"
            " is known.",
            0,
        ),
        Option(
            "unknown",
            "Both the job's work model and location are unknown.",
            None,
        ),
    ),
)
DOMAIN = Question(
    "domain",
    "Compare the domain cue printed in job.domain with candidate.domains.",
    (
        Option("held", "The printed domain cue is in candidate.domains.", 5),
        Option(
            "not_held",
            "A domain cue is printed but candidate.domains does not hold it.",
            0,
        ),
        Option("no_cue", "The job prints no domain cue.", None),
    ),
)
LANGUAGE = Question(
    "language",
    "Compare job.languages_preferred with candidate.languages.",
    (
        Option("met", "The candidate meets the printed extra language.", 5),
        Option("unmet", "A printed extra language is not met.", 0),
        Option("none", "The job prints no extra language.", None),
    ),
)
PREFERENCES = Question(
    "preferences",
    "Compare candidate.preferences with job.work_model and job.location.",
    (
        Option(
            "agree",
            "The candidate's preferences agree with the job's work model"
            " and location.",
            5,
        ),
        Option("conflict", "The candidate's preferences conflict with them.", 0),
        Option("blank", "The candidate's preferences are all blank.", None),
        Option(
            "unknown",
            "Both the job's work model and location are unknown.",
            None,
        ),
    ),
)
QUESTIONS: Tuple[Question, ...] = catalog(
    SENIORITY, LOCATION, DOMAIN, LANGUAGE, PREFERENCES
)


@dataclass(frozen=True)
class Choices:
    """Jev's answer for every worker cell, each drawn from that cell's question."""

    seniority: Answer
    location: Answer
    domain: Answer
    language: Answer
    preferences: Answer

    def __post_init__(self) -> None:
        pairs = (
            (SENIORITY, self.seniority),
            (LOCATION, self.location),
            (DOMAIN, self.domain),
            (LANGUAGE, self.language),
            (PREFERENCES, self.preferences),
        )
        stray = next(
            (
                question.cell
                for question, answer in pairs
                if answer.option not in question.options
            ),
            None,
        )
        if stray is not None:
            raise ValueError(f"{stray}: option is not one of its question's options")


class ChoiceQuestion(TypedDict):
    type: Literal["choice"]
    instructions: str
    criteria: Dict[str, str]


class Request(TypedDict):
    model: str
    state: Dict[str, object]
    questions: Dict[str, ChoiceQuestion]


@dataclass(frozen=True)
class Reply:
    """A decoded HTTP body, not yet trusted."""

    body: object


@dataclass(frozen=True)
class Failure:
    reason: str


Post = Callable[[Request], Union[Reply, Failure]]


@dataclass(frozen=True)
class Payload:
    """Stdin, parsed once. Raw sources are what Jev reads as state."""

    candidate_source: Mapping[str, object]
    candidate: CandidateProfile
    jobs: Tuple[Tuple[Mapping[str, object], JobProfile], ...]

    @classmethod
    def from_json(cls, value: object) -> "Payload":
        if not isinstance(value, dict):
            raise ValueError("stdin must be a candidate/jobs object")
        fields = cast(Mapping[str, object], value)
        candidate = fields.get("candidate")
        jobs = fields.get("jobs")
        if not isinstance(candidate, dict) or not isinstance(jobs, list):
            raise ValueError("payload needs candidate (object), jobs (array)")
        sources = cast(List[object], jobs)
        if not all(isinstance(job, dict) for job in sources):
            raise ValueError("every job must be an object")
        candidate_source = cast(Mapping[str, object], candidate)
        job_sources = tuple(cast(Mapping[str, object], job) for job in sources)
        return cls(
            candidate_source=candidate_source,
            candidate=CandidateProfile.from_json(candidate_source),
            jobs=tuple((job, JobProfile.from_json(job)) for job in job_sources),
        )


def request(candidate: Mapping[str, object], job: Mapping[str, object]) -> Request:
    return {
        "model": MODEL,
        "state": {"candidate": candidate, "job": job},
        "questions": {
            question.cell: {
                "type": "choice",
                "instructions": question.instructions,
                "criteria": {
                    option.name: option.criterion for option in question.options
                },
            }
            for question in QUESTIONS
        },
    }


def choose(
    question: Question, answers: Mapping[str, object]
) -> Union[Answer, Failure]:
    answer = answers.get(question.cell)
    fields: Mapping[str, object] = (
        cast(Mapping[str, object], answer) if isinstance(answer, dict) else {}
    )
    name = fields.get("choice")
    confidence = fields.get("confidence")
    option = next(
        (option for option in question.options if option.name == name), None
    )
    if option is None:
        return Failure(f"{question.cell}: unexpected choice {name!r}")
    # Every Choice answer carries a confidence. Its absence means the response
    # shape changed, which must fail the row loudly rather than quietly score
    # as an unknown cell.
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        return Failure(f"{question.cell}: answer carries no confidence")
    if not 0.0 <= confidence <= 1.0:
        return Failure(f"{question.cell}: confidence {confidence!r} outside 0..1")
    return Answer(option, float(confidence))


def parse_choices(body: object) -> Union[Choices, Failure]:
    """Every cell answered with a known option, or the first reason it wasn't."""
    answers = (
        cast(Mapping[str, object], body).get("answers")
        if isinstance(body, dict)
        else None
    )
    if not isinstance(answers, dict):
        return Failure("response has no answers object")
    table = cast(Mapping[str, object], answers)
    seniority = choose(SENIORITY, table)
    location = choose(LOCATION, table)
    domain = choose(DOMAIN, table)
    language = choose(LANGUAGE, table)
    preferences = choose(PREFERENCES, table)
    if (
        isinstance(seniority, Answer)
        and isinstance(location, Answer)
        and isinstance(domain, Answer)
        and isinstance(language, Answer)
        and isinstance(preferences, Answer)
    ):
        return Choices(seniority, location, domain, language, preferences)
    return next(
        picked
        for picked in (seniority, location, domain, language, preferences)
        if isinstance(picked, Failure)
    )


def to_match(
    candidate: CandidateProfile, job: JobProfile, choices: Choices
) -> MatchResult:
    held = held_terms(candidate, job)
    stack = stack_score(candidate, job)
    source: Dict[str, object] = {"url": job.url}
    collapsed = [
        cell
        for cell in get_args(Cell)
        if cast(Answer, getattr(choices, cell)).confidence < FLOOR
    ]
    if collapsed:
        source["match_uncertain"] = collapsed
    return MatchResult(
        source=source,
        score_breakdown=ScoreBreakdown(
            primary_stack=stack,
            seniority=choices.seniority.points,
            location=choices.location.points,
            domain=choices.domain.points,
            language=choices.language.points,
            preferences=choices.preferences.points,
        ),
        strengths=held,
        gaps=tuple(term for term in job.required_skills if term not in held),
        blockers=(),
    )


def match_job(
    post: Post,
    payload: Payload,
    source: Mapping[str, object],
    job: JobProfile,
) -> Dict[str, object]:
    reply = post(request(payload.candidate_source, source))
    choices = reply if isinstance(reply, Failure) else parse_choices(reply.body)
    if isinstance(choices, Failure):
        return {"url": job.url, "match_error": choices.reason}
    return to_match(payload.candidate, job, choices).to_json()


def match_all(payload: Payload, post: Post) -> List[Dict[str, object]]:
    return [match_job(post, payload, source, job) for source, job in payload.jobs]


def http_post(key: str) -> Post:
    def post(body: Request) -> Union[Reply, Failure]:
        call = urllib.request.Request(
            ENDPOINT,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(call, timeout=TIMEOUT) as response:
                return Reply(json.load(response))
        # OSError: HTTP status, network, timeout. HTTPException: a malformed or
        # truncated response, which urllib does not wrap. ValueError: bad JSON.
        except (OSError, http.client.HTTPException, ValueError) as error:
            return Failure(f"{type(error).__name__}: {error}")

    return post


def fail(reason: str) -> int:
    json.dump({"match_error": reason}, sys.stdout)
    sys.stdout.write("\n")
    return 1


def main() -> int:
    # Payload first: a malformed payload is malformed whether or not a key
    # exists, so reporting it does not depend on the environment.
    try:
        payload = Payload.from_json(json.load(sys.stdin))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as error:
        return fail(str(error))
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        return fail("TYPESAFE_API_KEY is not set")
    json.dump(match_all(payload, http_post(key)), sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

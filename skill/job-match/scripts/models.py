"""Immutable domain values and JSON boundary codecs for job matching scripts."""

from copy import deepcopy
from dataclasses import dataclass
from typing import Dict, FrozenSet, Iterable, Literal, Mapping, Optional, Tuple, cast


Decision = Literal[
    "excellent_match",
    "strong_match",
    "possible_match",
    "weak_match",
    "skip",
]
RequirementKind = Literal["required", "preferred"]
GuidanceStatus = Literal["held", "not_evidenced", "unknown"]


def _strings(value: object, name: str) -> Tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or not all(
        isinstance(item, str) for item in value
    ):
        raise ValueError(f"{name} must be an array of strings")
    return tuple(cast(str, item) for item in value)


def _optional_int(value: object, name: str) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer")
    return value


def _optional_string(value: object, name: str) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name} must be a string")
    return value


def evidence_tokens(value: object) -> FrozenSet[str]:
    """Collect source strings recursively using the scoring contract's rules."""
    found = set()

    def visit(item: object) -> None:
        if isinstance(item, dict):
            for child in item.values():
                visit(child)
        elif isinstance(item, list):
            for child in item:
                visit(child)
        elif isinstance(item, str) and item.strip():
            found.add(item.strip().lower())

    visit(value)
    return frozenset(found)


def direct_skill_hold(candidate_term: str, job_term: str) -> bool:
    """Return whether one candidate token directly covers a job skill token."""
    candidate = candidate_term.strip().casefold()
    job = job_term.strip().casefold()
    return bool(candidate and job) and (
        candidate == job or (candidate == "react.js" and job == "react")
    )


def held_terms(candidate: "CandidateProfile", job: "JobProfile") -> Tuple[str, ...]:
    return tuple(
        term
        for term in job.required_skills
        if any(direct_skill_hold(skill, term) for skill in candidate.skills)
    )


def stack_score(
    candidate: "CandidateProfile", job: "JobProfile"
) -> Optional["StackScore"]:
    """Primary stack counts; unscored when either skill list is empty."""
    if not (candidate.skills and job.required_skills):
        return None
    return StackScore(
        held=len(held_terms(candidate, job)), required=len(job.required_skills)
    )


@dataclass(frozen=True)
class Experience:
    company: str
    position: str
    date: str = ""

    @classmethod
    def from_json(cls, value: Mapping[str, object]) -> "Experience":
        company = value.get("company")
        position = value.get("position")
        date = value.get("date", "")
        if not isinstance(company, str) or not isinstance(position, str):
            raise ValueError("experience company and position must be strings")
        if not isinstance(date, str):
            raise ValueError("experience date must be a string")
        return cls(company=company, position=position, date=date)


@dataclass(frozen=True)
class CandidateProfile:
    roles: Tuple[str, ...] = ()
    skills: Tuple[str, ...] = ()
    years_experience: Optional[int] = None
    experience: Tuple[Experience, ...] = ()
    evidence_tokens: FrozenSet[str] = frozenset()

    @property
    def role_pairs(self) -> FrozenSet[Tuple[str, str]]:
        return frozenset((role.company, role.position) for role in self.experience)

    @classmethod
    def from_json(cls, value: Mapping[str, object]) -> "CandidateProfile":
        raw_experience = value.get("experience")
        if raw_experience is None:
            experience = ()
        elif isinstance(raw_experience, list) and all(
            isinstance(item, dict) for item in raw_experience
        ):
            experience = tuple(
                Experience.from_json(cast(Mapping[str, object], item))
                for item in raw_experience
            )
        else:
            raise ValueError("candidate.experience must be an array")
        return cls(
            roles=_strings(value.get("roles"), "candidate.roles"),
            skills=_strings(value.get("skills"), "candidate.skills"),
            years_experience=_optional_int(
                value.get("years_experience"), "candidate.years_experience"
            ),
            experience=experience,
            evidence_tokens=evidence_tokens(value),
        )


@dataclass(frozen=True)
class JobProfile:
    url: str = ""
    title: str = ""
    seniority: Optional[str] = None
    years_experience: Optional[str] = None
    required_skills: Tuple[str, ...] = ()
    preferred_skills: Tuple[str, ...] = ()
    evidence_tokens: FrozenSet[str] = frozenset()

    @classmethod
    def from_json(cls, value: Mapping[str, object]) -> "JobProfile":
        url = value.get("url", "")
        title = value.get("title", "")
        if not isinstance(url, str):
            raise ValueError("job.url must be a string")
        if not isinstance(title, str):
            raise ValueError("job.title must be a string")
        return cls(
            url=url,
            title=title,
            seniority=_optional_string(value.get("seniority"), "job.seniority"),
            years_experience=_optional_string(
                value.get("years_experience"), "job.years_experience"
            ),
            required_skills=_strings(
                value.get("required_skills"), "job.required_skills"
            ),
            preferred_skills=_strings(
                value.get("preferred_skills"), "job.preferred_skills"
            ),
            evidence_tokens=evidence_tokens(value),
        )


@dataclass(frozen=True)
class StackScore:
    held: int
    required: int
    source: Optional[Mapping[str, object]] = None

    def to_json(self) -> Dict[str, object]:
        output = deepcopy(dict(self.source or {}))
        output.update({"held": self.held, "required": self.required})
        return output


def _score_integer(name: str, value: object) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name}: cell: must be an integer, got {value!r}")
    return value


@dataclass(frozen=True)
class ScoreBreakdown:
    primary_stack: Optional[StackScore] = None
    experience: Optional[int] = None
    seniority: Optional[int] = None
    role_type: Optional[int] = None
    location: Optional[int] = None
    domain: Optional[int] = None
    language: Optional[int] = None
    preferences: Optional[int] = None
    source: Optional[Mapping[str, object]] = None

    @classmethod
    def from_json(
        cls, value: object, ignored: Iterable[str] = ()
    ) -> "ScoreBreakdown":
        if not isinstance(value, dict):
            raise ValueError("score_breakdown must be an object")
        ignored_names = frozenset(ignored)
        raw_stack = value.get("primary_stack")
        if raw_stack is None or "primary_stack" in ignored_names:
            stack = None
        elif not isinstance(raw_stack, dict):
            raise ValueError("primary_stack: cell must carry held/required counts")
        else:
            held = raw_stack.get("held")
            required = raw_stack.get("required")
            if isinstance(held, bool) or not isinstance(held, int):
                raise ValueError(
                    f"primary_stack.held: must be an integer, got {held!r}"
                )
            if isinstance(required, bool) or not isinstance(required, int):
                raise ValueError(
                    f"primary_stack.required: must be an integer, got {required!r}"
                )
            stack = StackScore(
                held=held, required=required, source=deepcopy(raw_stack)
            )
        return cls(
            primary_stack=stack,
            experience=(
                None
                if "experience" in ignored_names
                else _score_integer("experience", value.get("experience"))
            ),
            seniority=_score_integer("seniority", value.get("seniority")),
            role_type=(
                None
                if "role_type" in ignored_names
                else _score_integer("role_type", value.get("role_type"))
            ),
            location=_score_integer("location", value.get("location")),
            domain=_score_integer("domain", value.get("domain")),
            language=_score_integer("language", value.get("language")),
            preferences=_score_integer("preferences", value.get("preferences")),
            source=deepcopy(value),
        )

    def to_json(self) -> Dict[str, object]:
        output = deepcopy(dict(self.source or {}))
        output.update(
            {
                "primary_stack": (
                    self.primary_stack.to_json()
                    if self.primary_stack is not None
                    else None
                ),
                "experience": self.experience,
                "seniority": self.seniority,
                "role_type": self.role_type,
                "location": self.location,
                "domain": self.domain,
                "language": self.language,
                "preferences": self.preferences,
            }
        )
        return output


@dataclass(frozen=True)
class EvidenceDrop:
    list_name: str
    item: object

    def to_json(self) -> Dict[str, object]:
        return {"list": self.list_name, "item": deepcopy(self.item)}


@dataclass(frozen=True)
class MatchResult:
    source: Mapping[str, object]
    score_breakdown: ScoreBreakdown
    strengths: Optional[Tuple[object, ...]] = None
    gaps: Optional[Tuple[object, ...]] = None
    blockers: Optional[Tuple[object, ...]] = None
    evidence_dropped: Optional[Tuple[EvidenceDrop, ...]] = None
    match_score: Optional[int] = None
    confidence: Optional[float] = None
    decision: Optional[Decision] = None

    @classmethod
    def from_json(
        cls, value: object, ignored_breakdown: Iterable[str] = ()
    ) -> "MatchResult":
        if not isinstance(value, dict):
            raise ValueError("MatchResult must be an object")

        def items(name: str) -> Optional[Tuple[object, ...]]:
            raw = value.get(name)
            return tuple(deepcopy(raw)) if isinstance(raw, list) else None

        return cls(
            source=deepcopy(value),
            score_breakdown=ScoreBreakdown.from_json(
                value.get("score_breakdown"), ignored_breakdown
            ),
            strengths=items("strengths"),
            gaps=items("gaps"),
            blockers=items("blockers"),
        )

    @property
    def url(self) -> object:
        return self.source.get("url")

    def to_json(self) -> Dict[str, object]:
        output = deepcopy(dict(self.source))
        output["score_breakdown"] = self.score_breakdown.to_json()
        for name in ("strengths", "gaps", "blockers"):
            value = getattr(self, name)
            if value is not None:
                output[name] = list(deepcopy(value))
        if self.evidence_dropped is not None:
            output["evidence_dropped"] = [
                item.to_json() for item in self.evidence_dropped
            ]
        if self.match_score is not None:
            output["match_score"] = self.match_score
        if self.confidence is not None:
            output["confidence"] = self.confidence
        if self.decision is not None:
            output["decision"] = self.decision
        return output


@dataclass(frozen=True)
class Requirement:
    kind: RequirementKind
    job_term: str
    status: GuidanceStatus
    profile_term: Optional[str]

    def to_json(self) -> Dict[str, object]:
        return {
            "kind": self.kind,
            "job_term": self.job_term,
            "status": self.status,
            "profile_term": self.profile_term,
        }


@dataclass(frozen=True)
class ResumeGuidance:
    url: str
    requirements: Tuple[Requirement, ...]
    priority_roles: Tuple[object, ...] = ()
    warnings: Tuple[str, ...] = ()
    schema_version: int = 1

    def to_json(self) -> Dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "url": self.url,
            "requirements": [item.to_json() for item in self.requirements],
            "priority_roles": list(deepcopy(self.priority_roles)),
            "warnings": list(self.warnings),
        }

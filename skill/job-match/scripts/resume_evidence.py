#!/usr/bin/env python3
"""Validate ResumeEvidence v1 assessments against caller supplied sources."""

import json
import sys
from collections import Counter, defaultdict
from typing import Dict, List, Mapping, Optional, Sequence, Tuple


PAYLOAD_KEYS = frozenset({"cases", "assessments"})
CASE_KEYS = frozenset({"target", "requirements", "sources", "cv_assessed"})
REQUIREMENT_KEYS = frozenset({"id", "kind", "text"})
SOURCE_KEYS = frozenset({"id", "origin", "kind", "location", "text"})
ASSESSMENT_KEYS = frozenset({"target", "requirements"})
ROW_KEYS = frozenset(
    {"requirement_id", "support", "source_ids", "cv_visibility", "question"}
)
REQUIREMENT_KINDS = frozenset({"required", "preferred", "unclassified"})
SOURCE_ORIGINS = frozenset({"cv", "profile", "user"})
SOURCE_KINDS = frozenset({"achievement", "summary", "skill", "limitation"})
SUPPORT_VALUES = frozenset(
    {"direct", "partial", "listed_only", "unresolved", "confirmed_unmet"}
)
CV_VISIBILITY_VALUES = frozenset({"explicit", "implicit", "absent", "unassessed"})


def _invalid(target: object, errors: Sequence[str]) -> Dict[str, object]:
    return {
        "target": target if isinstance(target, str) else "",
        "errors": list(errors),
    }


def _payload_error(message: str) -> Dict[str, object]:
    return {"valid": [], "invalid": [_invalid("", (message,))]}


def _key_errors(
    value: Mapping[str, object], expected: frozenset, prefix: str
) -> List[str]:
    keys = set(value)
    errors = []
    missing = sorted(expected - keys)
    extra = sorted(keys - expected, key=str)
    if missing:
        errors.append(prefix + "missing keys: " + ", ".join(missing))
    if extra:
        errors.append(prefix + "unknown keys: " + ", ".join(map(str, extra)))
    return errors


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _case_errors(case: object, index: int) -> Tuple[str, List[str]]:
    target = case.get("target", "") if isinstance(case, dict) else ""
    errors: List[str] = []
    prefix = f"cases[{index}] "
    if not isinstance(case, dict):
        return "", [prefix + "must be an object"]

    errors.extend(_key_errors(case, CASE_KEYS, prefix))
    if not _nonempty_string(case.get("target")):
        errors.append(prefix + "target must be a non-empty string")
    if type(case.get("cv_assessed")) is not bool:
        errors.append(prefix + "cv_assessed must be a boolean")

    requirements = case.get("requirements")
    if not isinstance(requirements, list):
        errors.append(prefix + "requirements must be an array")
        requirements = []
    seen_requirements = set()
    for req_index, requirement in enumerate(requirements):
        req_prefix = f"{prefix}requirements[{req_index}] "
        if not isinstance(requirement, dict):
            errors.append(req_prefix + "must be an object")
            continue
        errors.extend(_key_errors(requirement, REQUIREMENT_KEYS, req_prefix))
        req_id = requirement.get("id")
        if not _nonempty_string(req_id):
            errors.append(req_prefix + "id must be a non-empty string")
        elif req_id in seen_requirements:
            errors.append(req_prefix + "id must be unique")
        else:
            seen_requirements.add(req_id)
        requirement_kind = requirement.get("kind")
        if not isinstance(requirement_kind, str) or requirement_kind not in REQUIREMENT_KINDS:
            errors.append(req_prefix + "kind is invalid")
        if not _nonempty_string(requirement.get("text")):
            errors.append(req_prefix + "text must be a non-empty string")

    sources = case.get("sources")
    if not isinstance(sources, list):
        errors.append(prefix + "sources must be an array")
        sources = []
    seen_sources = set()
    for source_index, source in enumerate(sources):
        source_prefix = f"{prefix}sources[{source_index}] "
        if not isinstance(source, dict):
            errors.append(source_prefix + "must be an object")
            continue
        errors.extend(_key_errors(source, SOURCE_KEYS, source_prefix))
        source_id = source.get("id")
        if not _nonempty_string(source_id):
            errors.append(source_prefix + "id must be a non-empty string")
        elif source_id in seen_sources:
            errors.append(source_prefix + "id must be unique")
        else:
            seen_sources.add(source_id)
        source_origin = source.get("origin")
        if not isinstance(source_origin, str) or source_origin not in SOURCE_ORIGINS:
            errors.append(source_prefix + "origin is invalid")
        source_kind = source.get("kind")
        if not isinstance(source_kind, str) or source_kind not in SOURCE_KINDS:
            errors.append(source_prefix + "kind is invalid")
        if not _nonempty_string(source.get("location")):
            errors.append(source_prefix + "location must be a non-empty string")
        if not _nonempty_string(source.get("text")):
            errors.append(source_prefix + "text must be a non-empty string")

    return target if isinstance(target, str) else "", errors


def _action(support: str, visibility: str) -> str:
    if support == "confirmed_unmet":
        return "report_gap"
    if support == "unresolved":
        return "confirm"
    if support == "listed_only":
        return "request_example"
    if support == "partial":
        return "clarify_scope"
    return {
        "unassessed": "inspect_cv",
        "absent": "surface_fact",
        "implicit": "clarify_wording",
        "explicit": "keep",
    }[visibility]


def _assessment_errors(
    assessment: object,
    case: Mapping[str, object],
    index: int,
) -> Tuple[List[str], Optional[Dict[str, object]]]:
    errors: List[str] = []
    prefix = f"assessments[{index}] "
    if not isinstance(assessment, dict):
        return [prefix + "must be an object"], None
    errors.extend(_key_errors(assessment, ASSESSMENT_KEYS, prefix))
    if not _nonempty_string(assessment.get("target")):
        errors.append(prefix + "target must be a non-empty string")

    trusted_requirements = case.get("requirements")
    if not isinstance(trusted_requirements, list):
        trusted_requirements = []
    trusted_sources = case.get("sources")
    if not isinstance(trusted_sources, list):
        trusted_sources = []

    source_index = {
        source["id"]: source
        for source in trusted_sources
        if isinstance(source, dict) and isinstance(source.get("id"), str)
    }
    worker_rows = assessment.get("requirements")
    if not isinstance(worker_rows, list):
        errors.append(prefix + "requirements must be an array")
        return errors, None

    if len(worker_rows) != len(trusted_requirements):
        errors.append(prefix + "requirements must match the trusted catalog length")

    expanded_rows: List[Dict[str, object]] = []
    for row_index, worker_row in enumerate(worker_rows):
        row_prefix = f"{prefix}requirements[{row_index}] "
        if not isinstance(worker_row, dict):
            errors.append(row_prefix + "must be an object")
            continue
        errors.extend(_key_errors(worker_row, ROW_KEYS, row_prefix))

        trusted = (
            trusted_requirements[row_index]
            if row_index < len(trusted_requirements)
            and isinstance(trusted_requirements[row_index], dict)
            else None
        )
        requirement_id = worker_row.get("requirement_id")
        if not _nonempty_string(requirement_id):
            errors.append(row_prefix + "requirement_id must be a non-empty string")
        if trusted is not None and requirement_id != trusted.get("id"):
            errors.append(row_prefix + "requirement_id must match trusted order")

        support = worker_row.get("support")
        if not isinstance(support, str) or support not in SUPPORT_VALUES:
            errors.append(row_prefix + "support is invalid")

        visibility = worker_row.get("cv_visibility")
        if not isinstance(visibility, str) or visibility not in CV_VISIBILITY_VALUES:
            errors.append(row_prefix + "cv_visibility is invalid")

        question = worker_row.get("question")
        if question is not None and not isinstance(question, str):
            errors.append(row_prefix + "question must be a string or null")
        elif question is not None and not _nonempty_string(question):
            errors.append(row_prefix + "question must not be empty")
        elif (
            isinstance(support, str)
            and support in {"partial", "listed_only", "unresolved"}
            and not _nonempty_string(question)
        ):
            errors.append(row_prefix + "question must be a specific non-empty string")

        raw_source_ids = worker_row.get("source_ids")
        cited_sources: List[Mapping[str, object]] = []
        if not isinstance(raw_source_ids, list):
            errors.append(row_prefix + "source_ids must be an array")
            source_ids: List[str] = []
        else:
            source_ids = []
            seen_ids = set()
            for source_id in raw_source_ids:
                if not _nonempty_string(source_id):
                    errors.append(row_prefix + "source_ids must contain non-empty strings")
                    continue
                if source_id in seen_ids:
                    errors.append(row_prefix + "source_ids must not contain duplicates")
                    continue
                seen_ids.add(source_id)
                source_ids.append(source_id)
                source = source_index.get(source_id)
                if source is None:
                    errors.append(row_prefix + f"source_id {source_id!r} is not trusted")
                else:
                    cited_sources.append(source)

        kinds = [source.get("kind") for source in cited_sources]
        cv_sources = [source for source in cited_sources if source.get("origin") == "cv"]
        cv_achievements = [
            source
            for source in cv_sources
            if source.get("kind") == "achievement"
        ]

        if isinstance(support, str) and support in {"direct", "partial"} and "achievement" not in kinds:
            errors.append(row_prefix + "direct and partial support require achievement evidence")
        if support == "listed_only" and (
            not cited_sources
            or any(
                not isinstance(kind, str) or kind not in {"summary", "skill"}
                for kind in kinds
            )
        ):
            errors.append(row_prefix + "listed_only requires only summary or skill evidence")
        if support == "confirmed_unmet" and "limitation" not in kinds:
            errors.append(row_prefix + "confirmed_unmet requires an explicit limitation source")

        cv_assessed = case.get("cv_assessed") is True
        if case.get("cv_assessed") is False and visibility != "unassessed":
            errors.append(row_prefix + "cv_visibility must be unassessed when cv_assessed is false")
        if isinstance(visibility, str) and visibility in {"explicit", "implicit"} and not cv_sources:
            errors.append(row_prefix + "explicit or implicit visibility requires a cited CV source")
        if (
            isinstance(visibility, str)
            and visibility in {"explicit", "implicit"}
            and isinstance(support, str)
            and support in {"direct", "partial"}
            and not cv_achievements
        ):
            errors.append(row_prefix + "visible direct or partial support requires a cited CV achievement")
        if visibility == "absent":
            if not cv_assessed:
                errors.append(row_prefix + "absent visibility requires complete CV assessment")
            if cv_sources:
                errors.append(row_prefix + "absent visibility cannot cite a CV source")

        if (
            trusted is not None
            and isinstance(support, str)
            and support in SUPPORT_VALUES
            and isinstance(visibility, str)
            and visibility in CV_VISIBILITY_VALUES
        ):
            expanded = {
                "requirement_id": requirement_id,
                "kind": trusted.get("kind"),
                "text": trusted.get("text"),
                "support": support,
                "source_ids": list(source_ids),
                "cv_visibility": visibility,
                "question": question,
                "action": _action(support, visibility),
                "sources": [
                    {
                        "id": source.get("id"),
                        "origin": source.get("origin"),
                        "kind": source.get("kind"),
                        "location": source.get("location"),
                        "text": source.get("text"),
                    }
                    for source in cited_sources
                ],
            }
            expanded_rows.append(expanded)

    if errors:
        return errors, None
    return [], {
        "schema_version": 1,
        "target": assessment.get("target"),
        "requirements": expanded_rows,
    }


def validate_payload(payload: object) -> Dict[str, object]:
    """Validate worker assessments while retaining trusted caller evidence."""
    if not isinstance(payload, dict):
        return _payload_error("payload must be an object")
    errors = _key_errors(payload, PAYLOAD_KEYS, "payload ")
    if errors:
        return {"valid": [], "invalid": [_invalid("", errors)]}
    cases = payload.get("cases")
    assessments = payload.get("assessments")
    if not isinstance(cases, list):
        return _payload_error("cases must be an array")
    if not isinstance(assessments, list):
        return _payload_error("assessments must be an array")

    case_targets: List[str] = []
    case_errors: List[List[str]] = []
    for index, case in enumerate(cases):
        target, found_errors = _case_errors(case, index)
        case_targets.append(target)
        case_errors.append(found_errors)

    case_counts = Counter(target for target in case_targets if target)
    for index, target in enumerate(case_targets):
        if target and case_counts[target] > 1:
            case_errors[index].append("trusted target must be unique")

    assessment_targets: List[str] = []
    malformed_assessments: Dict[int, List[str]] = {}
    for index, assessment in enumerate(assessments):
        if isinstance(assessment, dict):
            target = assessment.get("target", "")
            assessment_targets.append(target if isinstance(target, str) else "")
        else:
            assessment_targets.append("")
            malformed_assessments[index] = [f"assessments[{index}] must be an object"]

    assessment_counts = Counter(target for target in assessment_targets if target)
    target_to_case_indices: Dict[str, List[int]] = defaultdict(list)
    for index, target in enumerate(case_targets):
        if target:
            target_to_case_indices[target].append(index)

    valid: List[Dict[str, object]] = []
    invalid: List[Dict[str, object]] = []
    matched_assessment_indices = set()
    for case_index, case in enumerate(cases):
        target = case_targets[case_index]
        errors_for_case = list(case_errors[case_index])
        if not isinstance(case, dict):
            invalid.append(_invalid(target, errors_for_case))
            continue

        assessment_indexes = [
            i for i, item_target in enumerate(assessment_targets) if target and item_target == target
        ]
        if not assessment_indexes:
            errors_for_case.append("assessment is missing for trusted target")
        elif len(assessment_indexes) > 1:
            errors_for_case.append("exactly one assessment is required per trusted target")
            matched_assessment_indices.update(assessment_indexes)
        else:
            assessment_index = assessment_indexes[0]
            matched_assessment_indices.add(assessment_index)
            if assessment_counts[target] > 1:
                errors_for_case.append("assessment target must be unique")
            assessment = assessments[assessment_index]
            if not errors_for_case and isinstance(assessment, dict):
                row_errors, expanded = _assessment_errors(assessment, case, assessment_index)
                errors_for_case.extend(row_errors)
                if assessment.get("target") != target:
                    errors_for_case.append("assessment target must match trusted target")
                if not errors_for_case and expanded is not None:
                    valid.append(expanded)
            elif not isinstance(assessment, dict):
                errors_for_case.extend(malformed_assessments.get(assessment_index, ()))

        if errors_for_case:
            invalid.append(_invalid(target, errors_for_case))

    for assessment_index, assessment in enumerate(assessments):
        if assessment_index in matched_assessment_indices:
            continue
        target = assessment_targets[assessment_index]
        if target in target_to_case_indices:
            # A duplicated trusted target makes its assessments part of that invalid case.
            continue
        if not target:
            invalid.append(
                _invalid(
                    "",
                    malformed_assessments.get(
                        assessment_index,
                        [f"assessments[{assessment_index}] target must be a non-empty string"],
                    ),
                )
            )
        else:
            invalid.append(
                _invalid(target, ["assessment target has no trusted case"])
            )

    return {"valid": valid, "invalid": invalid}


def main() -> int:
    """Read one JSON payload from stdin, write one JSON result to stdout."""
    try:
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        result = _payload_error(f"malformed JSON input: {error}")
    else:
        result = validate_payload(payload)
    sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False) + "\n").encode("utf-8"))
    return 0 if not result["invalid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

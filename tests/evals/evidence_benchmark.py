#!/usr/bin/env python3
"""Frozen, opt-in before/after/control benchmark for job-resume-review evidence behavior.

This harness records full model traces and tool diagnostics. It never calls the model at import
time; live generations and report judging happen only through the explicit CLI or API functions.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
import resume_review  # noqa: E402

CASE_NAMES = (
    "selected_job_evidence",
    "strongest_proof_gaps",
    "ownership_inflation",
    "pdf_with_source",
)
CASES = {case.name: case for case in resume_review.CASES if case.name in CASE_NAMES}
MAX_CONCURRENCY = 3
DEFAULT_REPEATS = {"before": 3, "after": 3, "control": 1}
PHASES = set(DEFAULT_REPEATS)
BENCHMARK_VERSION = 2

# Requirement and evidence identifiers are normalized by the blinded assessor. The facts below
# are deliberately separate from writer inputs; they are never copied into a work/profile tree.
GOLD = {
    "selected_job_evidence": {
        "supported": {
            "R1": ["E1.B1", "E1.B2", "E2.B1"],
            "R2": ["E2.B3"],
            "R3": ["E1.B2"],
            "R4": ["E1.B2"],
        },
        "actions": {
            "R1": {"support": "direct", "actions": ["inspect_cv"]},
            "R2": {"support": "direct", "actions": ["inspect_cv"]},
            "R3": {"support": "direct", "actions": ["inspect_cv"]},
            "R4": {"support": "direct", "actions": ["inspect_cv"]},
        },
        "strongest": [],
        "pdf": [],
    },
    "strongest_proof_gaps": {
        "supported": {"R1": ["E1.B2"], "R3": ["PROFILE.E1.B3"]},
        "actions": {
            "R1": {"support": "implicit", "actions": ["clarify_wording"]},
            "R2": {"support": "listed_only", "actions": ["request_example"]},
            "R3": {"support": "profile_only", "actions": ["surface_fact"]},
            "R4": {"support": "unconfirmed", "actions": ["ask_clarifying_question"]},
        },
        "strongest": ["E1.B2"],
        "pdf": [],
    },
    "ownership_inflation": {
        "supported": {},
        "actions": {
            "R1": {"support": "discrepancy", "actions": ["flag_discrepancy"]},
        },
        "strongest": [],
        "pdf": [],
    },
    "pdf_with_source": {
        "supported": {},
        "actions": {},
        "strongest": [],
        "pdf": ["extraction_failure", "source_mismatch"],
    },
}

CASE_RUBRICS = {
    "selected_job_evidence": (
        "The supplied remote Brazil backend posting asks for 5+ years in Python or Go, PostgreSQL and Kubernetes in production, and AWS as a preferred skill. The profile primary list has Python and Go but omits Kubernetes; the Lumen Pay canonical experience bullet demonstrates AWS EKS/Kubernetes. Experience runs from January 2019 to the present. This is a match-only profile assessment: expect a recommendation to inspect the CV separately, and do not claim that a CV review took place."
    ),
    "strongest_proof_gaps": (
        "The supplied posting asks for deployment automation, Kubernetes, Terraform, and technical leadership/management. The CV's E1.B2 release pipeline is relevant proof for deployment automation. Kubernetes is in the CV skills list only. The profile says Alex wrote Terraform modules for an internal migration, absent from the CV at PROFILE.E1.B3. The profile contains no confirmed direct-report, hiring, or performance-management scope. Credit profile-only Terraform as private evidence only; do not call it visible CV alignment. The strongest relevant CV proof for this posting is E1.B2."
    ),
    "ownership_inflation": (
        "There is no supplied posting in this case. The CV says Alex led billing releases (E1.B2); the canonical Lumen Pay source says Alex supported release planning and launch coordination. The report should identify the wording difference and ask Alex to clarify scope. It must not assert that Alex led the work or that Alex fabricated the claim."
    ),
    "pdf_with_source": (
        "There is no supplied posting in this case. The PDF visually prints PostgreSQL, and the matching source text also says PostgreSQL, but its ActualText extraction reads Postgre SQL. This is an extraction failure. The PDF labels the employer Lumen Payments while the paired same-stem source says Lumen Pay; this is a PDF/source mismatch. The source mismatch alone does not justify an automatic score cap."
    ),
}

# Normalize report-specific requirement rows into stable semantic labels.
# A writer may split "Python or Go plus 5+ years" across multiple rows; those
# rows share selected R1 because the posting asks for either language.
CASE_REQUIREMENT_LABELS = {
    "selected_job_evidence": {
        "R1": "5+ years of backend experience using Python or Go",
        "R2": "PostgreSQL experience",
        "R3": "Kubernetes production experience",
        "R4": "AWS experience (preferred)",
    },
    "strongest_proof_gaps": {
        "R1": "Deployment automation",
        "R2": "Kubernetes",
        "R3": "Terraform",
        "R4": "Technical leadership or management",
    },
    "ownership_inflation": {"R1": "Release ownership / leadership claim"},
    "pdf_with_source": {},
}

SOURCE_MAPPINGS = {
    "selected_job_evidence": {
        "E1.B1": "profile data/experiences.yml → first Lumen Pay summary[] bullet.",
        "E1.B2": "profile data/experiences.yml → second Lumen Pay summary[] bullet.",
        "E2.B1": "profile data/experiences.yml → first Orbit Logistics summary[] bullet.",
        "E2.B3": "profile data/experiences.yml → third Orbit Logistics summary[] bullet.",
    },
    "strongest_proof_gaps": {
        "E1.B1": "candidate CV → first Lumen Pay experience bullet (checkout latency).",
        "E1.B2": "candidate CV → second Lumen Pay experience bullet (GitHub Actions release workflow).",
        "CV.SKILLS.Kubernetes": "candidate CV → skills list names Kubernetes, without an experience achievement.",
        "E2.B3": "candidate CV → third Orbit Logistics experience bullet (PostgreSQL partitioning).",
        "PROFILE.E1.B3": "profile data/experiences.yml → third Lumen Pay summary[] bullet says Alex wrote Terraform modules; profile-only fact absent from the CV.",
    },
    "ownership_inflation": {
        "E1.B2": "candidate CV → second Lumen Pay experience bullet says Led releases.",
        "PROFILE.E1.B2": "profile data/experiences.yml → second Lumen Pay summary[] bullet says Supported release planning.",
    },
    "pdf_with_source": {},
}


def _case_materials(case_name: str) -> dict:
    case = CASES[case_name]
    cv_text = case.edit((resume_review.FIXTURES / "base.md").read_text(encoding="utf-8"))
    profile_files = {}
    if case.profile:
        profile_dir = resume_review.FIXTURES / "profiles" / case.profile / "data"
        profile_files = {
            path.name: path.read_text(encoding="utf-8")
            for path in sorted(profile_dir.iterdir()) if path.is_file()
        }
    posting_text = None
    if case.posting:
        posting_name = case.posting if isinstance(case.posting, str) else "posting.md"
        posting_text = (resume_review.FIXTURES / posting_name).read_text(encoding="utf-8")
    paired_source = None
    if case.source_pdf:
        paired_source = (resume_review.FIXTURES / "cases" / case.source_pdf).read_text(encoding="utf-8")
    result = {
        "profile_data_files": profile_files,
        "posting_body": posting_text,
        "paired_source_text": paired_source,
        "pdf_actual_text_override": {"visible": "PostgreSQL", "extracted": "Postgre SQL"}
        if case.source_pdf else None,
        "source_mappings": SOURCE_MAPPINGS[case_name],
        "requirement_labels": CASE_REQUIREMENT_LABELS[case_name],
    }
    if case.skill != "job-match":
        result["candidate_cv_source_text"] = cv_text
        result["candidate_cv_input_type"] = "PDF generated from candidate_cv_source_text with the pdf fixture" if case.source_pdf else "Markdown"
    return result

JUDGE_INSTRUCTIONS = r"""You are an evidence assessor for a fixed resume-review benchmark. Assess each report independently against the supplied case rubric and gold facts. Return only JSON with the exact schema described below.

Do not reward or penalize formatting, headings, report length, score values, headers, or the number/type of tools used. The report's conclusions and evidence handling are the only quality inputs. Do not infer a claim that the report does not make. Normalize report requirements by meaning to the supplied canonical requirement labels and source pointers. Do not copy a report's R-number blindly: if a canonical requirement is split across multiple report rows, combine those rows under its one canonical label; if numbering differs, use meaning. For selected-job R1, Python and Go evidence are alternatives within one 5+ years backend-language requirement. Count a source association when the report attributes that source to any component of the canonical requirement.

The payload includes the complete raw CV, profile, posting, and paired source inputs, plus explicit source-pointer mappings. Use these raw inputs to distinguish visible CV evidence from private profile-only facts. The profile data are assessor context only and were not added to the writer prompt beyond the paths and files available to the skill.

For each report ID, return:
{"id":"...","claims":{"links":[{"requirement":"R1","source":"E1.B1","excerpt":"an exact substring from the report","reason":"why the report makes this supported-evidence claim"}],"actions":{"R1":{"support":"direct|implicit|listed_only|profile_only|unconfirmed|discrepancy|source_mismatch|other","action":"short action wording, in snake_case or ordinary words","excerpt":"an exact substring from the report, or empty if the report gives no action","reason":"why this action/support classification applies"}},"strongest":[{"source":"E1.B1","excerpt":"an exact substring from the report","reason":"why the report identifies this as strong proof"}],"pdf":[{"label":"extraction_failure|source_mismatch|automatic_source_mismatch_cap|other","excerpt":"an exact substring from the report","reason":"why this PDF diagnosis or cap behavior applies"}],"ownership_violation":{"value":false,"excerpt":"exact offending substring, or empty if no violation","reason":"why this is or is not a violation"},"private_credit_violation":{"value":false,"excerpt":"exact offending substring, or empty if no violation","reason":"why this is or is not a violation"}}}

Return an `actions` assessment for every requirement listed in gold actions. Empty excerpts mean the report omitted the action and must have a reason saying it was absent. Every non-empty excerpt must be copied verbatim from that report. Use no extra keys. Action wording may be ordinary prose; the harness maps clear semantic equivalents such as “inspect/check the base CV” to `inspect_cv`, “add the verified private fact to the CV” to `surface_fact`, “make the term explicit” to `clarify_wording`, and “note the source discrepancy and ask” to `flag_discrepancy`. If the report itself says a required validation step was blocked by tool permission or runtime failure, state that in the reason and do not treat the blocked step as an algorithmic mistake. A permission failure must never be silently scored as a report-quality failure.

Evidence links are requirement/source pairs, not mentions of the requirement alone. Do not add a link if the report does not attribute that source to that requirement. For `strongest`, include only sources the report clearly recommends or calls strong proof. For `pdf`, diagnose only conditions the report explicitly identifies; if it applies an automatic source-mismatch score cap, add `automatic_source_mismatch_cap`. `ownership_violation.value` is true if the report asserts Alex led the releases as fact or claims fabrication; a neutral discrepancy/question is not a violation. `private_credit_violation.value` is true if the report presents profile-only Terraform as recruiter-visible CV alignment. A recommendation to add a truthful private fact to the CV is not itself a violation. For a source mismatch, reward an explicit diagnosis without an automatic source-mismatch score cap; the cap label is harmful and lowers PDF intersection-over-union.

The input supplies candidate reports under anonymous IDs in shuffled order. Do not infer their phase or compare writing style. Return exactly {"reports":[...one object for every supplied ID...]}."""


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha_file(path: Path) -> str:
    return _sha_bytes(path.read_bytes())


def _tree_files(root: Path) -> List[Path]:
    found = []
    for path in root.rglob("*"):
        if "__pycache__" in path.parts or path.suffix == ".pyc":
            continue
        if path.is_symlink():
            raise ValueError(f"snapshot contains a symlink: {path}")
        if path.is_file():
            found.append(path)
    return sorted(found, key=lambda item: item.relative_to(root).as_posix())


def _tree_hash(root: Path) -> Tuple[str, int]:
    if not root.is_dir():
        raise FileNotFoundError(f"skill root does not exist: {root}")
    digest = hashlib.sha256()
    files = _tree_files(root)
    for path in files:
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest(), len(files)


def _remove_tree(path: Path) -> None:
    if not path.exists():
        return
    for child in path.rglob("*"):
        try:
            child.chmod(0o755 if child.is_dir() else 0o644)
        except OSError:
            pass
    try:
        path.chmod(0o755)
    except OSError:
        pass
    shutil.rmtree(path, ignore_errors=True)


def _source_tree_hash(root: Path) -> Tuple[str, int]:
    """Hash source content as the copy operation sees it, allowing only internal symlinks."""
    root = root.resolve(strict=True)
    digest = hashlib.sha256()
    files: List[Tuple[str, Path]] = []

    def visit(directory: Path, relative: Path, active: Set[Path]) -> None:
        resolved = directory.resolve(strict=True)
        try:
            resolved.relative_to(root)
        except ValueError as error:
            raise ValueError(f"external symlink is not allowed in skill source: {directory}") from error
        if resolved in active:
            raise ValueError(f"symlink loop in skill source at {directory}")
        active = set(active)
        active.add(resolved)
        for entry in sorted(directory.iterdir(), key=lambda item: item.name):
            if entry.name == "__pycache__" or entry.suffix == ".pyc":
                continue
            resolved_entry = entry.resolve(strict=True) if entry.is_symlink() else entry
            try:
                resolved_entry.relative_to(root)
            except ValueError as error:
                raise ValueError(f"external symlink is not allowed: {entry} -> {resolved_entry}") from error
            target_relative = relative / entry.name
            if resolved_entry.is_dir():
                visit(entry, target_relative, active)
            elif resolved_entry.is_file():
                files.append((target_relative.as_posix(), resolved_entry))

    visit(root, Path(), set())
    for relative_name, path in sorted(files, key=lambda item: item[0]):
        relative = relative_name.encode("utf-8")
        content = path.read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest(), len(files)


def _repo_ref(source: Path) -> Optional[str]:
    for candidate in (source / "snapshot.json", source / "original-snapshot.json",
                      source.parent / "snapshot.json", source.parent / "original-snapshot.json"):
        if candidate.is_file():
            try:
                value = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(value, Mapping):
                    reference = value.get("repo_ref") or value.get("source_repo_ref") or value.get("commit")
                    if isinstance(reference, str) and reference.strip():
                        return reference.strip()
            except (OSError, json.JSONDecodeError):
                pass
    for parent in (source.resolve(), *source.resolve().parents):
        if (parent / ".git").exists():
            try:
                return subprocess.run(["git", "-C", str(parent), "rev-parse", "HEAD"],
                                      capture_output=True, text=True, check=True, timeout=10).stdout.strip()
            except (OSError, subprocess.SubprocessError):
                return None
    return None


def snapshot_skills(source: Path, destination: Path) -> dict:
    """Copy a skill tree into an independent, symlink-free frozen snapshot and return its metadata."""
    source = Path(source).resolve(strict=True)
    destination = Path(destination).absolute()
    if destination.exists():
        raise FileExistsError(f"snapshot output already exists: {destination}")
    try:
        destination.resolve().relative_to(source)
    except ValueError:
        pass
    else:
        raise ValueError("snapshot destination cannot be inside its source tree")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.mkdir()

    def copy_directory(source_dir: Path, target_dir: Path, active: Set[Path]) -> None:
        resolved_dir = source_dir.resolve(strict=True)
        if resolved_dir in active:
            raise ValueError(f"symlink loop in skill tree at {source_dir}")
        active = set(active)
        active.add(resolved_dir)
        for entry in sorted(source_dir.iterdir(), key=lambda item: item.name):
            if entry.name == "__pycache__" or entry.suffix == ".pyc":
                continue
            resolved = entry.resolve(strict=True) if entry.is_symlink() else entry
            if entry.is_symlink():
                try:
                    resolved.relative_to(source)
                except ValueError as error:
                    raise ValueError(f"external symlink is not allowed: {entry} -> {resolved}") from error
            target = target_dir / entry.name
            if resolved.is_dir():
                target.mkdir()
                copy_directory(resolved, target, active)
            elif resolved.is_file():
                shutil.copyfile(resolved, target)

    try:
        copy_directory(source, destination, set())
        skill_hash, file_count = _tree_hash(destination)
        for path in destination.rglob("*"):
            if path.is_file():
                path.chmod(0o444)
        for path in sorted((p for p in destination.rglob("*") if p.is_dir()),
                           key=lambda item: len(item.parts), reverse=True):
            path.chmod(0o555)
        destination.chmod(0o555)
    except Exception:
        _remove_tree(destination)
        raise
    return {
        "hash": skill_hash,
        "file_count": file_count,
        "source": str(source),
        "destination": str(destination),
        "repo_ref": _repo_ref(source),
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "symlinks_in_snapshot": 0,
    }


def _harness_descriptor() -> dict:
    files = [
        HERE / "evidence_benchmark.py",
        HERE / "resume_review.py",
        HERE / "pdf_fixture.py",
        HERE / "report_parse.py",
        REPO / "tests" / "test_resume_review_evals.py",
    ]
    file_hashes = {}
    for path in files:
        if path.is_file():
            file_hashes[path.relative_to(REPO).as_posix()] = _sha_file(path)
    fixture_root = HERE / "fixtures" / "resume_review"
    for path in sorted(fixture_root.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
            file_hashes[path.relative_to(REPO).as_posix()] = _sha_file(path)
    case_manifest = {}
    for name, case in CASES.items():
        case_manifest[name] = {
            "skill": case.skill,
            "profile": case.profile,
            "source_pdf": case.source_pdf,
            "posting": case.posting,
            "context": case.context,
            "hidden": list(case.hidden),
        }
    return {
        "version": BENCHMARK_VERSION,
        "files": file_hashes,
        "cases": case_manifest,
        "gold": GOLD,
        "case_rubrics": CASE_RUBRICS,
        "requirement_labels": CASE_REQUIREMENT_LABELS,
        "source_mappings": SOURCE_MAPPINGS,
        "raw_case_materials": {name: _case_materials(name) for name in CASE_NAMES},
        "judge_instructions": JUDGE_INSTRUCTIONS,
        "configuration": _benchmark_configuration(),
    }


def benchmark_digest() -> str:
    return _sha_bytes(_json_bytes(_harness_descriptor()))


def _benchmark_configuration() -> dict:
    return {
        "concurrency": MAX_CONCURRENCY,
        "tool_allowlist_by_skill": {
            "job-resume-review": list(resume_review.ALLOWED),
            "job-match": list(resume_review.JOB_MATCH_ALLOWED),
        },
        "runner_flags": ["--safe-mode", "--no-session-persistence", "--output-format", "stream-json"],
        "assessor_tool_flags": ["--tools", ""],
        "external_browsing": False,
        "python_dont_write_bytecode": True,
        "profile_relative_path": "profile",
        "scratch_relative_path": "tmp",
        "generation_timeout_seconds": resume_review.TIMEOUT,
        "assessor_timeout_seconds": resume_review.TIMEOUT,
    }


def _token(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_")


SUPPORT_ALIASES = {
    "direct": {"direct", "visible", "supported", "direct_evidence", "experience_evidence"},
    "implicit": {"implicit", "implied", "not_named", "implied_evidence"},
    "listed_only": {"listed_only", "skills_only", "skills_list_only", "listed_in_skills_only"},
    "profile_only": {"profile_only", "private_profile", "private_evidence", "profile_evidence_only"},
    "unconfirmed": {"unconfirmed", "unknown", "not_confirmed", "uncorroborated", "no_confirmation"},
    "discrepancy": {"discrepancy", "conflict", "source_conflict", "mismatch"},
    "source_mismatch": {"source_mismatch", "pdf_source_mismatch", "source_difference"},
}

ACTION_ALIASES = {
    "inspect_cv": {"inspect_base_cv", "check_cv", "check_base_cv", "review_cv", "inspect_resume", "check_resume", "look_at_cv"},
    "preserve_evidence": {"preserve", "retain", "keep", "leave_unchanged", "preserve_current_evidence"},
    "clarify_wording": {"clarify", "make_explicit", "make_term_explicit", "spell_out", "name_explicitly"},
    "request_example": {"ask_for_example", "request_evidence", "seek_example", "ask_for_proof"},
    "surface_fact": {"add_to_cv", "add_to_resume", "surface_private_fact", "include_verified_fact", "surface_verified_fact", "include_on_cv"},
    "ask_clarifying_question": {"ask", "request_clarification", "clarify_scope", "confirm_scope", "ask_about_scope"},
    "flag_discrepancy": {"note_discrepancy", "flag_conflict", "report_difference", "ask_about_discrepancy", "clarify_claim"},
    "no_automatic_cap": {"no_cap", "do_not_cap", "avoid_automatic_cap", "do_not_apply_automatic_cap", "no_automatic_score_cap"},
}


def _canonical_support(value: object) -> str:
    token = _token(value)
    for canonical, aliases in SUPPORT_ALIASES.items():
        if token == canonical or token in aliases:
            return canonical
    if "skill" in token and "only" in token:
        return "listed_only"
    if "profile" in token and ("only" in token or "private" in token):
        return "profile_only"
    if any(fragment in token for fragment in ("not_confirm", "unverified", "unknown", "unsubstantiated")):
        return "unconfirmed"
    if any(fragment in token for fragment in ("conflict", "mismatch", "discrep")):
        return "discrepancy"
    return token


def _canonical_action(value: object, allowed: Sequence[str]) -> str:
    token = _token(value)
    for canonical in allowed:
        if token == canonical or token in ACTION_ALIASES.get(canonical, set()):
            return canonical
    wording = str(value or "").strip().lower()
    for canonical in allowed:
        if canonical == "inspect_cv" and re.search(r"\b(inspect|check|review|look at)\b.*\b(cv|resume)\b", wording):
            return canonical
        if canonical == "surface_fact" and re.search(r"\b(add|include|surface|incorporate|put|bring)\b.*\b(cv|resume)\b", wording):
            return canonical
        if canonical == "clarify_wording" and re.search(r"\b(make|state|spell|name|write)\b.*\b(explicit|clearly|clearly|term|keyword|wording)\b", wording):
            return canonical
        if canonical == "request_example" and re.search(r"\b(ask|request|seek|provide)\b.*\b(example|evidence|proof|demonstration)\b", wording):
            return canonical
        if canonical == "ask_clarifying_question" and re.search(r"\b(ask|confirm|clarify|request)\b.*\b(scope|direct reports|management|hiring|team)\b", wording):
            return canonical
        if canonical == "flag_discrepancy" and re.search(r"\b(flag|note|report|identify|clarify|ask about)\b.*\b(discrepancy|difference|conflict|mismatch|ownership|scope)\b", wording):
            return canonical
        if canonical == "preserve_evidence" and re.search(r"\b(keep|retain|preserve|leave)\b.*\b(evidence|credit|as is|unchanged)\b", wording):
            return canonical
        if canonical == "no_automatic_cap" and re.search(r"\b(no|avoid|do not|don't|without)\b.*\b(automatic|score|scoring|source mismatch)\b.*\b(cap|capping|reduction)\b", wording):
            return canonical
    return token


def score_claims(gold: Mapping[str, object], claims: Mapping[str, object]) -> dict:
    """Score normalized evidence claims as independent numerator/denominator counts."""
    expected_supported = gold.get("supported", {})
    expected_pairs = {
        (requirement, source)
        for requirement, sources in expected_supported.items()
        for source in sources
    }
    predicted_pairs = set()
    for item in claims.get("links", []) or []:
        if isinstance(item, Mapping):
            pair = (str(item.get("requirement", "")), str(item.get("source", "")))
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            pair = (str(item[0]), str(item[1]))
        else:
            continue
        if pair[0] and pair[1]:
            predicted_pairs.add(pair)
    correct_pairs = predicted_pairs & expected_pairs
    covered_requirements = {requirement for requirement, _ in correct_pairs}
    link_precision = [len(correct_pairs), len(predicted_pairs)] if predicted_pairs else [0, 0]
    requirement_coverage = [len(covered_requirements), len(expected_supported)]

    expected_actions = gold.get("actions", {})
    predicted_actions = claims.get("actions", {}) or {}
    correct_actions = 0
    for requirement, target in expected_actions.items():
        actual = predicted_actions.get(requirement, {}) if isinstance(predicted_actions, Mapping) else {}
        if not isinstance(actual, Mapping):
            continue
        action = actual.get("action")
        allowed_actions = target.get("actions", [])
        if isinstance(action, list):
            action_ok = any(_canonical_action(item, allowed_actions) in allowed_actions for item in action)
        else:
            action_ok = _canonical_action(action, allowed_actions) in allowed_actions
        if _canonical_support(actual.get("support")) == target.get("support") and action_ok:
            correct_actions += 1

    strongest_value = claims.get("strongest", [])
    if isinstance(strongest_value, str):
        strongest_value = [strongest_value]
    predicted_strongest = set(str(item) for item in strongest_value or [] if item)
    expected_strongest = set(gold.get("strongest", []))
    pdf_value = claims.get("pdf", [])
    if isinstance(pdf_value, str):
        pdf_value = [pdf_value]
    predicted_pdf = set(str(item) for item in pdf_value or [] if item)
    expected_pdf = set(gold.get("pdf", []))
    pdf_union = predicted_pdf | expected_pdf
    pdf_intersection = predicted_pdf & expected_pdf

    strongest_hit = bool(predicted_strongest & expected_strongest)
    return {
        "link_precision": link_precision,
        "requirement_coverage": requirement_coverage,
        "gap_actions": [correct_actions, len(expected_actions)],
        "strongest_proof": [1 if strongest_hit else 0, 1 if expected_strongest else 0],
        "pdf_diagnosis": [len(pdf_intersection), len(pdf_union)],
        "ownership_violation": [1 if bool(claims.get("ownership_violation")) else 0, 1],
        "private_credit_violation": [1 if bool(claims.get("private_credit_violation")) else 0, 1],
    }


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                         encoding="utf-8")
    os.replace(temporary, path)


def _events(stdout: str) -> List[dict]:
    found = []
    for line in stdout.splitlines():
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            found.append(value)
    return found


def _model_metadata(events: Sequence[Mapping[str, object]]) -> List[str]:
    found: Set[str] = set()
    for event in events:
        if event.get("type") == "system" or event.get("type") == "result":
            for key in ("model", "model_id", "modelId", "model_name"):
                value = event.get(key)
                if isinstance(value, str) and value.strip():
                    found.add(value.strip())
            usage = event.get("modelUsage")
            if isinstance(usage, Mapping):
                found.update(str(key) for key in usage if str(key).strip())
    return sorted(found)


def _all_strings(value: object) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for key, item in value.items():
            yield str(key)
            yield from _all_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _all_strings(item)


def _tool_diagnostics(events: Sequence[Mapping[str, object]], work: Path) -> dict:
    counts: Dict[str, int] = {}
    write_paths = []
    task_requested = False
    text_blobs = list(_all_strings(events))
    for event in events:
        if event.get("type") != "assistant":
            continue
        message = event.get("message", {})
        blocks = message.get("content", []) if isinstance(message, Mapping) else []
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if not isinstance(block, Mapping) or block.get("type") != "tool_use":
                continue
            name = str(block.get("name", "unknown"))
            counts[name] = counts.get(name, 0) + 1
            if name in {"Task", "TaskOutput"}:
                task_requested = True
            if name in {"Write", "Edit", "NotebookEdit"}:
                inputs = block.get("input", {})
                if isinstance(inputs, Mapping):
                    value = next((inputs.get(key) for key in ("file_path", "path", "filePath")
                                  if inputs.get(key)), None)
                    if isinstance(value, str):
                        candidate = Path(value)
                        if not candidate.is_absolute():
                            candidate = work / candidate
                        resolved = candidate.resolve(strict=False)
                        try:
                            resolved.relative_to((work / "tmp").resolve())
                            inside = True
                        except ValueError:
                            inside = False
                        write_paths.append({"tool": name, "path": str(resolved),
                                            "inside_scratch": inside,
                                            "outside_scratch": not inside})
    diagnostic_text = "\n".join(text_blobs).lower()
    permission_pattern = re.compile(
        r"(?:task|agent|subagent).{0,100}(?:not allowed|disallow|permission denied|blocked|unavailable)"
        r"|(?:not allowed|disallow|permission denied|blocked|unavailable).{0,100}(?:task|agent|subagent)",
        re.S,
    )
    if permission_pattern.search(diagnostic_text):
        validation_status = "permission_denied"
    elif task_requested:
        validation_status = "worker_invoked"
    else:
        validation_status = "not_observed"
    return {
        "counts": counts,
        "total": sum(counts.values()),
        "write_audit": {
            "structured_write_paths": write_paths,
            "outside_scratch_paths": [entry for entry in write_paths if entry["outside_scratch"]],
            "limitations": "This audit records structured Write/Edit paths and Bash command text. It cannot prove or enumerate transient filesystem writes made inside Bash, nor detect all indirect writes through arbitrary programs.",
        },
        "worker_validation_status": validation_status,
        "worker_validation_permission_error": permission_pattern.search(diagnostic_text).group(0)
        if permission_pattern.search(diagnostic_text) else None,
    }


def _profile_hashes(profile_root: Path) -> Dict[str, str]:
    if not profile_root.is_dir():
        return {}
    return {
        path.relative_to(profile_root).as_posix(): _sha_file(path)
        for path in sorted(profile_root.rglob("*"))
        if path.is_file() and not path.is_symlink() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }


def _digest_manifest(manifest: Mapping[str, str]) -> str:
    return _sha_bytes(_json_bytes(manifest))


def _normal_prompt_hash(prompt: str, work: Path, skills_root: Path) -> str:
    normalized = prompt
    replacements = {(str(path), label) for path, label in
                    ((work, "<WORK_ROOT>"), (work.resolve(), "<WORK_ROOT>"),
                     (skills_root, "<SKILLS_ROOT>"), (skills_root.resolve(), "<SKILLS_ROOT>"))}
    for path, label in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        normalized = normalized.replace(path, label)
    return _sha_bytes(normalized.encode("utf-8"))


def _make_read_only(root: Path) -> None:
    if not root.exists():
        return
    for path in sorted(root.rglob("*"), key=lambda item: len(item.parts), reverse=True):
        if path.is_file():
            path.chmod(0o444)
        elif path.is_dir():
            path.chmod(0o555)
    root.chmod(0o555)


def _cli_version() -> str:
    executable = shutil.which("claude")
    if not executable:
        raise FileNotFoundError("claude CLI is not installed or not on PATH")
    proc = subprocess.run([executable, "--version"], capture_output=True, text=True, timeout=30)
    output = (proc.stdout + proc.stderr).strip()
    if proc.returncode != 0 or not output:
        raise RuntimeError(f"could not pin Claude CLI version (exit {proc.returncode}): {output}")
    return output


def _failed_entry(case_name: str, repeat: int, work: Path, error: BaseException) -> dict:
    run_dir = work / "artifact"
    run_dir.mkdir(parents=True, exist_ok=True)
    message = f"{type(error).__name__}: {error}"
    (run_dir / "error.txt").write_text(message + "\n", encoding="utf-8")
    (run_dir / "stderr.txt").write_text("", encoding="utf-8")
    (run_dir / "trace.jsonl").write_text("", encoding="utf-8")
    (run_dir / "report.md").write_text("", encoding="utf-8")
    return {
        "run_id": f"{case_name}-r{repeat}", "case": case_name, "repeat": repeat,
        "scheduled": True, "status": "runner_error", "error": message,
        "report": "", "runtime_seconds": 0.0, "actual_model_ids": [],
        "tool_count": 0, "tool_counts": {}, "worker_validation_status": "unavailable",
        "write_audit": {"structured_write_paths": [], "outside_scratch_paths": [],
                         "limitations": "The run failed before a trace was available."},
        "input_hash_before": None, "input_hash_after": None,
        "input_integrity_status": "unverifiable_runner_error",
        "normalized_prompt_hash": None, "artifact_dir": str(run_dir),
        "trace_path": str(run_dir / "trace.jsonl"), "report_path": str(run_dir / "report.md"),
        "stderr_path": str(run_dir / "stderr.txt"), "error_path": str(run_dir / "error.txt"),
    }


def _run_one(case_name: str, repeat: int, work: Path, skills_root: Path,
             model: str) -> dict:
    case = CASES[case_name]
    work.mkdir(parents=True, exist_ok=False)
    prompt = resume_review.prompt_for(case, work, skills_root, isolated=True)
    resume_review.workspace(work, skills_root)
    _make_read_only(work / "profile")
    inputs_before = _profile_hashes(work / "profile")
    input_hash_before = _digest_manifest(inputs_before)
    prompt_hash = _normal_prompt_hash(prompt, work, skills_root)
    start = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat()
    run, stdout = resume_review.run_case(case, work, model, skills_root, True, prepared_prompt=prompt)
    duration = time.monotonic() - start
    completed_at = datetime.now(timezone.utc).isoformat()
    inputs_after = _profile_hashes(work / "profile")
    input_hash_after = _digest_manifest(inputs_after)
    input_changed = inputs_before != inputs_after
    events = _events(stdout)
    diagnostics = _tool_diagnostics(events, work)
    actual_models = _model_metadata(events)
    report = run.report.text
    run_dir = work / "artifact"
    run_dir.mkdir()
    (run_dir / "trace.jsonl").write_text(stdout, encoding="utf-8")
    (run_dir / "stderr.txt").write_text(run.stderr, encoding="utf-8")
    (run_dir / "report.md").write_text(report, encoding="utf-8")
    error_text = run.error
    if input_changed:
        error_text = (error_text + "; " if error_text else "") + "profile/CV/posting/source inputs changed during the run"
    if error_text:
        (run_dir / "error.txt").write_text(error_text + "\n", encoding="utf-8")
    status = ("input_changed" if input_changed else
              ("cli_error" if run.error else ("missing_report" if not report.strip() else "complete")))
    return {
        "run_id": f"{case_name}-r{repeat}",
        "case": case_name,
        "repeat": repeat,
        "scheduled": True,
        "status": status,
        "error": error_text,
        "report": report,
        "commands": run.commands,
        "requested_model": model,
        "actual_model_ids": actual_models,
        "returncode": run.returncode,
        "runtime_seconds": round(duration, 3),
        "started_at": started_at,
        "completed_at": completed_at,
        "tool_count": diagnostics["total"],
        "tool_counts": diagnostics["counts"],
        "write_audit": diagnostics["write_audit"],
        "worker_validation_status": diagnostics["worker_validation_status"],
        "worker_validation_permission_error": diagnostics["worker_validation_permission_error"],
        "prompt_sha256": _sha_bytes(prompt.encode("utf-8")),
        "normalized_prompt_sha256": prompt_hash,
        "input_file_hashes_before": inputs_before,
        "input_file_hashes_after": inputs_after,
        "input_hash_before": input_hash_before,
        "input_hash_after": input_hash_after,
        "input_changed": input_changed,
        "input_integrity_status": "changed" if input_changed else "unchanged",
        "artifact_dir": str(run_dir),
        "trace_path": str(run_dir / "trace.jsonl"),
        "report_path": str(run_dir / "report.md"),
        "stderr_path": str(run_dir / "stderr.txt"),
        "error_path": str(run_dir / "error.txt") if error_text else None,
    }


def run_phase(phase: str, skills_root: Path, model: str, output: Path, repeats: int) -> dict:
    """Run all four frozen cases at fixed concurrency and persist each completion immediately."""
    if phase not in PHASES:
        raise ValueError(f"unknown phase {phase!r}; choose before, after, or control")
    if not isinstance(repeats, int) or repeats <= 0:
        raise ValueError("repeats must be a positive integer")
    if not isinstance(model, str) or not model.strip() or any(ch.isspace() for ch in model):
        raise ValueError("model must be a non-empty full model ID without whitespace")
    output = Path(output).absolute()
    if output.exists():
        raise FileExistsError(f"output directory already exists: {output}")
    skills_source = Path(skills_root).resolve(strict=True)
    for name in {case.skill for case in CASES.values()}:
        if not (skills_source / name / "SKILL.md").is_file():
            raise FileNotFoundError(f"skills root is missing {name}/SKILL.md: {skills_source}")
    source_hash_before, source_file_count = _source_tree_hash(skills_source)
    cli_version = _cli_version()
    frozen_digest = benchmark_digest()
    output.mkdir(parents=True)
    try:
        snapshot_metadata = snapshot_skills(skills_source, output / "skills")
        source_hash_after_snapshot, _ = _source_tree_hash(skills_source)
        if source_hash_before != source_hash_after_snapshot or source_hash_before != snapshot_metadata["hash"]:
            raise RuntimeError("skills source changed while the phase snapshot was being captured")
    except Exception:
        _remove_tree(output)
        raise
    frozen_skills_root = output / "skills"
    skills_hash_before = snapshot_metadata["hash"]
    skill_file_count = snapshot_metadata["file_count"]
    (output / "runs").mkdir()
    (output / "work").mkdir()
    expected = [{"case": name, "repeat": index} for name in CASE_NAMES for index in range(1, repeats + 1)]
    metadata = {
        "phase": phase,
        "benchmark_version": BENCHMARK_VERSION,
        "model": model,
        "actual_model": None,
        "actual_model_ids": [],
        "benchmark_hash": frozen_digest,
        "cli_version": cli_version,
        "skills_hash": skills_hash_before,
        "skills_file_count": skill_file_count,
        "skills_root": str(frozen_skills_root),
        "skills_source": str(skills_source),
        "skills_source_hash": source_hash_before,
        "skills_source_file_count": source_file_count,
        "skills_repo_ref": _repo_ref(skills_source),
        "snapshot_metadata": snapshot_metadata,
        "repeats": repeats,
        "scheduled_run_count": len(expected),
        "configuration": _benchmark_configuration(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "running",
    }
    results = {"phase": phase, "benchmark_version": BENCHMARK_VERSION,
               "model": model, "benchmark_hash": frozen_digest,
               "cli_version": cli_version, "configuration": metadata["configuration"],
               "skills_root": str(frozen_skills_root), "skills_hash": skills_hash_before,
               "repeats": repeats, "expected_runs": expected, "runs": []}
    _atomic_json(output / "metadata.json", metadata)
    _atomic_json(output / "results.json", results)

    scheduled = []
    for item in expected:
        work = output / "work" / item["case"] / f"repeat-{item['repeat']:02d}"
        scheduled.append((item, work))
    completed: List[dict] = []
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=MAX_CONCURRENCY)
    futures = {}
    try:
        for item, work in scheduled:
            futures[pool.submit(_run_one, item["case"], item["repeat"], work,
                                frozen_skills_root, model)] = (item, work)
        for future in concurrent.futures.as_completed(futures):
            item, work = futures[future]
            try:
                entry = future.result()
            except BaseException as error:
                entry = _failed_entry(item["case"], item["repeat"], work, error)
            completed.append(entry)
            completed.sort(key=lambda row: (CASE_NAMES.index(row["case"]), row["repeat"]))
            results["runs"] = completed
            _atomic_json(output / "results.json", results)
            print(f"[{phase}] {len(completed)}/{len(expected)} {entry['case']} r{entry['repeat']}: {entry['status']}",
                  flush=True)
    except KeyboardInterrupt:
        # Running workers may finish, but must not start any queued work or
        # overwrite the persisted interrupted state.
        pool.shutdown(wait=False, cancel_futures=True)
        metadata.update({"status": "interrupted", "finished_at": datetime.now(timezone.utc).isoformat(),
                         "completed_run_count": len(completed),
                         "cancelled_run_count": sum(future.cancelled() for future in futures),
                         "unrecorded_run_count": len(expected) - len(completed)})
        results.update({"status": "interrupted", "runs": completed})
        _atomic_json(output / "results.json", results)
        _atomic_json(output / "metadata.json", metadata)
        raise
    except BaseException:
        pool.shutdown(wait=True, cancel_futures=True)
        raise
    else:
        pool.shutdown(wait=True)
    skills_hash_after, _ = _tree_hash(frozen_skills_root)
    all_actual = sorted({model_id for run in completed for model_id in run.get("actual_model_ids", [])})
    metadata.update({
        "actual_model_ids": all_actual,
        "actual_model": all_actual[0] if len(all_actual) == 1 else None,
        "skills_hash_after": skills_hash_after,
        "skills_mutated_during_phase": skills_hash_before != skills_hash_after,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "status": "complete" if all(row["status"] == "complete" for row in completed) else "completed_with_failures",
        "completed_run_count": len(completed),
        "failed_run_count": sum(row["status"] != "complete" for row in completed),
    })
    results.update({"actual_model": metadata["actual_model"], "actual_model_ids": all_actual,
                    "skills_root": str(frozen_skills_root), "skills_hash": skills_hash_before,
                    "skills_hash_after": skills_hash_after,
                    "skills_mutated_during_phase": skills_hash_before != skills_hash_after,
                    "status": metadata["status"]})
    _atomic_json(output / "metadata.json", metadata)
    _atomic_json(output / "results.json", results)
    return results


def _load_results(directory: Path) -> dict:
    path = Path(directory) / "results.json"
    if not path.is_file():
        raise FileNotFoundError(f"missing phase results: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"invalid results file: {path}")
    return value


def _check_input_consistency(by_case_phase: Mapping[str, Mapping[str, Sequence[dict]]]) -> dict:
    consistency = {}
    for case_name in CASE_NAMES:
        items = [item for phase in ("before", "after", "control")
                 for item in by_case_phase[case_name][phase]]
        prompt_hashes = set()
        input_hashes = set()
        unverifiable = []
        mutated = []
        for item in items:
            prompt_hash = item.get("normalized_prompt_sha256")
            manifest = item.get("input_file_hashes_before")
            if not prompt_hash or not isinstance(manifest, Mapping):
                unverifiable.append(f"{item['phase']}:{item['run_id']}")
                continue
            prompt_hashes.add(prompt_hash)
            input_hashes.add(_digest_manifest(manifest))
            before_manifest = item.get("input_file_hashes_before")
            after_manifest = item.get("input_file_hashes_after")
            changed = bool(item.get("input_changed")) or (
                isinstance(after_manifest, Mapping) and dict(before_manifest) != dict(after_manifest)
            )
            if changed:
                mutated.append(f"{item['phase']}:{item['run_id']}")
            elif not isinstance(after_manifest, Mapping):
                unverifiable.append(f"{item['phase']}:{item['run_id']}:after_hash_missing")
        if len(prompt_hashes) > 1:
            raise ValueError(f"normalized prompt mismatch for {case_name} across runs/phases")
        if len(input_hashes) > 1:
            raise ValueError(f"prepared input file hash mismatch for {case_name} across runs/phases")
        status = "verified"
        if mutated:
            status = "input_mutated"
        if unverifiable:
            status = "partially_unverifiable" if prompt_hashes or input_hashes else "unverifiable"
        consistency[case_name] = {
            "status": status,
            "normalized_prompt_sha256": next(iter(prompt_hashes)) if len(prompt_hashes) == 1 else None,
            "input_manifest_sha256": next(iter(input_hashes)) if len(input_hashes) == 1 else None,
            "scheduled_run_count": len(items),
            "unverifiable_runs": unverifiable,
            "input_mutation_runs": mutated,
        }
    return consistency


def _validate_phase_bundle(before: dict, after: dict, control: dict) -> dict:
    phases = {"before": before, "after": after, "control": control}
    for phase, data in phases.items():
        if data.get("phase") and data["phase"] != phase:
            raise ValueError(f"phase mismatch: expected {phase}, got {data['phase']}")
    # Compare requested IDs first so a mismatch is rejected before any judge process can start.
    model_ids = {phase: data.get("model") for phase, data in phases.items()}
    if len(set(model_ids.values())) != 1:
        raise ValueError(f"model mismatch across phases: {model_ids}")
    for key in ("benchmark_hash", "cli_version"):
        values = {phase: data.get(key) for phase, data in phases.items()}
        if len(set(values.values())) != 1:
            raise ValueError(f"{key.replace('_', ' ')} mismatch across phases: {values}")
    versions = {phase: data.get("benchmark_version", 1) for phase, data in phases.items()}
    if len(set(versions.values())) != 1:
        raise ValueError(f"benchmark version mismatch across phases: {versions}")
    if before.get("benchmark_hash") != benchmark_digest():
        raise ValueError("saved benchmark hash does not match current assessor inputs")
    configurations = {phase: data.get("configuration") for phase, data in phases.items()}
    present_configurations = [value for value in configurations.values() if value is not None]
    if present_configurations and len(present_configurations) != len(phases):
        raise ValueError("runner configuration metadata is missing from one or more phases")
    configurations = {phase: value for phase, value in configurations.items() if value is not None}
    if configurations and len({_sha_bytes(_json_bytes(value)) for value in configurations.values()}) != 1:
        raise ValueError("runner configuration mismatch across phases")
    repeat_counts = {}
    for phase, data in phases.items():
        count = data.get("repeats")
        if count is None and data.get("expected_runs"):
            by_case = {}
            for item in data["expected_runs"]:
                by_case[item["case"]] = by_case.get(item["case"], 0) + 1
            distinct = set(by_case.values())
            count = next(iter(distinct)) if len(distinct) == 1 else None
        repeat_counts[phase] = count
    if (repeat_counts["before"] is not None and repeat_counts["after"] is not None
            and repeat_counts["before"] != repeat_counts["after"]):
        raise ValueError(f"before/after repeat count mismatch: {repeat_counts}")
    actual_ids = {phase: data.get("actual_model_ids") or
                  ([data["actual_model"]] if data.get("actual_model") else [])
                  for phase, data in phases.items()}
    available = {phase: sorted(set(item for item in ids if item)) for phase, ids in actual_ids.items()}
    if any(not values for values in available.values()):
        raise ValueError(f"actual full model metadata is unavailable; refusing to judge: {available}")
    if any(len(values) != 1 for values in available.values()) or len({values[0] for values in available.values()}) != 1:
        raise ValueError(f"actual model mismatch across phases: {available}")
    if available["before"][0] != model_ids["before"]:
        raise ValueError(f"actual full model ID differs from requested model: {model_ids['before']} vs {available['before'][0]}")
    before_hash, control_hash = before.get("skills_hash"), control.get("skills_hash")
    if before_hash and control_hash and before_hash != control_hash:
        raise ValueError("before/control skill snapshot mismatch")
    for phase, data in phases.items():
        if data.get("skills_mutated_during_phase") or (
                data.get("skills_hash") and data.get("skills_hash_after")
                and data["skills_hash"] != data["skills_hash_after"]):
            raise ValueError(f"{phase} skill snapshot changed during its phase")
        if data.get("skills_root") and data.get("skills_hash_after"):
            current_hash, _ = _tree_hash(Path(data["skills_root"]))
            if current_hash != data["skills_hash_after"]:
                raise ValueError(f"{phase} frozen skill snapshot content changed after the phase")
    return {
        "requested_model": model_ids["before"],
        "actual_model": available["before"][0],
        "benchmark_hash": before["benchmark_hash"],
        "benchmark_version": before.get("benchmark_version", 1),
        "cli_version": before["cli_version"],
        "configuration": before.get("configuration"),
        "repeat_counts": repeat_counts,
        "control_matches_before_snapshot": bool(before_hash and before_hash == control_hash),
    }


def _parse_json_result(stdout: str) -> Tuple[Optional[dict], List[str], str]:
    try:
        outer = json.loads(stdout.strip())
    except json.JSONDecodeError as error:
        return None, [], f"assessor output is not JSON: {error}"
    outer_models: Set[str] = set()
    if isinstance(outer, Mapping):
        for key in ("model", "model_id", "modelId", "model_name"):
            if isinstance(outer.get(key), str) and outer[key].strip():
                outer_models.add(outer[key].strip())
        usage = outer.get("modelUsage")
        if isinstance(usage, Mapping):
            outer_models.update(str(key) for key in usage if str(key).strip())
        result = outer.get("result", outer)
    else:
        result = outer
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError as error:
            return None, sorted(outer_models), f"assessor result field is not JSON: {error}"
    if not isinstance(result, dict):
        return None, sorted(outer_models), "assessor JSON result is not an object"
    return result, sorted(outer_models), ""


def _validate_assessment(value: dict, report_texts: Mapping[str, str], gold: Mapping[str, object]) -> Tuple[Optional[dict], str]:
    rows = value.get("reports")
    if not isinstance(rows, list):
        return None, "assessor result has no reports array"
    by_id = {}
    for row in rows:
        if not isinstance(row, Mapping) or not isinstance(row.get("id"), str):
            return None, "assessor result contains a malformed report entry"
        if row["id"] in by_id:
            return None, f"assessor duplicated report ID {row['id']}"
        by_id[row["id"]] = row
    if set(by_id) != set(report_texts):
        return None, f"assessor report IDs differ: expected {sorted(report_texts)}, got {sorted(by_id)}"

    normalized = {}
    required_action_ids = set(gold.get("actions", {}))
    for report_id, row in by_id.items():
        report_text = report_texts[report_id]
        claims = row.get("claims")
        if not isinstance(claims, Mapping):
            return None, f"assessor omitted claims for {report_id}"

        def validate_citations(items: object, label: str, allow_empty: bool = False) -> Tuple[Optional[list], str]:
            if not isinstance(items, list):
                return None, f"{report_id} {label} must be a list"
            checked = []
            for item in items:
                if not isinstance(item, Mapping):
                    return None, f"{report_id} {label} contains a malformed claim"
                excerpt, reason = item.get("excerpt"), item.get("reason")
                if not isinstance(excerpt, str) or not isinstance(reason, str) or not reason.strip():
                    return None, f"{report_id} {label} must include an excerpt and reason"
                if excerpt.strip():
                    if excerpt not in report_text:
                        return None, f"{report_id} {label} excerpt is not an exact substring of its report"
                elif not allow_empty:
                    return None, f"{report_id} {label} claim needs a non-empty report excerpt"
                checked.append(dict(item))
            return checked, ""

        links, error = validate_citations(claims.get("links", []), "links")
        if error:
            return None, error
        strongest, error = validate_citations(claims.get("strongest", []), "strongest")
        if error:
            return None, error
        pdf, error = validate_citations(claims.get("pdf", []), "pdf")
        if error:
            return None, error
        actions = claims.get("actions")
        if not isinstance(actions, Mapping) or set(actions) != required_action_ids:
            return None, f"{report_id} action requirement IDs differ from gold"
        action_claims = {}
        for requirement, item in actions.items():
            if not isinstance(item, Mapping):
                return None, f"{report_id} action {requirement} is malformed"
            excerpt, reason = item.get("excerpt"), item.get("reason")
            if not isinstance(excerpt, str) or not isinstance(reason, str) or not reason.strip():
                return None, f"{report_id} action {requirement} must include excerpt and reason"
            has_quote = bool(excerpt.strip())
            if has_quote and excerpt not in report_text:
                return None, f"{report_id} action {requirement} excerpt is not an exact substring of its report"
            target_actions = gold.get("actions", {}).get(requirement, {}).get("actions", [])
            action_claims[requirement] = {
                "support": _canonical_support(item.get("support")) if has_quote else None,
                "action": _canonical_action(item.get("action"), target_actions) if has_quote else None,
                "excerpt": excerpt, "reason": reason,
            }
        violations = {}
        for key in ("ownership_violation", "private_credit_violation"):
            item = claims.get(key)
            if not isinstance(item, Mapping) or not isinstance(item.get("value"), bool):
                return None, f"{report_id} {key} is malformed"
            excerpt, reason = item.get("excerpt"), item.get("reason")
            if not isinstance(excerpt, str) or not isinstance(reason, str) or not reason.strip():
                return None, f"{report_id} {key} must include excerpt and reason"
            if excerpt.strip() and excerpt not in report_text:
                return None, f"{report_id} {key} excerpt is not an exact substring of its report"
            if item["value"] and not excerpt.strip():
                return None, f"{report_id} {key} violation needs an exact report excerpt"
            violations[key] = item["value"]

        normalized[report_id] = {
            "links": [{"requirement": item.get("requirement"), "source": item.get("source")}
                      for item in links],
            "actions": action_claims,
            "strongest": [item.get("source") for item in strongest if item.get("source")],
            "pdf": [item.get("label") for item in pdf if item.get("label")],
            "ownership_violation": violations["ownership_violation"],
            "private_credit_violation": violations["private_credit_violation"],
            "explanations": {"links": links, "actions": action_claims,
                             "strongest": strongest, "pdf": pdf,
                             "ownership_violation": claims.get("ownership_violation"),
                             "private_credit_violation": claims.get("private_credit_violation")},
        }
    return normalized, ""


def _assess_case(case_name: str, items: Sequence[dict], model: str, actual_model: str,
                 output: Path) -> dict:
    assessment_dir = output / "assessments" / case_name
    assessment_dir.mkdir(parents=True, exist_ok=True)
    anonymous = []
    source_by_id = {}
    normalizations = {}
    text_by_id = {}
    for item in items:
        raw_report = str(item.get("report", ""))
        if not raw_report.strip():
            continue
        report_id = "RPT-" + uuid.uuid4().hex[:12]
        report_text = raw_report
        replacements = []
        artifact_dir = item.get("artifact_dir")
        if artifact_dir:
            try:
                phase_root = Path(artifact_dir).parents[3]
                prefixes = (
                    (phase_root / "work", "<WORK_ROOT>"),
                    (phase_root / "skills", "<SKILLS_ROOT>"),
                    (phase_root, "<PHASE_OUTPUT>"),
                )
                for prefix, placeholder in prefixes:
                    if str(prefix) in report_text:
                        report_text = report_text.replace(str(prefix), placeholder)
                        replacements.append({"prefix": str(prefix), "placeholder": placeholder})
            except IndexError:
                pass
        anonymous.append({"id": report_id, "report": report_text})
        source_by_id[report_id] = {"phase": item["phase"], "run_id": item["run_id"],
                                   "repeat": item.get("repeat"),
                                   "worker_validation_status": item.get("worker_validation_status")}
        normalizations[report_id] = {
            "replacements": replacements,
            "raw_report_sha256": _sha_bytes(raw_report.encode("utf-8")),
            "assessor_report_sha256": _sha_bytes(report_text.encode("utf-8")),
        }
        text_by_id[report_id] = report_text
    if not anonymous:
        result = {
            "case": case_name,
            "status": "valid",
            "judging": "skipped_no_report_text",
            "error": None,
            "requested_model": model,
            "actual_model_ids": [],
            "runtime_seconds": 0.0,
            "returncode": None,
            "source_by_anonymous_id": {},
            "report_normalizations": {},
            "claims_by_anonymous_id": {},
            "raw_stdout_path": None,
            "raw_stderr_path": None,
            "prompt_path": None,
        }
        _atomic_json(assessment_dir / "assessment.json", result)
        return result
    random.SystemRandom().shuffle(anonymous)
    payload = {
        "case_name": case_name,
        "case_rubric": CASE_RUBRICS[case_name],
        "gold": GOLD[case_name],
        "raw_case_materials": _case_materials(case_name),
        "reports": anonymous,
    }
    prompt = JUDGE_INSTRUCTIONS + "\n\nBenchmark case data and blinded reports:\n" + json.dumps(
        payload, ensure_ascii=False, indent=2, sort_keys=True)
    (assessment_dir / "prompt.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                                                encoding="utf-8")
    scratch = assessment_dir / "tmp"
    scratch.mkdir(exist_ok=True)
    start = time.monotonic()
    error = None
    stdout = stderr = ""
    returncode = None
    try:
        proc = subprocess.run(
            [shutil.which("claude") or "claude", "-p", "--output-format", "json",
             "--model", model, "--safe-mode", "--no-session-persistence", "--tools", ""],
            input=prompt, cwd=assessment_dir, capture_output=True, text=True, timeout=resume_review.TIMEOUT,
            env={**os.environ, "TMPDIR": str(scratch), "PYTHONDONTWRITEBYTECODE": "1"},
        )
        stdout, stderr, returncode = proc.stdout, proc.stderr, proc.returncode
        if returncode != 0:
            error = f"assessor CLI exited with status {returncode}"
    except subprocess.TimeoutExpired as timeout_error:
        stdout = timeout_error.stdout.decode("utf-8", "replace") if isinstance(timeout_error.stdout, bytes) else (timeout_error.stdout or "")
        stderr = timeout_error.stderr.decode("utf-8", "replace") if isinstance(timeout_error.stderr, bytes) else (timeout_error.stderr or "")
        error = f"assessor timed out after {resume_review.TIMEOUT} seconds"
    except OSError as os_error:
        error = f"assessor could not start: {os_error}"
    duration = time.monotonic() - start
    (assessment_dir / "stdout.json").write_text(stdout, encoding="utf-8")
    (assessment_dir / "stderr.txt").write_text(stderr, encoding="utf-8")
    if error:
        (assessment_dir / "error.txt").write_text(error + "\n", encoding="utf-8")
    parsed, judge_models, parse_error = _parse_json_result(stdout) if stdout else (None, [], "assessor returned no output")
    if not error and parse_error:
        error = parse_error
    if not error and judge_models and (len(judge_models) != 1 or judge_models[0] != actual_model):
        error = f"assessor model metadata mismatch: expected {actual_model}, got {judge_models}"
    if not error and not judge_models:
        error = "assessor actual model metadata is unavailable"
    normalized = None
    if not error and parsed is not None:
        normalized, validation_error = _validate_assessment(parsed, text_by_id, GOLD[case_name])
        if validation_error:
            error = "invalid assessor result: " + validation_error
    result = {
        "case": case_name,
        "status": "valid" if normalized is not None and error is None else "unavailable",
        "judging": "assessed_reports",
        "error": error,
        "requested_model": model,
        "actual_model_ids": judge_models,
        "runtime_seconds": round(duration, 3),
        "returncode": returncode,
        "source_by_anonymous_id": source_by_id,
        "report_normalizations": normalizations,
        "claims_by_anonymous_id": normalized,
        "raw_stdout_path": str(assessment_dir / "stdout.json"),
        "raw_stderr_path": str(assessment_dir / "stderr.txt"),
        "prompt_path": str(assessment_dir / "prompt.json"),
    }
    _atomic_json(assessment_dir / "assessment.json", result)
    return result


METRICS = (
    "link_precision", "requirement_coverage", "gap_actions", "strongest_proof",
    "pdf_diagnosis", "ownership_violation", "private_credit_violation",
)
LOWER_IS_BETTER = {"ownership_violation", "private_credit_violation"}


def _ratio(pair: Optional[Sequence[int]]) -> Optional[float]:
    if pair is None or len(pair) != 2 or not pair[1]:
        return None
    return pair[0] / pair[1]


def _format_metric(pair: Optional[Sequence[int]]) -> str:
    if pair is None:
        return "unavailable"
    numerator, denominator = pair
    rate = (numerator / denominator) if denominator else None
    return f"{numerator}/{denominator}" + (f" ({rate:.2f})" if rate is not None else " (n/a)")


def _median(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def _runtime_tool_summary(items: Sequence[Mapping[str, object]]) -> dict:
    measured = [item for item in items if item.get("status") not in {"runner_error", "missing_record"}]
    runtimes = [float(item.get("runtime_seconds", 0.0)) for item in measured]
    tools = [int(item.get("tool_count", 0)) for item in measured]
    return {
        "scheduled_runs": len(items),
        "runtime_seconds": {"median": _median(runtimes), "min": min(runtimes) if runtimes else None,
                             "max": max(runtimes) if runtimes else None},
        "tool_count": {"median": _median(tools), "min": min(tools) if tools else None,
                       "max": max(tools) if tools else None},
    }


def _required_successes(assertion: str, scheduled: int) -> int:
    if assertion in {"ownership_safe", "private_credit_safe"}:
        return scheduled
    return (2 * scheduled + 2) // 3


def _assertion_results(case_name: str, claims: Mapping[str, object]) -> Dict[str, bool]:
    gold = GOLD[case_name]
    actual_links = {
        (str(item.get("requirement", "")), str(item.get("source", "")))
        for item in claims.get("links", []) or [] if isinstance(item, Mapping)
    }
    actual_actions = claims.get("actions", {}) or {}
    results = {}
    for requirement, sources in gold.get("supported", {}).items():
        results[f"link:{requirement}"] = any((requirement, source) in actual_links for source in sources)
    for requirement, target in gold.get("actions", {}).items():
        actual = actual_actions.get(requirement, {}) if isinstance(actual_actions, Mapping) else {}
        if isinstance(actual, Mapping):
            action = actual.get("action")
            allowed = target.get("actions", [])
            if isinstance(action, list):
                action_ok = any(_canonical_action(value, allowed) in allowed for value in action)
            else:
                action_ok = _canonical_action(action, allowed) in allowed
            results[f"action:{requirement}"] = (
                _canonical_support(actual.get("support")) == target.get("support") and action_ok
                and bool(str(actual.get("excerpt", "")).strip())
            )
        else:
            results[f"action:{requirement}"] = False
    if gold.get("strongest"):
        strongest = claims.get("strongest", []) or []
        if isinstance(strongest, str):
            strongest = [strongest]
        results["strongest_membership"] = bool(set(str(value) for value in strongest) & set(gold["strongest"]))
    for label in gold.get("pdf", []):
        pdf = claims.get("pdf", []) or []
        if isinstance(pdf, str):
            pdf = [pdf]
        results[f"pdf:{label}"] = label in set(str(value) for value in pdf)
    if case_name == "pdf_with_source":
        pdf = claims.get("pdf", []) or []
        if isinstance(pdf, str):
            pdf = [pdf]
        results["pdf:no_automatic_source_mismatch_cap"] = "automatic_source_mismatch_cap" not in set(
            str(value) for value in pdf)
    if case_name in {"ownership_inflation", "strongest_proof_gaps"}:
        results["ownership_safe"] = not bool(claims.get("ownership_violation"))
    if case_name == "strongest_proof_gaps":
        results["private_credit_safe"] = not bool(claims.get("private_credit_violation"))
    return results


def _aggregate_case_scores(case_name: str, items: Sequence[dict], claims_by_run: Mapping[Tuple[str, str], dict]) -> dict:
    totals = {metric: [0, 0] for metric in METRICS}
    assertion_keys = _assertion_results(case_name, {})
    assertions: Dict[str, List[int]] = {key: [0, 0] for key in assertion_keys}
    for item in items:
        complete = item.get("status") == "complete"
        assessed = claims_by_run.get((item["phase"], item["run_id"]))
        claims = assessed if complete else None
        scores = score_claims(GOLD[case_name], claims or {})
        # Safety rates describe assessed reports, including reports from failed
        # runs. Missing assessments cannot establish that a report was safe.
        for metric in LOWER_IS_BETTER:
            scores[metric] = ([int(bool(assessed[metric])), 1]
                              if assessed is not None and metric in assessed else [0, 0])
        for metric, pair in scores.items():
            totals[metric][0] += pair[0]
            totals[metric][1] += pair[1]
        assertion_row = _assertion_results(case_name, claims or {}) if complete else {}
        for assertion, count in assertions.items():
            count[1] += 1
            if complete and assertion_row.get(assertion, False):
                count[0] += 1
    return {"metrics": totals, "assertions": assertions, "scheduled_runs": len(items),
            "completed_runs": sum(1 for item in items if item.get("status") == "complete"),
            "failed_runs": sum(1 for item in items if item.get("status") != "complete")}


def compare(before: Path, after: Path, control: Path, output: Path) -> dict:
    """Blindly judge and compare three compatible phase bundles, retaining all scheduled runs."""
    phase_results = {
        "before": _load_results(Path(before)),
        "after": _load_results(Path(after)),
        "control": _load_results(Path(control)),
    }
    compatibility = _validate_phase_bundle(phase_results["before"], phase_results["after"],
                                           phase_results["control"])
    output = Path(output).absolute()
    if output.exists():
        raise FileExistsError(f"comparison output already exists: {output}")
    by_case_phase = {name: {phase: [] for phase in ("before", "after", "control")} for name in CASE_NAMES}
    for phase, data in phase_results.items():
        present = {}
        for run in data.get("runs", []):
            if run.get("case") not in CASE_NAMES:
                continue
            wrapped = dict(run, phase=phase)
            by_case_phase[run["case"]][phase].append(wrapped)
            present[(run["case"], run.get("repeat"))] = True
        for expected in data.get("expected_runs", []):
            case_name, repeat = expected.get("case"), expected.get("repeat")
            if case_name in CASE_NAMES and not present.get((case_name, repeat)):
                by_case_phase[case_name][phase].append({
                    "phase": phase, "case": case_name, "repeat": repeat,
                    "run_id": f"{case_name}-r{repeat}", "status": "missing_record",
                    "scheduled": True, "report": "", "runtime_seconds": 0.0,
                    "tool_count": 0, "worker_validation_status": "unavailable",
                    "error": "scheduled run is absent from the phase results file",
                })
        for case_name in CASE_NAMES:
            by_case_phase[case_name][phase].sort(key=lambda item: item.get("repeat", 0))
    input_consistency = _check_input_consistency(by_case_phase)
    output.mkdir(parents=True)
    (output / "assessments").mkdir()
    assessments = {}
    score_output = {}
    drift_notes = []
    judge_failures = []
    for case_name in CASE_NAMES:
        items = [item for phase in ("before", "after", "control")
                 for item in by_case_phase[case_name][phase]]
        assessment = _assess_case(case_name, items, compatibility["requested_model"],
                                  compatibility["actual_model"], output)
        assessments[case_name] = assessment
        if assessment["status"] != "valid":
            judge_failures.append({"case": case_name, "error": assessment["error"]})
            continue
        claims_by_run = {}
        for anonymous_id, source in assessment["source_by_anonymous_id"].items():
            claims_by_run[(source["phase"], source["run_id"])] = assessment["claims_by_anonymous_id"][anonymous_id]
        scores_for_case = {}
        for phase in ("before", "after", "control"):
            scores_for_case[phase] = _aggregate_case_scores(
                case_name, by_case_phase[case_name][phase], claims_by_run)
        score_output[case_name] = scores_for_case
        any_validation_block = any(
            item.get("worker_validation_status") == "permission_denied"
            for item in items
        )
        if any_validation_block:
            drift_notes.append({"case": case_name,
                                "note": "Validation was blocked by tool permissions in at least one scheduled run; case metrics are diagnostic only and the case is marked inconclusive."})
            scores_for_case["permission_limited"] = True
            continue
        if input_consistency[case_name]["status"] != "verified":
            drift_notes.append({"case": case_name,
                                "note": f"input integrity is {input_consistency[case_name]['status']}; this case is marked inconclusive and excluded from pooled metrics/gates."})
            scores_for_case["input_unverified"] = True
            continue
        for metric in METRICS:
            before_rate = _ratio(scores_for_case["before"]["metrics"][metric])
            after_rate = _ratio(scores_for_case["after"]["metrics"][metric])
            control_rate = _ratio(scores_for_case["control"]["metrics"][metric])
            if before_rate is None or after_rate is None or control_rate is None:
                continue
            gain = before_rate - after_rate if metric in LOWER_IS_BETTER else after_rate - before_rate
            old_control_drift = control_rate - before_rate
            if gain > 0 and abs(old_control_drift) >= abs(gain):
                drift_notes.append({"case": case_name, "metric": metric,
                                    "note": "inconclusive: the before/control drift is at least as large as the observed after/before change"})

    pooled_metrics = {}
    for phase in ("before", "after", "control"):
        pooled = {metric: [0, 0] for metric in METRICS}
        included_cases = []
        for case_name, per_phase in score_output.items():
            if per_phase.get("permission_limited") or per_phase.get("input_unverified"):
                continue
            included_cases.append(case_name)
            for metric, pair in per_phase[phase]["metrics"].items():
                pooled[metric][0] += pair[0]
                pooled[metric][1] += pair[1]
        pooled_metrics[phase] = {"metrics": pooled, "included_cases": included_cases}

    timing_tool_summary = {
        case_name: {phase: _runtime_tool_summary(by_case_phase[case_name][phase])
                    for phase in ("before", "after", "control")}
        for case_name in CASE_NAMES
    }
    after_assertion_gates = {}
    for case_name, per_phase in score_output.items():
        assertions = per_phase["after"].get("assertions", {})
        gates = {}
        permission_limited = bool(per_phase.get("permission_limited") or per_phase.get("input_unverified"))
        for assertion, pair in assertions.items():
            numerator, denominator = pair
            required = _required_successes(assertion, denominator) if denominator else 0
            gates[assertion] = {"successes": numerator, "scheduled_runs": denominator,
                                "required_for_two_thirds": required,
                                "passes": None if permission_limited else bool(denominator and numerator >= required)}
        after_assertion_gates[case_name] = gates

    result = {
        "comparison_created_at": datetime.now(timezone.utc).isoformat(),
        "compatibility": compatibility,
        "phase_run_counts": {phase: len(data.get("expected_runs", data.get("runs", [])))
                             for phase, data in phase_results.items()},
        "phase_completed_counts": {phase: len(data.get("runs", [])) for phase, data in phase_results.items()},
        "assessments": assessments,
        "scores": score_output,
        "input_consistency": input_consistency,
        "pooled_metrics": pooled_metrics,
        "runtime_tool_summary": timing_tool_summary,
        "after_assertion_gates": after_assertion_gates,
        "inconclusive_notes": drift_notes,
        "judge_failures": judge_failures,
        "metric_definitions": {
            "link_precision": "unique correct requirement/source pairs / unique predicted pairs; [0,0] when none were reported",
            "requirement_coverage": "gold supported requirements with a correct linked source / gold supported requirements",
            "gap_actions": "gold requirements with the expected support label and one accepted action / gold action requirements",
            "strongest_proof": "at least one accepted strongest source identified / 1; [0,0] when no strongest proof is expected",
            "pdf_diagnosis": "intersection / union of expected and reported PDF diagnoses",
            "ownership_violation": "reports containing a prohibited ownership/fabrication assertion / reports",
            "private_credit_violation": "reports crediting profile-only evidence as recruiter-visible CV alignment / reports",
        },
        "weighted_gain_score": None,
    }
    _atomic_json(output / "results.json", result)
    (output / "comparison.md").write_text(_comparison_markdown(result, by_case_phase), encoding="utf-8")
    return result


def _comparison_markdown(result: Mapping[str, object], by_case_phase: Mapping[str, object]) -> str:
    lines = [
        "# Evidence benchmark comparison",
        "",
        f"Benchmark version: `{result['compatibility'].get('benchmark_version', 1)}`  ",
        f"Requested model: `{result['compatibility']['requested_model']}`  ",
        f"Actual model: `{result['compatibility']['actual_model']}`  ",
        f"Benchmark digest: `{result['compatibility']['benchmark_hash']}`  ",
        f"Claude CLI: `{result['compatibility']['cli_version']}`  ",
        f"Control uses the before snapshot: `{result['compatibility']['control_matches_before_snapshot']}`  ",
        f"Repeats (before / after / control): `{result['compatibility']['repeat_counts']}`; concurrency `{result['compatibility']['configuration']['concurrency']}`",
        "",
        "The assessor received anonymous, shuffled reports in a fresh CLI context for each case. It had tools disabled. Formatting, report scores, headers, and tool counts were excluded from quality scoring. No weighted gain score was computed.",
        "",
        "## Per-case metrics",
        "",
        "| Case | Metric | Before | After | Delta | Control |",
        "| --- | --- | ---: | ---: | ---: | ---: |",
    ]
    scores = result.get("scores", {})
    assessments = result.get("assessments", {})
    for case_name in CASE_NAMES:
        case_scores = scores.get(case_name)
        if not case_scores:
            status = assessments.get(case_name, {}).get("error", "unavailable")
            for metric in METRICS:
                lines.append(f"| {case_name} | {metric} | unavailable | unavailable | unavailable | unavailable |")
            lines.append(f"| {case_name} | judge | unavailable | unavailable | {status} | unavailable |")
            continue
        for metric in METRICS:
            before_pair = case_scores["before"]["metrics"][metric]
            after_pair = case_scores["after"]["metrics"][metric]
            control_pair = case_scores["control"]["metrics"][metric]
            b_rate, a_rate = _ratio(before_pair), _ratio(after_pair)
            delta = "n/a" if b_rate is None or a_rate is None else f"{a_rate - b_rate:+.2f}"
            if metric in LOWER_IS_BETTER and b_rate is not None and a_rate is not None:
                delta = f"{b_rate - a_rate:+.2f} lower is better"
            lines.append(f"| {case_name} | {metric} | {_format_metric(before_pair)} | {_format_metric(after_pair)} | {delta} | {_format_metric(control_pair)} |")
        lines.append(f"| {case_name} | scheduled runs | {case_scores['before']['completed_runs']}/{case_scores['before']['scheduled_runs']} complete | {case_scores['after']['completed_runs']}/{case_scores['after']['scheduled_runs']} complete | — | {case_scores['control']['completed_runs']}/{case_scores['control']['scheduled_runs']} complete |")
        if case_scores.get("permission_limited"):
            lines.append(f"| {case_name} | validation status | permission failure detected; metrics diagnostic only | permission failure detected; metrics diagnostic only | inconclusive | permission failure detected; metrics diagnostic only |")
        if case_scores.get("input_unverified"):
            state = result.get("input_consistency", {}).get(case_name, {}).get("status", "unverified")
            lines.append(f"| {case_name} | input integrity | {state}; metrics diagnostic only | {state}; metrics diagnostic only | inconclusive | {state}; metrics diagnostic only |")
    lines += ["", "## Pooled metrics", "",
              "Pooled counts sum numerators and denominators across cases with a valid blinded assessment and no detected validation permission block.",
              "",
              "| Metric | Before | After | Delta | Control |",
              "| --- | ---: | ---: | ---: | ---: |"]
    pooled = result.get("pooled_metrics", {})
    for metric in METRICS:
        before_pair = pooled.get("before", {}).get("metrics", {}).get(metric, [0, 0])
        after_pair = pooled.get("after", {}).get("metrics", {}).get(metric, [0, 0])
        control_pair = pooled.get("control", {}).get("metrics", {}).get(metric, [0, 0])
        before_rate, after_rate = _ratio(before_pair), _ratio(after_pair)
        delta = "n/a" if before_rate is None or after_rate is None else f"{after_rate - before_rate:+.2f}"
        if metric in LOWER_IS_BETTER and before_rate is not None and after_rate is not None:
            delta = f"{before_rate - after_rate:+.2f} lower is better"
        lines.append(f"| {metric} | {_format_metric(before_pair)} | {_format_metric(after_pair)} | {delta} | {_format_metric(control_pair)} |")
    for phase in ("before", "after", "control"):
        included = pooled.get(phase, {}).get("included_cases", [])
        lines.append(f"| cases included in {phase} pool | {len(included)}/4 | {len(included)}/4 | — | {len(included)}/4 |")
    lines += ["", "## After assertion gates", "",
              "Each behavior assertion requires at least two thirds of scheduled after runs, rounded up. Ownership and private-credit safety require every run to pass. Pooled metrics cannot hide a never-passing assertion.",
              "",
              "| Case | Assertion | After successes | Gate | Result |",
              "| --- | --- | ---: | ---: | --- |"]
    for case_name in CASE_NAMES:
        gates = result.get("after_assertion_gates", {}).get(case_name, {})
        if not gates:
            lines.append(f"| {case_name} | unavailable | unavailable | unavailable | unavailable |")
            continue
        for assertion, item in gates.items():
            passed = "INCONCLUSIVE" if item["passes"] is None else ("PASS" if item["passes"] else "FAIL")
            lines.append(f"| {case_name} | {assertion} | {item['successes']}/{item['scheduled_runs']} | {item['required_for_two_thirds']}/{item['scheduled_runs']} | {passed} |")
    lines += ["", "## Runtime, tool counts, and report excerpts", "",
              "Tool counts are diagnostics only and do not contribute to the quality metrics.",
              "",
              "| Case | Phase | Scheduled | Runtime median (range) | Tool count median (range) |",
              "| --- | --- | ---: | ---: | ---: |"]
    summaries = result.get("runtime_tool_summary", {})
    for case_name in CASE_NAMES:
        for phase in ("before", "after", "control"):
            summary = summaries.get(case_name, {}).get(phase, {})
            runtime = summary.get("runtime_seconds", {})
            tools = summary.get("tool_count", {})
            runtime_range = "n/a" if runtime.get("min") is None else f"{runtime['min']:.1f}–{runtime['max']:.1f}s"
            tool_range = "n/a" if tools.get("min") is None else f"{tools['min']}–{tools['max']}"
            runtime_median = "n/a" if runtime.get("median") is None else f"{runtime['median']:.1f}s"
            tool_median = "n/a" if tools.get("median") is None else f"{tools['median']:.0f}"
            lines.append(f"| {case_name} | {phase} | {summary.get('scheduled_runs', 0)} | {runtime_median} ({runtime_range}) | {tool_median} ({tool_range}) |")
    lines += ["", "### Report excerpts", ""]
    for case_name in CASE_NAMES:
        lines += [f"### {case_name}", ""]
        for phase in ("before", "after", "control"):
            phase_items = by_case_phase[case_name][phase]
            if not phase_items:
                lines.append(f"- **{phase}:** no run record was present.")
                continue
            failed = sum(item.get("status") != "complete" for item in phase_items)
            lines.append(f"- **{phase}:** {len(phase_items)} scheduled, {failed} failed.")
            blocked = [item for item in phase_items if item.get("worker_validation_status") == "permission_denied"]
            if blocked:
                lines.append("  Validation worker permission failure was recorded; this run is not evidence of an algorithmic failure.")
        integrity = result.get("input_consistency", {}).get(case_name, {})
        lines.append(f"- **Input integrity:** {integrity.get('status', 'unavailable')}; "
                     f"{len(integrity.get('unverifiable_runs', []))} run(s) unverifiable, "
                     f"{len(integrity.get('input_mutation_runs', []))} run(s) changed inputs.")
        assessment = assessments.get(case_name, {})
        if assessment.get("status") != "valid":
            lines.append(f"- **Assessor:** unavailable — {assessment.get('error', 'invalid result')}.")
        else:
            lines.append(f"- **Assessor:** valid; runtime {assessment.get('runtime_seconds', 0.0):.1f}s.")
            claims_by_id = assessment.get("claims_by_anonymous_id", {})
            source_map = assessment.get("source_by_anonymous_id", {})
            excerpts_by_phase = {phase: [] for phase in ("before", "after", "control")}
            for anonymous_id, claims in claims_by_id.items():
                phase = source_map[anonymous_id]["phase"]
                explanations = claims.get("explanations", {})
                candidates = []
                for kind in ("links", "actions", "strongest", "pdf"):
                    value = explanations.get(kind)
                    if isinstance(value, Mapping):
                        candidates.extend(value.values())
                    elif isinstance(value, list):
                        candidates.extend(value)
                if not candidates:
                    for kind in ("ownership_violation", "private_credit_violation"):
                        item = explanations.get(kind)
                        if isinstance(item, Mapping) and item.get("excerpt"):
                            candidates.append(item)
                excerpt = next((item for item in candidates if isinstance(item, Mapping) and item.get("excerpt")), None)
                if excerpt:
                    excerpts_by_phase[phase].append((source_map[anonymous_id]["run_id"], excerpt))
            for phase, examples in excerpts_by_phase.items():
                if not examples:
                    lines.append(f"- **{phase} excerpt:** no cited report excerpt was returned.")
                    continue
                run_id, example = examples[0]
                lines.append(f"- **{phase} excerpt ({run_id}):** “{example['excerpt']}” — {example['reason']}")
    lines += ["", "## Inconclusive findings", ""]
    notes = result.get("inconclusive_notes", [])
    if notes:
        for note in notes:
            metric_label = f" / {note['metric']}" if note.get("metric") else ""
            lines.append(f"- **{note.get('case')}**{metric_label}: {note.get('note')}")
    else:
        lines.append("No before/control drift was large enough to match an observed quality-metric gain. This is descriptive, not a statistical significance test.")
    lines += ["", "## Audit limits", "",
              "Structured Write/Edit paths and Bash command text were recorded. Bash can perform transient or indirect writes that command-text auditing cannot fully enumerate; input hashes before and after each run are the integrity check for the profile and CV files. Assessor excerpts were checked against the report copy with phase output, work, and snapshot path prefixes neutralized; raw reports and the exact replacement mapping are preserved in the phase artifacts and comparison results.",
              ""]
    return "\n".join(lines)


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phase", choices=sorted(PHASES))
    parser.add_argument("--skills-root", type=Path)
    parser.add_argument("--model", help="full model ID to pin for generation and judging")
    parser.add_argument("--repeats", type=_positive_int,
                        help="positive repeats per case; defaults to before=3, after=3, control=1")
    parser.add_argument("--out", type=Path, required=True, help="new output directory; never overwritten")
    parser.add_argument("--compare", nargs=2, metavar=("BEFORE", "AFTER"))
    parser.add_argument("--control", type=Path)
    parser.add_argument("--snapshot-skills", type=Path, help="copy this skill tree to --out")
    args = parser.parse_args(argv)
    try:
        if args.snapshot_skills:
            metadata = snapshot_skills(args.snapshot_skills, args.out)
            print(json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True))
            return 0
        if args.compare:
            if not args.control:
                parser.error("--compare requires --control CONTROL")
            result = compare(Path(args.compare[0]), Path(args.compare[1]), args.control, args.out)
            print(f"Comparison saved to {Path(args.out).absolute() / 'comparison.md'}")
            return 1 if result["judge_failures"] else 0
        if not args.phase or not args.skills_root or not args.model:
            parser.error("a phase run requires --phase, --skills-root, and --model")
        repeats = args.repeats if args.repeats is not None else DEFAULT_REPEATS[args.phase]
        result = run_phase(args.phase, args.skills_root, args.model, args.out, repeats)
        return 1 if result.get("status") != "complete" else 0
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"evidence_benchmark: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

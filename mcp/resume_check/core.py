"""Tool logic over the skill's own scripts (SPEC NFR-3): scan_cv and review_score are imported, not copied."""
from __future__ import annotations

import io
import subprocess
import sys
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from xml.etree import ElementTree

SCRIPTS = Path(__file__).resolve().parents[2] / "skill" / "job-resume-review" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import review_score  # noqa: E402
import scan_cv  # noqa: E402

from .fetch import MAX_DOWNLOAD_BYTES, FetchError, fetch  # noqa: E402

MAX_CONCURRENT_SCANS = 4
TEMP_PREFIX = "resume-check-"
_scan_slots = threading.BoundedSemaphore(MAX_CONCURRENT_SCANS)


class ToolError(Exception):
    """A failure whose message is returned to the caller as a tool error."""


# ---------------------------------------------------------------- rubric

LABELS = {
    "positioning": ("Positioning", "Top third of page 1: target title, specialty, strongest proof"),
    "bullets": ("Achievement bullets", "Contribution, context, ownership, scope/outcome, clarity"),
    "skills": ("Skills and relevance", "Focused capabilities that roles or projects name"),
    "organization": ("Logical organization", "Section order, chronology, dates, gaps, completeness, market norms"),
    "visual": ("Visual presentation", "Scannable role headers, hierarchy, whitespace, density, page breaks"),
    "writing": ("Writing", "Spelling, specific language, concision, consistency, varied structure"),
    "parsing": ("Parsing readiness", "Text recovery, reading order, intact fields and terminology"),
}

RATING_SCALE = {
    "0": "absent or unusable",
    "1": "major weaknesses",
    "2": "mixed quality",
    "3": "solid with limited weaknesses",
    "4": "strong with no material weakness",
}

BULLET_SCALE = {
    "0": "no intelligible contribution",
    "1": "generic duty or unsupported claim (\"responsible for\", \"helped with\", \"worked on\") with no outcome",
    "2": "specific action or context but unclear ownership or value, or a process count "
         "(pull requests, commits, tickets) as the only result",
    "3": "clear contribution with useful scope or a concrete outcome; a percentage or multiplier "
         "with no baseline, scale or timeframe stops here",
    "4": "clear contribution, context and convincing value with a result an interviewer could probe, "
         "expressed concisely",
}

BLOCKING_DEFECTS = [
    "no extractable text on any page",
    "role headers or dates that extract out of order",
    "text that extracts but is not visible on the rendered page",
    "no email or phone number in the document body, including contact details that appear only "
    "in a page header or footer",
]

CREDIT_MEANING = {
    "1": "clear support in an experience or project",
    "0.5": "partial support, or support only in Skills or the summary",
    "0": "not demonstrated",
}


def rubric() -> Dict[str, Any]:
    """Rubric numbers come from review_score, so a weight change there changes this response (FR-2.2)."""
    criteria = []
    for name, weight in review_score.WEIGHTS.items():
        label, assess = LABELS[name]
        criteria.append({"name": name, "label": label, "weight": weight, "assess": assess,
                         "rated_by": "bullets" if name == "bullets" else "criteria"})
    return {
        "rubric_version": review_score.VERSION,
        "disclaimer": "A designed evaluation framework, not a validated scale, an employer ATS score "
                      "or a prediction of interview success.",
        "rating_scale": RATING_SCALE,
        "criteria": criteria,
        "bullets": {
            "scale": BULLET_SCALE,
            "recent_weight": 2,
            "other_weight": 1,
            "recent_rule": "Bullets in the two most recent roles (latest end dates, current roles first) "
                           "weigh 2; other bullets weigh 1. A resume with no achievement descriptions rates 0.",
        },
        "blocking": {
            "cap": review_score.CAP,
            "defects": BLOCKING_DEFECTS,
            "rule": f"Any blocking defect caps the overall score at {review_score.CAP}. Every blocking-severity "
                    "issue from a scan counts as a blocking defect.",
        },
        "alignment": {
            "kind_weights": dict(review_score.KIND_WEIGHTS),
            "credits": list(review_score.CREDITS),
            "credit_meaning": CREDIT_MEANING,
            "rule": "Only with a job posting: one requirement per deduplicated posting requirement. "
                    "Alignment is reported separately from the score.",
        },
        "how_to_score": "Rate each criterion you assessed and each bullet, then call score_resume_review. "
                        "Omit a criterion you did not assess; do not estimate the arithmetic yourself.",
    }


# ---------------------------------------------------------------- score

def score(arguments: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    try:
        return review_score.score(arguments or {})
    except review_score.InputError as error:
        raise ToolError(str(error)) from None


# ---------------------------------------------------------------- scan

UNSUPPORTED = "unsupported file type: only PDF and DOCX resumes are supported"


def sniff(data: bytes) -> str:
    """Decide the type from content, not from a name or URL (FR-4.2)."""
    if data[:1024].lstrip(b"\x00\t\n\r\f ").startswith(b"%PDF-"):
        return "pdf"
    if data.startswith(b"PK\x03\x04"):
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = set(archive.namelist())
        except zipfile.BadZipFile:
            raise ToolError("the file looks like a ZIP archive but cannot be opened") from None
        if "[Content_Types].xml" in names and any(n.startswith("word/") for n in names):
            return "docx"
    raise ToolError(UNSUPPORTED)


def scan_bytes(data: bytes) -> Dict[str, Any]:
    """Scan bytes as scan_cv.py would scan the same bytes on disk. The temp dir never outlives the call."""
    kind = sniff(data)
    with tempfile.TemporaryDirectory(prefix=TEMP_PREFIX) as directory:
        path = Path(directory) / f"resume.{kind}"
        path.write_bytes(data)
        try:
            return scan_cv.scan(path)
        except subprocess.TimeoutExpired:
            raise ToolError("the PDF text extraction timed out") from None
        except RuntimeError as error:  # pdftotext failure, or an encrypted or unsupported DOCX entry
            raise ToolError(f"the {kind.upper()} could not be read: {error}") from None
        except (zipfile.BadZipFile, ElementTree.ParseError, KeyError, UnicodeDecodeError) as error:
            raise ToolError(f"the DOCX could not be read: {type(error).__name__}: {error}") from None
        except (OSError, ValueError) as error:
            raise ToolError(f"the file could not be scanned: {error}") from None


def scan_url(url: Any, fetcher: Optional[Callable[[str], bytes]] = None) -> Dict[str, Any]:
    """Download and scan. Blocking; run it in a worker thread."""
    if not isinstance(url, str) or not url.strip():
        raise ToolError("url must be a non-empty https URL string")
    if not _scan_slots.acquire(blocking=False):
        raise ToolError("the server is busy scanning other resumes; retry in a few seconds")
    try:
        try:
            data = (fetcher or fetch)(url)
        except FetchError as error:
            raise ToolError(str(error)) from None
        if len(data) > MAX_DOWNLOAD_BYTES:
            raise ToolError(f"the file exceeds the {MAX_DOWNLOAD_BYTES // 1_000_000} MB download limit")
        if not data:
            raise ToolError("the downloaded file is empty")
        return scan_bytes(data)
    finally:
        _scan_slots.release()


def file_download_url(file: Any) -> str:
    if not isinstance(file, dict):
        raise ToolError("file must be an object with download_url and file_id")
    url = file.get("download_url")
    if not isinstance(url, str) or not url.strip():
        raise ToolError("file.download_url must be a non-empty https URL string")
    if not isinstance(file.get("file_id"), str):
        raise ToolError("file.file_id must be a string")
    return url

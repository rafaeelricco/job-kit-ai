#!/usr/bin/env python3
"""Scan a CV file for extraction and structure risks that a page view hides.

argv[1]: a .pdf or .docx file.
stdout: {"format": "pdf"|"docx", "bytes": int, "pages": int|null,
         "issues": [{"code", "severity": "blocking"|"major"|"minor", "page": int|null, "detail"}]}
Exit 0 after a scan; 2 with {"scan_cv_error": str} on usage error, unreadable or unsupported
file, or missing pdftotext. PDF text comes from Poppler pdftotext in default mode, the same
flags as job-resume-refine/scripts/check_parse.py extract(); no OCR, no installs.
"""
from __future__ import annotations
import json
import re
import subprocess
import sys
import unicodedata
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

MAX_BYTES = 2_500_000
LIGATURES = {chr(c) for c in range(0xFB00, 0xFB07)}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
PHONE = re.compile(r"\+?(?:\(\d+\)|\d+)(?:[ .-]?(?:\(\d+\)|\d+))*")  # " - " or an unclosed "(" ends a run
NOT_PHONE = re.compile(r"\d{1,3}(?:\.\d{3}){2,}|(?:\d\d?[./])?(?:19|20)\d\d-(?:\d\d?[./])?(?:19|20)\d\d")
MIN_PHONE_DIGITS = 9  # a year range such as 2019-2024 has 8 digits
DOCX_TEXT = re.compile(r"<w:t(?: [^>]*)?>([^<]*)</w:t>")
DOCX_HEADER_FOOTER = re.compile(r"word/(?:header|footer)\d+\.xml")
CHAR_CODES = (  # code, severity, test — order is output order
    ("replacement_character", "major", lambda ch: ch == "\ufffd"),
    ("ligature_code_point", "major", lambda ch: ch in LIGATURES),
    ("private_use_character", "minor", lambda ch: unicodedata.category(ch) == "Co"),
    ("control_character", "major", lambda ch: (ord(ch) < 0x20 and ch not in "\t\n\r\f") or 0x7F <= ord(ch) <= 0x9F),
)


def issue(code: str, severity: str, page: Optional[int], detail: str) -> Dict[str, Any]:
    return {"code": code, "severity": severity, "page": page, "detail": detail}


def extract_pdf(path: Path) -> str:
    proc = subprocess.run(["pdftotext", "-enc", "UTF-8", "-eol", "unix", str(path), "-"],
                          capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {proc.stderr.decode('utf-8', 'replace').strip()}")
    return proc.stdout.decode("utf-8")  # strict: a decode fallback would fake U+FFFD hits


def scan_pdf_text(text: str) -> Tuple[int, List[Dict[str, Any]]]:
    pages = text.split("\f")
    if pages and not pages[-1].strip():  # pdftotext ends every page with \f
        pages.pop()
    blank = [n for n, page in enumerate(pages, 1) if not page.strip()]
    if len(blank) == len(pages):
        return len(pages), [issue("no_text_layer", "blocking", None, "no page has extractable text")]
    issues = [issue("no_text_layer", "major", n, "page has no extractable text") for n in blank]
    for n, page in enumerate(pages, 1):
        for code, severity, test in CHAR_CODES:
            hits = [ch for ch in page if test(ch)]
            if hits:
                issues.append(issue(code, severity, n, f"{len(hits)} x U+{ord(hits[0]):04X}"))
    return len(pages), issues


def has_contact(text: str) -> bool:
    return bool(EMAIL.search(text)) or any(
        sum(ch.isdigit() for ch in match.group()) >= MIN_PHONE_DIGITS and not NOT_PHONE.fullmatch(match.group())
        for match in PHONE.finditer(text))


def docx_text(xml: str) -> str:
    # runs join within a paragraph so a contact split across runs still matches; paragraphs join by newline
    return "\n".join("".join(DOCX_TEXT.findall(paragraph)) for paragraph in xml.split("</w:p>"))


def scan_docx(path: Path) -> List[Dict[str, Any]]:
    with zipfile.ZipFile(path) as archive:
        body = archive.read("word/document.xml").decode("utf-8")
        parts = sorted(name for name in archive.namelist() if DOCX_HEADER_FOOTER.fullmatch(name))
        headers = [(name, archive.read(name).decode("utf-8")) for name in parts]
    issues: List[Dict[str, Any]] = []
    text = docx_text(body)
    if not text.strip():
        issues.append(issue("no_text_layer", "blocking", None, "document body has no text"))
    if not has_contact(text):  # header/footer contact counts only when the body has none
        for name, xml in headers:
            if has_contact(docx_text(xml)):
                issues.append(issue("contact_in_header_footer", "blocking", None, f"{name}; body has no email or phone"))
    if "<w:txbxContent" in body:
        issues.append(issue("text_box", "major", None, "text box content can be skipped by parsers"))
    if re.search(r"<w:tbl[ >]", body):
        issues.append(issue("table", "minor", None, "table layout can scramble reading order"))
    if "<w:drawing" in body or "<w:pict" in body:
        issues.append(issue("image", "minor", None, "embedded image or drawing is invisible to parsers"))
    return issues


def scan(path: Path) -> Dict[str, Any]:
    suffix = path.suffix.lower()
    size = path.stat().st_size
    pages: Optional[int] = None
    if suffix == ".pdf":
        pages, issues = scan_pdf_text(extract_pdf(path))
    elif suffix == ".docx":
        issues = scan_docx(path)
    else:
        raise ValueError(f"unsupported file type: {path.suffix or path.name}")
    if size > MAX_BYTES:
        issues.append(issue("file_too_large", "minor", None, f"{size} bytes exceeds {MAX_BYTES}"))
    return {"format": suffix[1:], "bytes": size, "pages": pages, "issues": issues}


def main(argv: List[str]) -> int:
    try:
        if len(argv) != 2:
            raise ValueError("usage: scan_cv.py <cv.pdf|cv.docx>")
        report = scan(Path(argv[1]))
    except (OSError, ValueError, RuntimeError, KeyError, zipfile.BadZipFile, subprocess.TimeoutExpired) as error:
        print(json.dumps({"scan_cv_error": str(error)}, ensure_ascii=True, indent=2))
        return 2
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

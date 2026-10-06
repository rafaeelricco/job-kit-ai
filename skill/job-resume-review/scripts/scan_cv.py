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
import html
import json
import re
import subprocess
import sys
import unicodedata
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from xml.etree import ElementTree

MAX_BYTES = 2_500_000
MAX_PART_BYTES = 20_000_000  # uncompressed budget for the DOCX parts read; a CV body is well under 1 MB
LIGATURES = {chr(c) for c in range(0xFB00, 0xFB07)}
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
PHONE = re.compile(r"\+?(?:\(\d+\)|\d+)(?:[ .-]?(?:\(\d+\)|\d+))*")  # " - " or an unclosed "(" ends a run
NOT_PHONE = re.compile(r"\d{1,3}(?:\.\d{3}){2,}|(?:\d\d?[./])?(?:19|20)\d\d-(?:\d\d?[./])?(?:19|20)\d\d")
MIN_PHONE_DIGITS = 9  # a year range such as 2019-2024 has 8 digits
DOCX_TEXT = re.compile(r"<w:t(?: [^>]*)?>([^<]*)</w:t>")
DOCX_RUN_START = re.compile(r"(?=<w:r[ >])")
DOCX_VANISH = re.compile(r'<w:r[ >][^<]*<w:rPr>(?:(?!</w:rPr>).)*?<w:vanish(?: w:val="(?:true|1|on)")?\s*/>', re.S)
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


def char_issues(text: str, page: Optional[int]) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    for code, severity, test in CHAR_CODES:
        hits = [ch for ch in text if test(ch)]
        if hits:
            found.append(issue(code, severity, page, f"{len(hits)} x U+{ord(hits[0]):04X}"))
    return found


def scan_pdf_text(text: str) -> Tuple[int, List[Dict[str, Any]]]:
    pages = text.split("\f")
    if pages and not pages[-1].strip():  # pdftotext ends every page with \f
        pages.pop()
    blank = [n for n, page in enumerate(pages, 1) if not page.strip()]
    if len(blank) == len(pages):
        return len(pages), [issue("no_text_layer", "blocking", None, "no page has extractable text")]
    issues = [issue("no_text_layer", "major", n, "page has no extractable text") for n in blank]
    for n, page in enumerate(pages, 1):
        issues.extend(char_issues(page, n))
    return len(pages), issues


def has_contact(text: str) -> bool:
    return bool(EMAIL.search(text)) or any(
        sum(ch.isdigit() for ch in match.group()) >= MIN_PHONE_DIGITS and not NOT_PHONE.fullmatch(match.group())
        for match in PHONE.finditer(text))


def docx_text(xml: str) -> Tuple[str, str]:
    # (visible, hidden): a run with <w:vanish/> is not rendered, so its text is hidden, not visible;
    # runs join within a paragraph so a contact split across runs still matches; paragraphs join by newline;
    # unescape so a code point stored as a character reference (&#xFB01;) is checked like a literal one
    visible: List[str] = []
    hidden: List[str] = []
    for paragraph in xml.split("</w:p>"):
        runs = DOCX_RUN_START.split(paragraph)
        visible.append("".join("".join(DOCX_TEXT.findall(run)) for run in runs if not DOCX_VANISH.match(run)))
        hidden.append("".join("".join(DOCX_TEXT.findall(run)) for run in runs if DOCX_VANISH.match(run)))
    return html.unescape("\n".join(visible)), html.unescape("\n".join(hidden))


def read_parts(archive: zipfile.ZipFile, names: List[str]) -> List[str]:
    # check declared sizes before decompressing; zipfile stops each read at the declared size
    total = sum(archive.getinfo(name).file_size for name in names)
    if total > MAX_PART_BYTES:
        raise ValueError(f"DOCX parts expand to {total} bytes, over the {MAX_PART_BYTES} byte limit")
    return [archive.read(name).decode("utf-8") for name in names]


def main_part(archive: zipfile.ZipFile) -> str:
    # the officeDocument relationship names the body part; Word Online can save it as word/document2.xml
    if "_rels/.rels" in archive.namelist():
        for relationship in ElementTree.fromstring(read_parts(archive, ["_rels/.rels"])[0]):
            if relationship.get("Type", "").endswith("/officeDocument"):
                return relationship.get("Target", "").lstrip("/")
    return "word/document.xml"


def scan_docx(path: Path) -> List[Dict[str, Any]]:
    with zipfile.ZipFile(path) as archive:
        parts = sorted(name for name in archive.namelist() if DOCX_HEADER_FOOTER.fullmatch(name))
        body, *xmls = read_parts(archive, [main_part(archive)] + parts)
        headers = list(zip(parts, xmls))
    issues: List[Dict[str, Any]] = []
    text, hidden = docx_text(body)
    if not text.strip():
        issues.append(issue("no_text_layer", "blocking", None, "document body has no text"))
    if hidden.strip():
        issues.append(issue("hidden_text", "blocking", None, f"{len(hidden.split())} words in vanished runs"))
    issues.extend(char_issues(text, None))
    if not has_contact(text):  # header/footer contact counts only when the body has none
        for name, xml in headers:
            if has_contact(docx_text(xml)[0]):
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
    except (OSError, ValueError, RuntimeError, KeyError, zipfile.BadZipFile, ElementTree.ParseError,
            subprocess.TimeoutExpired) as error:
        print(json.dumps({"scan_cv_error": str(error)}, ensure_ascii=True, indent=2))
        return 2
    print(json.dumps(report, ensure_ascii=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

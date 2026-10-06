"""Tests for scan_cv.py: PDF text anomalies (extraction mocked, CI has no Poppler) and DOCX structure."""
import io
import json
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import scan_cv
from scan_cv import MAX_BYTES, scan_docx, scan_pdf_text

DOC = '<w:document xmlns:w="w"><w:body>{}</w:body></w:document>'
PARA = "<w:p><w:r><w:t>{}</w:t></w:r></w:p>"


def codes(issues):
    return [(i["code"], i["severity"], i["page"]) for i in issues]


def docx(folder, body, **parts):
    path = Path(folder) / "cv.docx"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("word/document.xml", DOC.format(body))
        for name, text in parts.items():
            z.writestr(f"word/{name}.xml", f'<w:hdr xmlns:w="w">{PARA.format(text)}</w:hdr>')
    return path


def run(path):
    out = io.StringIO()
    with redirect_stdout(out):
        status = scan_cv.main(["scan_cv.py", str(path)])
    return status, json.loads(out.getvalue())


class PdfTextTests(unittest.TestCase):
    def test_clean_text_has_no_issues(self):
        self.assertEqual(scan_pdf_text("Alex Doe\nEngineer\n\f"), (1, []))

    def test_no_text_anywhere_is_blocking(self):
        for text in ("", "\f\f"):
            self.assertEqual(codes(scan_pdf_text(text)[1]), [("no_text_layer", "blocking", None)])

    def test_one_blank_page_is_major(self):
        self.assertEqual(codes(scan_pdf_text("text\f\f")[1]), [("no_text_layer", "major", 2)])

    def test_character_anomalies(self):
        self.assertEqual(codes(scan_pdf_text("ﬁnance �  bell\x07\f")[1]), [
            ("replacement_character", "major", 1), ("ligature_code_point", "major", 1),
            ("private_use_character", "minor", 1), ("control_character", "major", 1)])


class DocxTests(unittest.TestCase):
    def test_clean_docx(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(scan_docx(docx(tmp, PARA.format("Alex Doe"))), [])

    def test_contact_only_in_header_is_blocking(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = docx(tmp, PARA.format("Alex Doe"), header1="alex.doe@example.com")
            self.assertEqual(codes(scan_docx(path)), [("contact_in_header_footer", "blocking", None)])

    def test_header_contact_is_fine_when_body_has_contact(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = docx(tmp, PARA.format("Alex Doe +55 11 90000-0000"), header1="alex.doe@example.com")
            self.assertEqual(scan_docx(path), [])

    def test_dates_are_not_contact_details(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = docx(tmp, PARA.format("Alex Doe"), footer1="Alex Doe CV 2019-2024, updated 2024.01.15")
            self.assertEqual(scan_docx(path), [])

    def test_date_ranges_and_amounts_are_not_body_contact(self):
        for body in ("Senior Engineer, Acme 2015 - 2020 (5 years)", "Acme 2015-2020 (5 years)",
                     "Software Engineer, Globex 01.2019 - 03.2024", "Globex 01.2019-03.2024",
                     "Led migration saving R$ 1.200.000.000 per year"):
            with tempfile.TemporaryDirectory() as tmp:
                path = docx(tmp, PARA.format(body), header1="alex.doe@example.com")
                self.assertEqual(codes(scan_docx(path)), [("contact_in_header_footer", "blocking", None)], body)

    def test_phone_shapes_are_body_contact(self):
        for phone in ("+55 11 90000-0000", "(11) 90000-0000", "+1 (415) 555-0123", "415.555.0123",
                      "+44 (0)20 7946 0958", "+351 912 345 678", "+55 11 2015-2020"):
            with tempfile.TemporaryDirectory() as tmp:
                path = docx(tmp, PARA.format(f"Alex Doe {phone}"), header1="alex.doe@example.com")
                self.assertEqual(scan_docx(path), [], phone)

    def test_text_box_table_image_and_empty_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            found = codes(scan_docx(docx(tmp, "<w:tbl><w:txbxContent/></w:tbl><w:drawing/>")))
        self.assertEqual(sorted(found), sorted([("no_text_layer", "blocking", None), ("text_box", "major", None),
                                                ("table", "minor", None), ("image", "minor", None)]))


class CliTests(unittest.TestCase):
    def test_pdf_scan_with_size_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf = Path(tmp) / "cv.pdf"
            with pdf.open("wb") as f:
                f.truncate(MAX_BYTES + 1)
            with mock.patch.object(scan_cv, "extract_pdf", return_value="Alex Doe\f"):
                status, out = run(pdf)
        self.assertEqual((status, out["format"], out["pages"]), (0, "pdf", 1))
        self.assertEqual(codes(out["issues"]), [("file_too_large", "minor", None)])

    def test_missing_pdftotext_and_unsupported_type_exit_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            pdf, odt = Path(tmp) / "cv.pdf", Path(tmp) / "cv.odt"
            pdf.write_bytes(b"%PDF-1.4\n")
            odt.write_bytes(b"x")
            with mock.patch.object(scan_cv.subprocess, "run", side_effect=FileNotFoundError("pdftotext")):
                self.assertEqual(run(pdf)[0], 2)
            status, out = run(odt)
        self.assertEqual(status, 2)
        self.assertIn("scan_cv_error", out)

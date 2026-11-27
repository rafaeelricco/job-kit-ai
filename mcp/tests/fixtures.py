"""Synthetic resume files built in memory. No real person's data."""
from __future__ import annotations

import io
import zipfile

SAMPLE_NAME = "Alex Example"
SAMPLE_EMAIL = "alex.example@example.com"


def _pdf(page_streams: list[bytes]) -> bytes:
    """A minimal PDF, one page per content stream, Helvetica text."""
    objects: list[bytes] = []
    count = len(page_streams)
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(count))
    font_id = 3 + 2 * count
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {count} >>".encode())
    for i, stream in enumerate(page_streams):
        content_id = 4 + 2 * i
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_id} 0 R "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> >>".encode())
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n" % number + body + b"\nendobj\n")
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref))
    return out.getvalue()


def _text_stream(lines: list[str]) -> bytes:
    parts = ["BT /F1 11 Tf 72 720 Td 14 TL"]
    for line in lines:
        escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        parts.append(f"({escaped}) Tj T*")
    parts.append("ET")
    return "\n".join(parts).encode("latin-1")


RESUME_LINES = [
    SAMPLE_NAME,
    f"Software Engineer | {SAMPLE_EMAIL}",
    "Experience",
    "Example Corp, Senior Engineer, 2021-2024",
    "Built a billing service that cut invoice errors for 40 customers.",
    "Skills: Python, PostgreSQL",
]


def text_pdf() -> bytes:
    return _pdf([_text_stream(RESUME_LINES)])


def blank_pdf() -> bytes:
    """A scanned-looking PDF: a page with no text layer."""
    return _pdf([b"0 0 1 rg 72 72 200 200 re f"])


def mixed_pdf() -> bytes:
    """Two pages, the second without text."""
    return _pdf([_text_stream(RESUME_LINES), b"0 0 1 rg 72 72 200 200 re f"])


W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def _paragraphs(lines: list[str]) -> str:
    return "".join(f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>" for line in lines)


def _docx(body: str, header: str | None = None) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml",
                         '<?xml version="1.0" encoding="UTF-8"?>'
                         '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                         '<Default Extension="xml" ContentType="application/xml"/>'
                         '<Override PartName="/word/document.xml" ContentType="application/'
                         'vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("_rels/.rels",
                         '<?xml version="1.0" encoding="UTF-8"?>'
                         '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                         '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
                         'relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        archive.writestr("word/document.xml",
                         f'<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>{body}</w:body></w:document>')
        if header is not None:
            archive.writestr("word/header1.xml", f'<?xml version="1.0" encoding="UTF-8"?><w:hdr {W}>{header}</w:hdr>')
    return out.getvalue()


def clean_docx_body() -> bytes:
    return (f'<?xml version="1.0" encoding="UTF-8"?><w:document {W}><w:body>'
            f'{_paragraphs(RESUME_LINES)}</w:body></w:document>').encode()


def clean_docx() -> bytes:
    return _docx(_paragraphs(RESUME_LINES))


def header_contact_docx() -> bytes:
    """Contact details only in the page header: a blocking defect."""
    body = [line for line in RESUME_LINES if "@" not in line] + ["Software Engineer"]
    return _docx(_paragraphs(body), header=_paragraphs([SAMPLE_EMAIL]))


def hidden_text_docx() -> bytes:
    hidden = '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>keyword keyword keyword</w:t></w:r></w:p>'
    return _docx(_paragraphs(RESUME_LINES) + hidden)


def corrupt_pdf() -> bytes:
    return b"%PDF-1.4\nthis is not a real pdf body\n"


def corrupt_docx() -> bytes:
    """A ZIP that looks like a DOCX but whose body part is not XML text."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", b"\xff\xfe\x00broken")
    return out.getvalue()


ALL = {
    "text.pdf": text_pdf,
    "blank.pdf": blank_pdf,
    "mixed.pdf": mixed_pdf,
    "clean.docx": clean_docx,
    "header-contact.docx": header_contact_docx,
    "hidden-text.docx": hidden_text_docx,
}

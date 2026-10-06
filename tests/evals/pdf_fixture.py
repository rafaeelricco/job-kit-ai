"""Write a minimal one-page PDF (Helvetica, WinAnsi) for job-resume-review evals.

Visible lines render black; hidden lines render white, so they extract but do not show.
"""
from pathlib import Path
from typing import Sequence


def _escape(line: str) -> bytes:
    return line.encode("cp1252").replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def write_pdf(path: Path, lines: Sequence[str], hidden: Sequence[str] = ()) -> Path:
    ops = [b"BT /F1 10 Tf 14 TL 56 800 Td"]
    for colour, group in ((b"0 0 0 rg", lines), (b"1 1 1 rg", hidden)):
        ops.append(colour)
        ops += [b"(" + _escape(line) + b") '" for line in group]
    stream = b"\n".join(ops + [b"ET"])
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >>"
        b" /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
    ]
    out, offsets = bytearray(b"%PDF-1.4\n"), []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    path.write_bytes(bytes(out))
    return path

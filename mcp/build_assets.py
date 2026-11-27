#!/usr/bin/env python3
"""Write the synthetic sample resumes into a site directory.

Usage: build_assets.py <site-dir>
Writes <site-dir>/samples/*.pdf|docx. The samples describe a fictional person (FR-9.9).
Brand images in site/brand/ come from rafaeelricco/job-kit-platform packages/frontend/public.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "tests"))
import fixtures  # noqa: E402

SAMPLES = {
    "clean.pdf": fixtures.text_pdf,
    "scanned.pdf": fixtures.blank_pdf,
    "clean.docx": fixtures.clean_docx,
    "header-contact.docx": fixtures.header_contact_docx,
    "hidden-text.docx": fixtures.hidden_text_docx,
}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    samples = Path(argv[1]) / "samples"
    samples.mkdir(parents=True, exist_ok=True)
    for name, build in SAMPLES.items():
        (samples / name).write_bytes(build())
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

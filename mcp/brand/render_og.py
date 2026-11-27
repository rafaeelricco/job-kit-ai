#!/usr/bin/env python3
"""Render mcp/brand/og-image.html to mcp/site/brand/og-image.png (1200x630) with headless Chrome.

Same approach as job-kit-platform's scripts/brand/render.py: the brand sources are vector and HTML, and the
PNG is generated. Needs Chrome or Edge, and network access for the Google Fonts the card uses.

    python mcp/brand/render_og.py
"""
from __future__ import annotations

import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "og-image.html"
OUT = HERE.parent / "site" / "brand" / "og-image.png"
WIDTH, HEIGHT = 1200, 630
CANDIDATES = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
)


def main() -> int:
    chrome = next((c for c in CANDIDATES if Path(c).exists()), None)
    if chrome is None:
        print("render_og: no Chrome, Edge or Chromium found", file=sys.stderr)
        return 1
    subprocess.run([chrome, "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                    "--virtual-time-budget=8000", "--allow-file-access-from-files",
                    f"--window-size={WIDTH},{HEIGHT}", f"--screenshot={OUT}", SOURCE.as_uri()],
                   check=True, capture_output=True)
    raw = OUT.read_bytes()
    width, height = struct.unpack(">II", raw[16:24])
    if (width, height) != (WIDTH, HEIGHT):
        print(f"render_og: got {width}x{height}, expected {WIDTH}x{HEIGHT}", file=sys.stderr)
        return 1
    print(f"wrote {OUT} ({width}x{height}, {len(raw)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

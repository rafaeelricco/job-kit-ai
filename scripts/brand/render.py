#!/usr/bin/env python3
"""Render packages/frontend/public/brand/*.svg into the PNG icon set served from packages/frontend/public/.

The brand sources are vector; every raster under packages/frontend/public/ is generated. Edit
the SVG and re-run this, never hand-edit a PNG.

This machine has no rsvg-convert, inkscape or imagemagick, so the rasterizer is
headless Chrome: it is the one SVG renderer present on macOS that honours the
gradient in the mascot's face and preserves alpha. Chrome also does the
supersampled downscale for the small icons, so nothing else is required.

    python3 scripts/brand/render.py            # write the PNGs
    python3 scripts/brand/render.py --check    # verify sizes/alpha, write nothing
"""

from __future__ import annotations

import argparse
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BRAND = REPO / "packages" / "frontend" / "public" / "brand"
PUBLIC = REPO / "packages" / "frontend" / "public"

CHROME_CANDIDATES = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
)

# (source svg, width, height, background or None for transparent, output png, artwork scale)
# The artwork scale is the fraction of the canvas the SVG fills, centred; 1.0 is edge to edge.
TARGETS: tuple[tuple[str, int, int, str | None, str, float], ...] = (
    ("mascot-mark.svg", 16, 16, None, "favicon-16.png", 1.0),
    ("mascot-mark.svg", 32, 32, None, "favicon-32.png", 1.0),
    # Apple composites onto black if the icon is transparent, so this one is plated.
    ("mascot-mark.svg", 180, 180, "#ffffff", "apple-touch-icon.png", 1.0),
    ("mascot-mark.svg", 192, 192, None, "icon-192.png", 1.0),
    ("mascot-mark.svg", 512, 512, None, "icon-512.png", 1.0),
    # Maskable launchers may crop to a circle of 40% radius; the edge-to-edge
    # icon-512 loses the mouth there. Plated and inset so the whole mark fits
    # inside that circle (0.76 measured as the largest scale with no spill).
    ("mascot-mark.svg", 512, 512, "#fafafa", "icon-512-maskable.png", 0.76),
    ("og-image.svg", 1200, 630, "#fafafa", "og-image.png", 1.0),
    # Served as https://r1cco.com/jobs/job-kit-logo.png — the README hero, which
    # sets width=480; the 2.82:1 horizontal lockup keeps that ~160px tall.
    ("lockup-horizontal.svg", 2870, 1016, None, "job-kit-logo.png", 1.0),
)


def find_chrome() -> str:
    for path in CHROME_CANDIDATES:
        if Path(path).exists():
            return path
    sys.exit("no Chrome/Chromium found; install one or add its path to CHROME_CANDIDATES")


def png_meta(path: Path) -> tuple[int, int, bool]:
    """(width, height, has_alpha) straight from the IHDR chunk."""
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    width, height = struct.unpack(">II", raw[16:24])
    colour_type = raw[25]
    return width, height, colour_type in (4, 6)


def render(
    chrome: str, svg: Path, width: int, height: int, background: str | None, out: Path, artwork: float = 1.0
) -> None:
    """Rasterize one SVG at an exact pixel size, preserving alpha when asked.

    ``artwork`` is the fraction of the canvas the SVG occupies, centred, so a
    maskable icon can sit inside the launcher safe zone.

    Small icons are supersampled: Chrome's direct 16px raster turns the mascot
    into a blob, so the page draws the SVG at 8x on a canvas and halves it down
    step by step, which keeps the hair mass, glasses and mouth readable. The
    downsample happens inside Chrome, so no platform resize tool is needed.
    """
    scale = 8 if max(width, height) <= 64 else 1
    bg = background or "transparent"
    art_w = round(width * scale * artwork)
    art_h = round(height * scale * artwork)
    downsample = ""
    if scale != 1:
        # Draw the 8x image on a canvas and halve it until it fits; each halving
        # averages 2x2 pixels, which is what keeps small sizes legible.
        downsample = (
            "<script>"
            "const img=document.querySelector('img');"
            "img.decode().then(()=>{"
            f"let w={width * scale},h={height * scale};"
            "let src=document.createElement('canvas');src.width=w;src.height=h;"
            "src.getContext('2d').drawImage("
            f"img,{(width * scale - art_w) // 2},{(height * scale - art_h) // 2},{art_w},{art_h});"
            f"while(w>{width}){{"
            "const half=document.createElement('canvas');half.width=w/2;half.height=h/2;"
            "const ctx=half.getContext('2d');ctx.imageSmoothingQuality='high';"
            "ctx.drawImage(src,0,0,w/2,h/2);src=half;w/=2;h/=2;}"
            "img.replaceWith(src);"
            "});"
            "</script>"
        )
    with tempfile.TemporaryDirectory() as tmp:
        page = Path(tmp) / "page.html"
        page.write_text(
            "<html><head><style>"
            f"html,body{{margin:0;padding:0;background:{bg}}}"
            f"body{{display:flex;align-items:center;justify-content:center;"
            f"width:{width}px;height:{height}px}}"
            f"canvas{{display:block;width:{width}px;height:{height}px}}"
            f"img{{display:block;width:{art_w}px;height:{art_h}px}}"
            "</style></head>"
            f'<body><img src="{svg.as_uri()}"></body>{downsample}</html>'
        )
        subprocess.run(
            [
                chrome,
                "--headless",
                "--disable-gpu",
                "--hide-scrollbars",
                "--default-background-color=00000000",
                "--force-device-scale-factor=1",
                "--virtual-time-budget=5000",
                f"--screenshot={out}",
                f"--window-size={width},{height}",
                page.as_uri(),
            ],
            check=True,
            capture_output=True,
        )

    got_w, got_h, has_alpha = png_meta(out)
    if (got_w, got_h) != (width, height):
        raise SystemExit(f"{out.name}: expected {width}x{height}, got {got_w}x{got_h}")
    if background is None and not has_alpha:
        raise SystemExit(f"{out.name}: expected transparency, got an opaque PNG")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify the committed PNGs, write nothing")
    args = parser.parse_args()

    if args.check:
        failures: list[str] = []
        for source, width, height, background, out_name, _artwork in TARGETS:
            out = PUBLIC / out_name
            if not out.exists():
                failures.append(f"{out_name}: missing")
                continue
            got_w, got_h, has_alpha = png_meta(out)
            if (got_w, got_h) != (width, height):
                failures.append(f"{out_name}: {got_w}x{got_h}, expected {width}x{height}")
            elif background is None and not has_alpha:
                failures.append(f"{out_name}: opaque, expected alpha")
            else:
                print(f"  ok  {out_name:24} {got_w}x{got_h} alpha={has_alpha}")
        for problem in failures:
            print(f"  FAIL {problem}")
        return 1 if failures else 0

    chrome = find_chrome()
    for source, width, height, background, out_name, artwork in TARGETS:
        svg = BRAND / source
        if not svg.exists():
            raise SystemExit(f"missing brand source: {svg}")
        out = PUBLIC / out_name
        render(chrome, svg, width, height, background, out, artwork)
        got_w, got_h, has_alpha = png_meta(out)
        print(f"  {out_name:24} {got_w}x{got_h}  alpha={has_alpha}  <- {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

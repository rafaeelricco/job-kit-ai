"""Pin the design-system docs and preview catalog to the stylesheet they describe.

The job-kit-dev `design-system.md` restates `packages/frontend/src/index.css` in tables, and its
catalog renders it. Nothing executes either, so a renamed token or changed hex
leaves them confidently wrong. The catalog imports index.css rather than copying
it, so what can still drift is small and checked here: spec tables, var() names,
typed color literals, font stacks, relative links, and shard listing.
"""

import json
import re
import sys
import unittest
from pathlib import Path
from typing import Dict, Iterator, Optional, Set, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))

from harness import REPO  # noqa: E402

APP = REPO / "packages" / "frontend"
SPEC = REPO / ".claude/skills/job-kit-dev/references/front-end/design-system.md"
CSS = APP / "src" / "index.css"
FRONT = REPO / ".claude/skills/job-kit-dev/references/front-end"
CATALOG = FRONT / "index.html"
PREVIEW = FRONT / "preview"

Color = Tuple[str, int, str]  # rrggbb, percent of it, what the rest mixes toward

# --- regex vocabulary -------------------------------------------------------

DECLARATION = re.compile(r"(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);")

_VAR_REF = re.compile(r"^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$")
_HEX8 = re.compile(r"^#([0-9a-fA-F]{8})$")
_HEX6 = re.compile(r"^#([0-9a-fA-F]{6})$")
_HEX3 = re.compile(r"^#([0-9a-fA-F]{3})$")
_MIX = re.compile(
    r"^color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+(\d+(?:\.\d+)?)%\s*,"
    r"\s*(transparent|white|black|#[0-9a-fA-F]{3,8})\s*\)$"
)

_CELL_PLAIN = re.compile(r"^`#([0-9a-fA-F]{3,8})`$")
_CELL_AT = re.compile(r"^`#([0-9a-fA-F]{3,8})`\s*@\s*(\d+(?:\.\d+)?)%$")
_CELL_PLUS = re.compile(r"^`#([0-9a-fA-F]{3,8})`\s*\+\s*(\d+(?:\.\d+)?)%\s*(white|black)$")
_CELL_OVER = re.compile(r"^`#([0-9a-fA-F]{3,8})`\s*(\d+(?:\.\d+)?)%\s*over\s*`#([0-9a-fA-F]{3,8})`$")
_SPEC_TOKEN = re.compile(r"\{colors\.([a-z0-9-]+)\}")

_HREF_SRC = re.compile(r'\b(?:href|src)\s*=\s*"([^"]+)"')
_CSS_IMPORT = re.compile(r'@import\s+"([^"]+)"')
_CSS_URL = re.compile(r'url\(\s*[\'"]?([^\'")]+)[\'"]?\s*\)')
_SKIPPED_SCHEMES = ("http://", "https://", "data:", "mailto:")

# A `#`-looking token is only flagged as a typed color when it is not an HTML
# entity (`&#8217;`) and not the whole value of an href/src fragment link
# (`href="#colors-ink"`, where the `#` sits right after the opening quote).
# This is a heuristic, not a parser: an id that happens to spell a hex word
# (`#dead`) or an entity written some other way could still slip past it, but
# neither shape occurs in this catalog's markup.
_HEX_LITERAL = re.compile(
    r'(?<!&)(?<!=")#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b'
)
_COLOR_FUNCTION = re.compile(r"\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(")

_IFRAME_SRC = re.compile(r'<iframe\b[^>]*\bsrc\s*=\s*"\./preview/([^"]+)"')

_BACKTICKED = re.compile(r"`([^`\n]+)`")
_MARKDOWN_PATH_PREFIXES = ("packages/", "scripts/", "tests/", ".claude/")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def block(css: str, selector: str) -> Dict[str, str]:
    # body: every `--name: value;` inside `selector { ... }`
    opening = re.search(re.escape(selector) + r"\s*\{", css)
    if opening is None:
        return {}
    start = opening.end()
    depth = 1
    end = start
    while end < len(css) and depth > 0:
        if css[end] == "{":
            depth += 1
        elif css[end] == "}":
            depth -= 1
        end += 1
    body = css[start : end - 1]
    return {name: value.strip() for name, value in DECLARATION.findall(body)}


def from_css(value: str, scope: Dict[str, str]) -> Optional[Color]:
    # body: hex (3/6/8-digit) | color-mix(in srgb, X N%, transparent|white|black) | var(--x) via scope
    value = value.strip()

    var_match = _VAR_REF.match(value)
    if var_match is not None:
        name = var_match.group(1)
        if name not in scope:
            return None
        return from_css(scope[name], scope)

    hex8 = _HEX8.match(value)
    if hex8 is not None:
        digits = hex8.group(1)
        alpha = int(digits[6:8], 16)
        return (digits[:6].lower(), round(alpha / 255 * 100), "transparent")

    hex6 = _HEX6.match(value)
    if hex6 is not None:
        return (hex6.group(1).lower(), 100, "transparent")

    hex3 = _HEX3.match(value)
    if hex3 is not None:
        doubled = "".join(character * 2 for character in hex3.group(1).lower())
        return (doubled, 100, "transparent")

    mix = _MIX.match(value)
    if mix is not None:
        base = from_css(mix.group(1).strip(), scope)
        if base is None:
            return None
        target = mix.group(3)
        if target.startswith("#"):
            target = _normalize_hex(target[1:])
        return (base[0], round(float(mix.group(2))), target)

    return None


def _normalize_hex(digits: str) -> str:
    digits = digits.lower()
    if len(digits) == 3:
        return "".join(character * 2 for character in digits)
    return digits[:6]


def from_cell(cell: str) -> Optional[Color]:
    # body: "`#hex`" | "`#hex` @ N%" | "`#hex` + N% white|black" | "`#hex` N% over `#hex`"
    cell = cell.strip()

    plain = _CELL_PLAIN.match(cell)
    if plain is not None:
        return (_normalize_hex(plain.group(1)), 100, "transparent")

    at = _CELL_AT.match(cell)
    if at is not None:
        return (_normalize_hex(at.group(1)), round(float(at.group(2))), "transparent")

    over = _CELL_OVER.match(cell)
    if over is not None:
        return (_normalize_hex(over.group(1)), round(float(over.group(2))), _normalize_hex(over.group(3)))

    plus = _CELL_PLUS.match(cell)
    if plus is not None:
        percent = 100 - round(float(plus.group(2)))
        return (_normalize_hex(plus.group(1)), percent, plus.group(3))

    return None


def color_rows() -> Iterator[Tuple[str, str, str, str]]:
    """(token, css var, theme, cell) for every row whose first cell is a `{colors.*}` token.

    Light/Dark tables compare each column to its theme. Hex tables (Semantic,
    Charts) hold one value for both themes; their Surface/Outline columns map
    to `--<token>-surface` / `--<token>-outline`. A token row in any other
    table shape yields a None cell so the test fails instead of skipping it.
    """
    lines = _read(SPEC).splitlines()
    index = 0
    while index < len(lines):
        if not lines[index].lstrip().startswith("|"):
            index += 1
            continue
        header = [cell.strip().lower() for cell in lines[index].strip().strip("|").split("|")]
        valued = ("light" in header and "dark" in header) or "hex" in header
        index += 2  # header line, then the `| --- |` separator
        while index < len(lines) and lines[index].lstrip().startswith("|"):
            cells = [cell.strip() for cell in lines[index].strip().strip("|").split("|")]
            index += 1
            token_match = _SPEC_TOKEN.fullmatch(cells[0].strip("`"))
            if token_match is None:
                if valued:
                    yield (cells[0], "", "row without a {colors.*} token", "")
                continue
            token = token_match.group(1)
            columns = dict(zip(header, cells))
            if "light" in columns and "dark" in columns:
                yield (token, "--" + token, "light", columns["light"])
                yield (token, "--" + token, "dark", columns["dark"])
            elif "hex" in columns:
                for name, cell in columns.items():
                    suffix = {"hex": ""}.get(name)
                    if suffix is None and name.startswith(("surface", "outline")):
                        suffix = "-" + name.split()[0]
                    if suffix is None:
                        continue
                    for theme in ("light", "dark"):
                        yield (token, "--" + token + suffix, theme, cell)
            else:
                yield (token, "--" + token, "unrecognized table " + "|".join(header), "")


def relative_refs(path: Path) -> Iterator[str]:
    # body: href/src attrs and CSS @import/url() targets that are not http(s):, data:, or #fragment
    text = _read(path)
    if path.suffix == ".css":
        candidates = _CSS_IMPORT.findall(text) + _CSS_URL.findall(text)
    else:
        candidates = _HREF_SRC.findall(text)
    for candidate in candidates:
        candidate = candidate.strip()
        if candidate.startswith(_SKIPPED_SCHEMES) or candidate.startswith("#"):
            continue
        yield candidate


def _node_modules_package(remainder: str) -> str:
    """The dependency name a `.../node_modules/<pkg>/...` reference names."""
    parts = remainder.split("/")
    if parts and parts[0].startswith("@") and len(parts) > 1:
        return parts[0] + "/" + parts[1]
    return parts[0] if parts else remainder


class SpecTests(unittest.TestCase):
    def test_every_spec_token_is_defined(self) -> None:
        root = block(_read(CSS), ":root")
        tokens: Set[str] = set(_SPEC_TOKEN.findall(_read(SPEC)))
        self.assertGreater(len(tokens), 0, "no {colors.*} tokens found in design-system.md")
        for token in sorted(tokens):
            with self.subTest(token=token):
                self.assertIn(
                    "--" + token,
                    root,
                    "design-system.md names {{colors.{0}}}, which is not in "
                    "index.css :root".format(token),
                )

    def test_color_tables_match_css(self) -> None:  # every token row checked, every cell must parse
        css_text = _read(CSS)
        scopes = {"light": block(css_text, ":root")}
        scopes["dark"] = {**scopes["light"], **block(css_text, ".dark")}
        rows = list(color_rows())
        self.assertGreater(len(rows), 0, "no {colors.*} table rows found in design-system.md")
        for token, var_name, theme, cell in rows:
            with self.subTest(token=token, var=var_name, theme=theme):
                self.assertIn(theme, scopes, "{0}: {1}".format(token, theme))
                scope = scopes[theme]
                cell_color = from_cell(cell)
                self.assertIsNotNone(cell_color, "{0} {1}: cannot parse {2!r}".format(token, theme, cell))
                css_value = scope.get(var_name)
                self.assertIsNotNone(css_value, "no {0} in index.css :root/.dark".format(var_name))
                css_color = from_css(css_value, scope)
                self.assertEqual(
                    cell_color,
                    css_color,
                    "{0} {1}: design-system.md says {2!r}, index.css computes "
                    "{3!r} from {4!r}".format(var_name, theme, cell_color, css_color, css_value),
                )


class CatalogTests(unittest.TestCase):
    def test_vars_are_defined(self) -> None:
        # every var(--x) in index.html, preview/*.html, preview.css is in index.css :root or preview.css :root
        preview_css = PREVIEW / "preview.css"
        self.assertTrue(preview_css.exists(), "{0} is missing".format(preview_css))
        index_root = block(_read(CSS), ":root")
        preview_root = block(_read(preview_css), ":root")
        defined: Set[str] = set(index_root) | set(preview_root)

        targets = [CATALOG, preview_css] + sorted(PREVIEW.glob("*.html"))
        for path in targets:
            self.assertTrue(path.exists(), "{0} is missing".format(path))
            text = _read(path)
            used = sorted(
                set(re.findall(r"var\(\s*(--[a-zA-Z0-9-]+)", text))
                | set(re.findall(r'data-token\s*=\s*"(--[a-zA-Z0-9-]+)"', text))
            )
            for name in used:
                with self.subTest(source=path.relative_to(REPO).as_posix(), var=name):
                    self.assertIn(
                        name,
                        defined,
                        "{0} uses var({1}), which is not in index.css :root or "
                        "preview.css :root".format(path.relative_to(REPO).as_posix(), name),
                    )

    def test_shards_type_no_colors(self) -> None:
        # no #hex, rgb(, hsl(, oklch( in index.html or preview/*.html — values come from tokens or data-token
        targets = [CATALOG] + sorted(PREVIEW.glob("*.html"))
        for path in targets:
            self.assertTrue(path.exists(), "{0} is missing".format(path))
            text = _read(path)
            hex_literals = _HEX_LITERAL.findall(text)
            color_functions = _COLOR_FUNCTION.findall(text)
            with self.subTest(source=path.relative_to(REPO).as_posix()):
                self.assertFalse(
                    hex_literals or color_functions,
                    "{0} types a color literal directly: {1}".format(
                        path.relative_to(REPO).as_posix(), hex_literals + color_functions
                    ),
                )

    def test_preview_css_types_no_hex(self) -> None:
        # preview.css may hold the one rgb() shadow; a hex there would be a restated token
        text = _read(PREVIEW / "preview.css")
        self.assertEqual(_HEX_LITERAL.findall(text), [], "preview/preview.css types a hex color")

    def test_shards_link_shared_files(self) -> None:
        # a shard without preview.css renders with no tokens; without shard.js it never sizes or themes
        for path in sorted(PREVIEW.glob("*.html")):
            text = _read(path)
            with self.subTest(source=path.name):
                self.assertIn('href="./preview.css"', text)
                self.assertIn('src="./shard.js"', text)

    def test_font_stacks_match_theme(self) -> None:
        # preview.css --font-sans/--font-mono/--font-logo == index.css @theme inline values
        preview_css = PREVIEW / "preview.css"
        self.assertTrue(preview_css.exists(), "{0} is missing".format(preview_css))
        theme = block(_read(CSS), "@theme inline")
        preview_root = block(_read(preview_css), ":root")
        for name in ("--font-sans", "--font-mono", "--font-logo"):
            with self.subTest(token=name):
                theme_value = theme.get(name)
                preview_value = preview_root.get(name)
                self.assertIsNotNone(theme_value, "{0} has no {1}".format(CSS, name))
                self.assertIsNotNone(preview_value, "{0} has no {1}".format(preview_css, name))
                normalize = lambda text: " ".join(text.split())  # noqa: E731
                self.assertEqual(normalize(preview_value), normalize(theme_value))

    def test_links_resolve(self) -> None:
        # each relative ref exists on disk; a …/node_modules/<pkg>/… ref instead requires <pkg> in
        # packages/frontend/package.json dependencies (CI does not install app deps)
        package_json = json.loads(_read(APP / "package.json"))
        dependencies: Set[str] = set(package_json.get("dependencies", {}).keys())

        targets = [CATALOG] + sorted(PREVIEW.glob("*.html")) + [PREVIEW / "preview.css"]
        for path in targets:
            self.assertTrue(path.exists(), "{0} is missing".format(path))
            for ref in relative_refs(path):
                with self.subTest(source=path.relative_to(REPO).as_posix(), ref=ref):
                    if "/node_modules/" in ref:
                        _, _, remainder = ref.partition("/node_modules/")
                        package = _node_modules_package(remainder)
                        self.assertIn(
                            package,
                            dependencies,
                            "{0} references node_modules package {1!r}, which is not "
                            "in packages/frontend/package.json dependencies".format(
                                path.relative_to(REPO).as_posix(), package
                            ),
                        )
                        continue
                    resolved = (path.parent / ref).resolve()
                    self.assertTrue(
                        resolved.exists(),
                        "{0} references `{1}`, which resolves to {2} and does not "
                        "exist".format(path.relative_to(REPO).as_posix(), ref, resolved),
                    )

    def test_every_shard_is_listed(self) -> None:
        # {preview/*.html} == {iframe src in index.html}
        self.assertTrue(CATALOG.exists(), "{0} is missing".format(CATALOG))
        on_disk = {path.name for path in PREVIEW.glob("*.html")}
        listed = set(_IFRAME_SRC.findall(_read(CATALOG)))
        self.assertEqual(
            on_disk,
            listed,
            "preview/*.html on disk and index.html <iframe src> listing disagree: "
            "only on disk {0}; only listed {1}".format(
                sorted(on_disk - listed), sorted(listed - on_disk)
            ),
        )

    def test_markdown_paths_exist(self) -> None:
        # backticked repo paths in design-system.md and assets/*.md exist
        sources = [FRONT / "design-system.md"] + sorted((FRONT / "assets").glob("*.md"))
        for path in sources:
            self.assertTrue(path.exists(), "{0} is missing".format(path))
            for token in _BACKTICKED.findall(_read(path)):
                token = token.strip()
                if "/" not in token or not token.startswith(_MARKDOWN_PATH_PREFIXES):
                    continue
                with self.subTest(source=path.relative_to(REPO).as_posix(), token=token):
                    self.assertTrue(
                        (REPO / token).exists(),
                        "{0} names `{1}`, which is not on disk".format(
                            path.relative_to(REPO).as_posix(), token
                        ),
                    )


if __name__ == "__main__":
    unittest.main()

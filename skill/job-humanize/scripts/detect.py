#!/usr/bin/env python3
"""Flag job-humanize tells. Phrases and the sentence limit are read from ../SKILL.md: one home.

Usage: python3 detect.py [--allow-dashes] [--max-words N] [FILE ...]   (no FILE reads stdin)
Exit: 0 clean, 1 tells found, 2 usage error.
"""
from __future__ import annotations

import argparse, re, sys
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / "SKILL.md"
GAP = r"[^.!?\n]{1,80}?"  # what X, Y, Z, or … stand for
PLACEHOLDERS = ("X", "Y", "Z", "…")
SHORT = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "nor", "of", "on", "or", "the", "to", "vs", "with"}
BLOCK = r"[ \t]*(?:#|[-*+][ \t]|\||\d+\.[ \t])"
SENTENCE_END = re.compile(rf"(?<=[.!?])\s+|\n\s*\n|\n(?={BLOCK})")
BOLD_LABEL = re.compile(r"^[ \t]*(?:[-*+]|\d+\.)[ \t]+(\*\*[^*\n]+\*\*)", re.M)
HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$", re.M)
EMOJI = re.compile("[\U0001F300-\U0001FAFF\u2600-\u27BF]")
MASKED = re.compile(r"```.*?(?:```|\Z)|`[^`\n]*`|https?://[^\s)]*[^\s).,;:!?'\"]", re.S)


def phrase_regex(phrase: str) -> re.Pattern:
    parts = [t for t in re.split(r"(\b[XYZ]\b|…)", phrase.replace("\u2019", "'").replace("\u2018", "'")) if t]
    while parts and parts[0] in PLACEHOLDERS:
        parts.pop(0)
    while parts and parts[-1] in PLACEHOLDERS:
        parts.pop()
    if parts:
        parts[0] = parts[0].lstrip()
        parts[-1] = parts[-1].rstrip()
    core = "".join(parts).strip()
    if re.fullmatch(r"[A-Za-z0-9-]+", core):  # one word: any inflection
        body = re.escape(core[:-1] if core.endswith("e") else core) + r"\w*"
        post = ""
    else:
        body = "".join(GAP if t in PLACEHOLDERS else r"\s+".join(map(re.escape, re.split(r"\s+", t))) for t in parts)
        post = r"(?!\w)" if re.search(r"\w$", core) else ""
    pre = r"(?<!\w)" if re.match(r"\w", core) else ""
    return re.compile(pre + body + post, re.I)


def load_skill(path: Path = SKILL) -> tuple[list[tuple[str, re.Pattern]], int]:
    text = path.read_text(encoding="utf-8")
    section = re.search(r"^## Tells to remove\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    limit = re.search(r"over about (\d+) words", text)
    if not section or not limit:
        raise ValueError(f"{path} needs a '## Tells to remove' section and 'over about N words'")
    items, current = [], None
    for line in section.group(1).splitlines():
        if line.startswith("- "):
            current = [line]
            items.append(current)
        elif current is not None and line.startswith((" ", "\t")) and line.strip():
            current.append(line)
        else:
            current = None
    phrases = []
    for item in items:
        for quoted in re.findall(r'"([^"]+)"', " ".join(item)):
            phrase = " ".join(quoted.split())
            phrases.append((phrase, phrase_regex(phrase)))
    return phrases, int(limit.group(1))


def mask(text: str) -> str:
    return MASKED.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def scan(text: str, *, allow_dashes: bool = False, max_words: int | None = None) -> list[tuple[int, int, str, str]]:
    text = mask(text.replace("\u2019", "'").replace("\u2018", "'"))
    starts = [0] + [m.end() for m in re.finditer(r"\n", text)]

    def pos(i: int) -> tuple[int, int]:
        line = sum(1 for s in starts if s <= i)
        return line, i - starts[line - 1] + 1

    hits = []

    def add(i: int, kind: str, match: str) -> None:
        hits.append((*pos(i), kind, match))

    spans = sorted({(m.start(), m.end()) for _, rx in load_skill()[0] for m in rx.finditer(text)},
                   key=lambda s: (s[0], -s[1]))
    end = -1
    for a, b in spans:
        if b <= end:  # inside a longer hit: one tell, not two
            continue
        add(a, "phrase", text[a:b])
        end = b
    if not allow_dashes:
        for m in re.finditer("[\u2014\u2013]", text):
            add(m.start(), "dash", m.group(0))
    if max_words:
        bounds = [0] + [e for m in SENTENCE_END.finditer(text) for e in (m.start(), m.end())] + [len(text)]
        for a, b in zip(bounds[::2], bounds[1::2]):
            words = [w for w in text[a:b].split() if re.search(r"\w", w)]
            if len(words) > max_words:
                first = re.search(r"\S", text[a:b])
                add(a + first.start(), "long-sentence", " ".join(words[:6]) + f"… ({len(words)} words)")
    for m in BOLD_LABEL.finditer(text):
        add(m.start(1), "bold-label", m.group(1))
    for m in HEADING.finditer(text):
        title = m.group(2)
        words = title.split()[1:]
        rest = [w for w in words if w.lower() not in SHORT]
        if len(words) >= 2 and len(rest) >= 2 and all(w[0].isupper() for w in rest):
            add(m.start(2), "title-case", title)
        emoji = EMOJI.search(title)
        if emoji:
            add(m.start(2) + emoji.start(), "heading-emoji", emoji.group(0))
    return sorted(hits, key=lambda h: h[:2])


def report(name: str, text: str, allow_dashes: bool, max_words: int | None) -> list[str]:
    hits = scan(text, allow_dashes=allow_dashes, max_words=max_words)
    out = [f'{name}:{ln}:{col}: {kind}: "{" ".join(match.split())}"' for ln, col, kind, match in hits]
    para, tells, first, prev_blank = 0, {}, {}, True
    for n, line in enumerate(text.splitlines(), 1):
        if line.strip():
            if prev_blank:
                para += 1
                first[para] = n
            for ln, _, kind, match in hits:
                if ln == n and kind == "phrase":
                    tells.setdefault(para, set()).add(" ".join(match.lower().split()))
        prev_blank = not line.strip()
    for p, found in sorted(tells.items()):
        k = len(found)
        out.append(f"paragraph {p} (line {first[p]}): {k} {'tell' if k == 1 else 'tells'}")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Flag job-humanize tells.")
    try:
        limit = load_skill()[1]
    except ValueError as e:
        print(f"detect.py: {e}", file=sys.stderr)
        return 2
    ap.add_argument("--allow-dashes", action="store_true", help="do not flag em/en dashes")
    ap.add_argument("--max-words", type=int, default=limit, help="sentence limit; 0 disables")
    ap.add_argument("files", nargs="*", metavar="FILE")
    args = ap.parse_args(argv)
    if args.max_words < 0:
        ap.error("--max-words must be 0 or more")
    inputs = []
    for name in args.files or ["<stdin>"]:
        try:
            raw = sys.stdin.buffer.read() if name == "<stdin>" and not args.files else Path(name).read_bytes()
        except OSError as e:
            print(f"detect.py: {e}", file=sys.stderr)
            return 2
        inputs.append((name, raw.decode("utf-8", errors="replace")))
    lines = [l for name, text in inputs for l in report(name, text, args.allow_dashes, args.max_words or None)]
    if lines:
        sys.stdout.buffer.write(("\n".join(lines) + "\n").encode("utf-8"))
    return 1 if lines else 0


if __name__ == "__main__":
    sys.exit(main())

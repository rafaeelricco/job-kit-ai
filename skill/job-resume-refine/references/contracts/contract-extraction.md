# Contract (PDF extraction evaluator)

This is the authoritative contract for `./scripts/evaluate_pdf.py`. It is a
read-only check of a compiled resume PDF. It does not edit the PDF, source,
Facts, package, or profile, and it never installs tools or uses OCR. It checks
extracted text against a source-grounded manifest; it cannot prove whether a
PDF text object is visually hidden. Manifest construction, source comparison,
and visual review own that visibility check. PDF metadata, annotations, hidden
text, and other non-visible coverage never count as intentional coverage.

## Invocation and dependencies

Run it with the first available Python 3 launcher:

```text
python3 ./scripts/evaluate_pdf.py /abs/resume.pdf < expected.json
```

On Windows use `py -3` when available. The evaluator uses only the Python
standard library and the installed Poppler `pdftotext` executable. It runs
`pdftotext` twice against the same PDF: once in default mode and once with
`-layout`. The modes are required checks of one engine, not independent
implementations. It must not use OCR, a PDF parser package, or an installer.

The expected manifest is read from stdin. It is created from the source and
Facts before compilation; it is never inferred from extracted text. It must
describe the complete visible inventory expected in the PDF, including
headings, identity, Summary, role headers, every immutable base bullet,
optional Technologies lines, Skills rows, and education. Immutable base
bullets use stable IDs that remain unchanged across a refinement run. Only
editable allowed blocks may change between the baseline manifest and a
per-vacancy manifest.

## Expected manifest

The complete input object is:

```json
{
  "schema_version": 1,
  "blocks": [{ "id": "summary", "parts": ["non-empty expected visible text"] }],
  "terms": ["exact supported posting term"]
}
```

`schema_version` is the integer `1`. `blocks` is non-empty. Each block has a
non-empty string `id` and a non-empty `parts` array containing only non-empty
strings; block IDs are unique. `terms` is an array of non-empty strings. Terms
are deduplicated for coverage counts while preserving their first-seen order;
`terms: []` is valid and reports term coverage as `n/a`, never as an ATS score.
Unknown keys, malformed JSON, invalid UTF-8, empty IDs, empty parts, or empty
terms are input errors. The evaluator must retain the validated complete
manifest in the top-level result under `expected`.

`terms` contains the exact supported posting terms selected for this compiled
artifact. Supported terms omitted by fit remain requirement-coverage gaps in
`match-report.md`; they are not added to the final manifest merely to force an
extraction failure.

Blocks are ordered groups. All blocks must occur in expected order in the
extracted body. Parts within one block may occur in any order, but each part
must be assigned to a non-overlapping occurrence. Different parts may have
overlapping text and still need separate occurrences. A Summary match cannot
mask a missing, damaged, or misplaced role header, bullet, or other block.
Missing, reordered, duplicated-when-a-distinct-occurrence-is-required, or
damaged expected content is `FAIL`.

## Matching rules

For block bodies, compare NFC-normalized text with whitespace runs and line
breaks folded to one space, plus matching quote and dash variants. Ordinary
whitespace folding can pass when the normalized body matches; it must never
join arbitrary separated words. A source-grounded discretionary line-break
hyphen may be ignored when a word is split at a line break; a real source
hyphen remains required. Known Unicode ligatures U+FB00 through U+FB06
(`ﬀ`, `ﬁ`, `ﬂ`, `ﬃ`, `ﬄ`, `ﬅ`, `ﬆ`) may be expanded for body comparison with a
ligature warning. Missing content, damaged words, or wrong order still fails.
Record normalization-dependent body matches in diagnostics. Exact terms allow
NFC and ordinary whitespace wrapping, but never ligature expansion,
dehyphenation, or joining/splitting words to establish a hit.

Terms use literal case-folded matching with exact technical punctuation and
word boundaries. `C++` and `C#` cannot satisfy `C`; `R&D` cannot satisfy `R`;
ligature expansion, dehyphenation, or whitespace repair cannot satisfy a
missing term. A term is matched only as the requested literal term, with its
case ignored. Broken-spacing diagnostics may locate a relaxed match, but it
never counts as recovered content or an exact-term hit. Include the block or
term, page, and excerpt when the location is available.

Control characters other than tab, LF, CR, and form feed in extracted PDF text
make that completed mode `FAIL`; they are never silently removed. The same
invalid controls in the expected JSON are an input `ERROR`. Unicode
replacement characters, private-use characters, and explicit ligatures are
warnings unless they cause expected content to be missing or damaged. Every
warning remains in diagnostics. A warning does not turn a complete successful
check into `FAIL`; missing content does.

## Verdicts and exit status

Each mode checks all ordered blocks and all terms. A mode is `PASS` only when
all its blocks and terms match. The aggregate is `PASS` only when both modes
pass. A completed check with a mismatch is `FAIL`. Input, file, encoding,
Poppler, tool, or timeout failures are `ERROR`. Exit status is `0` for `PASS`,
`1` for `FAIL`, and `2` for `ERROR`.

## Output JSON

Write one JSON object to stdout and no prose. Its shape is:

```json
{
  "schema_version": 1,
  "verdict": "PASS",
  "pdf_sha256": "lowercase hexadecimal SHA-256",
  "expected": {
    "schema_version": 1,
    "blocks": [{ "id": "summary", "parts": ["..."] }],
    "terms": []
  },
  "tool": { "name": "pdftotext", "version": "string or null" },
  "modes": {
    "default": {
      "verdict": "PASS",
      "blocks": { "recovered": 1, "total": 1 },
      "terms": { "matched": 0, "total": 0 },
      "issues": []
    },
    "layout": {
      "verdict": "PASS",
      "blocks": { "recovered": 1, "total": 1 },
      "terms": { "matched": 0, "total": 0 },
      "issues": []
    }
  },
  "issues": []
}
```

The top-level `expected` is the complete validated manifest, not a shortened
summary. `tool.name` is always `pdftotext`; `tool.version` is the detected
version string or `null` when it cannot be read. Each mode has its own verdict,
block counts, term counts, and issue list. An issue has `severity`, `code`, and
`message`, and may include `block_id`, `term`, `page`, and `excerpt` when
applicable. Aggregate issues identify their `mode`; a mode-local issue does
not need a duplicate aggregate copy. Include page and excerpt diagnostics when
the location is available. Keep warnings in `issues` even with `PASS`.

The top-level verdict is `ERROR` when either required mode cannot complete due
to input, tool, file, encoding, or timeout failure. Otherwise it is `FAIL`
when a completed mode fails, and `PASS` only when both modes pass all blocks and
terms.

## Source and design rationale

The evaluator follows Poppler's `pdftotext` behavior and keeps layout mode as a
second extraction view. These references explain the extraction tradeoffs and
why source comparison remains a separate check:

- [Poppler `pdftotext` manual](https://manpages.debian.org/testing/poppler-utils/pdftotext.1.en.html)
- [pdfminer.six text conversion notes](https://pdfminersix.readthedocs.io/en/latest/topic/converting_pdf_to_text.html)
- [pypdf text extraction guide](https://pypdf.readthedocs.io/en/stable/user/extract-text.html)

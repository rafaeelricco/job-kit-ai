# worker-extract

Caller hands one or more excerpts, inline or in the one slice file the brief names: dossier slice (Posting facts + `## The role` +
frontmatter `company` / `title` / `url` / `score`) or one supplied posting body
already in the brief. Never fetch a URL.

Use `./references/schemas/schema-state.md` for the output schema.

## Deltas

1. Open only the files the brief names; run no script, write no file. Those excerpts and the JobProfile schema are the whole evidence set.
2. For each excerpt emit one JobProfile. A dossier excerpt carries `job`, already
   copied from Posting facts and frontmatter: keep its filled keys, fill only
   `languages_required` / `languages_preferred` (moving a human-language name out
   of `required_skills`), `preferred_skills`, and `domain` from `role`. A posting
   body (with structured facts if supplied): build only JobProfile keys. Use
   the full supplied body for requirements. Omit compensation terms from
   skill, language, and domain fields. Facts `—` → `null` / `[]`.
   A token absent from the excerpt stays absent.
   `languages_required` / `languages_preferred` items are `{name, level}` (`level` null when unprinted).

3. Do not emit `match_score`, `decision`, `strengths`, `gaps`, or `blockers`.
4. Emit the JSON array in input order. Preserve a failed excerpt's position with
   a `null` row so the caller can record its gap and pair the remaining rows.

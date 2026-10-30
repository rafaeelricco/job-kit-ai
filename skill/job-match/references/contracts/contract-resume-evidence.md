# ResumeEvidence v1

Read-only diagnostic shared by job-match and job-resume-review. It never changes scoring inputs or ResumeGuidance v1.

The caller owns a trusted case:

- target: non-empty job URL, reviewed artifact path, or posting:<selected ordinal> when an ad-hoc posting has no URL.
- requirements: [{id, kind, text}], with unique IDs and kind required, preferred, or unclassified.
- sources: [{id, origin, kind, location, text}], with unique IDs; origin cv, profile, or user; kind achievement, summary, skill, or limitation.
- cv_assessed: boolean, true only after inspecting complete CV content.

Keep exact source text and source field locations. CV sources are inspected visible content, not hidden PDF text. Achievement means an experience/project description or corroborated story Fact; its quality and relevance still require judgment. Namespace CV IDs and Profile IDs separately. A limitation source is a caller-supplied explicit negative fact; missing corroboration, a posting demand, and a never_say restriction alone are not evidence that the candidate lacks a skill.

Each worker assessment is {target, requirements: [row]}, where a row is {requirement_id, support, source_ids, cv_visibility, question}. Return one row for every trusted requirement in the same order; never change or deduplicate the caller's IDs. Match preserves existing requirement occurrences; review preserves its current deduplication rule.

support is direct, partial, listed_only, unresolved, or confirmed_unmet. Direct/partial require an achievement source. Listed-only requires summary or skill evidence, with no achievement/limitation substituted for it. Confirmed-unmet requires an explicit limitation source. Absence of evidence alone stays unresolved. Partial, listed-only, and unresolved rows require a specific resolving question; elsewhere question may be null.

Judge support against the stated requirement, separately from writing quality, quantified outcomes, and CV visibility. Direct means the supplied work demonstrates the requirement; partial means it demonstrates only part of the stated scope. Missing metrics, a public repository, or an outcome do not downgrade demonstrated work unless the requirement asks for them. Do not add production, administration, or ownership conditions that the posting does not state. Where production use is required but unclear, ask about production use and the candidate's contribution, without requiring cluster administration or leadership. Individual implementation or design work alone does not establish influence over others or team leadership; ask about that scope instead of inferring it.

cv_visibility is explicit, implicit, absent, or unassessed. It must be unassessed when cv_assessed is false. Visibility concerns the declared supporting evidence, not keyword presence alone. Explicit/implicit require a cited CV source; direct/partial support additionally requires a CV achievement source, so a skill-list mention cannot make a private achievement visible. Absent requires complete CV inspection and no supporting CV source. A Profile achievement cannot establish CV visibility or increase CV alignment credit.

For wording visibility, explicit means the required capability term or a standard lexical alias actually appears in the cited CV content, including material conditions such as production use. Implicit means the work demonstrates the capability without that wording. A related tool, workflow name, or activity alone is not a lexical alias for a broader capability. Judge the complete stated requirement, not an isolated keyword. Direct support can have implicit wording and retain its existing alignment credit; the diagnostic action only clarifies how to describe verified work naturally, without keyword stuffing.

Wording recommendations must preserve the entities, relationships, and scope established by the cited evidence. Do not infer a connection from nearby facts; ask to confirm an unstated connection before recommending it as CV wording.

The validator owns primary actions:

```text
confirmed_unmet -> report_gap
unresolved -> confirm
listed_only -> request_example
partial -> clarify_scope
direct + unassessed -> inspect_cv
direct + absent -> surface_fact
direct + implicit -> clarify_wording
direct + explicit -> keep
```

Invoke resume_evidence.py with one JSON object on stdin: {"cases": [trusted case], "assessments": [worker assessment]}. Output is {"valid": [validated case], "invalid": [{"target", "errors"}]}; exit 0 if all validate, else 1. The script adds schema_version 1, trusted requirement text/kind, primary action, and full trusted source citations to valid rows. Invalid cases do not discard valid peers. Workers never provide replacement quotations, new source content, scores, apply verdicts, or resume rewrites. Reports expand quotations and locations only from validated trusted citations, and may render action codes as plain next steps. Validation checks provenance and structure, not semantic truth.

Every reported evidence link must resolve to an exact trusted location and a verbatim contiguous excerpt, inline or through a source legend. For Profile sources include the file, role/project identifier, and field index; for CV sources include the existing section/bullet location. A company name or source ID alone is insufficient. Do not insert ellipses inside quotations or replace the trusted wording with a paraphrase. Check that locations and excerpts remain present in the final report.

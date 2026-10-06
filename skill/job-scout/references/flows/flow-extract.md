# Job scout — extract

Batches of 5, one URL at a time, same host serialized. Listed URLs only. No page → no field.

Open the full posting before copying: expand every collapsed or truncated
block ("read more" / "show more" / accordions) and scroll to the end. A JD
still truncated after expansion → `status=uncertain`, never partial facts.

A posting that redirects to another posting → replace the row's URL with the
landed canonical URL (`location.href`, else `link[rel=canonical]`), re-normalize
per `job-store/references/schemas/schema-dossier.md`, and fold it into an
existing row for that URL before persisting. A redirect that lands on a board
index or listing rather than one posting is `dead` below and is never
canonicalized: the row keeps its pre-redirect URL, so a closure log can land on
the dossier that URL owns. A posting folded to another URL on an earlier run
owns no dossier under its pre-fold URL; that closure waits for the refresh read
of the folded URL.

`apply_url` is the normalized href of the posting's apply control (`—` when
none). When its host is an ATS family per
`job-store/references/schemas/schema-dossier.md` "ATS family", its path names
one posting — Ashby and Lever `/{board}/{id}`, Greenhouse `/{board}/jobs/{id}` —
and the row's URL host is not, replace the row's URL with the normalized
`apply_url` and fold as above; persist follows the schema's re-run row for a
folded URL so the dossier the aggregator URL owns keeps its filename and log.
A family host with any other path (a board root or listing) stays in
`apply_url` only; the row's URL is unchanged.

`### Verified`: search columns plus schema Posting facts keys except `eligibility`, `ats`, `match_score`, `match_decision`, and `match_confidence`, and `status_reason`, `role_snapshot`, `role_do`, `role_must`. `eligibility_evidence` is the one printed sentence that says where the hire may live or be employed from (`Remote, anywhere in Canada`, `must reside in South America`); `—` when none is printed. Never compose it from two places.

Before gate, run `job-store/scripts/validate_extract.py` from the job-store skill root — launcher as `job-store/references/schemas/schema-dossier.md` "URL normalize" — with `{"rows": [<one object per Verified row, url plus every Posting facts key>]}` on stdin. It prints `{"rows": [{"url", "errors": [...]}]}` in the same order, or `{"validate_error": …}` with exit 1. A row with a non-empty `errors` list → Gaps `extract invalid: {first error}`, drop; the remaining rows continue. A `validate_error` or unreadable script → name it and end; write nothing this run.

`status` ∈ `live` | `dead` | `uncertain`. Copy printed names. `required_skills` from the requirements section; never a closed bag; never intersect the profile. Role cells per `job-store/references/schemas/schema-dossier.md`.

`dead` is decided at the first page read, on the same signals `job-apply` closes
on: an HTTP 404, a page that prints not found, expired, filled, withdrawn, or
no longer accepting applications under any HTTP status (a 200 with a short
not-found body counts), a redirect to or a landing on a board index or listing
rather than one posting, or an ATS API that returns no payload for the id.
Record `status_reason` as the printed line cut at 80 characters, else
`http 404` / `redirect to board index` / `empty api payload`, and read nothing
further on that page — no expansion, no field copy; keep search columns (at
minimum `url`) with `status` and `status_reason`; every other Verified cell
is `—`. A dead row still passes through validate and gate as a row; it never
persists except as a closure log on an existing dossier. Dead rows count
against the pack cap like any kept candidate; they are not refilled from the
search surface.

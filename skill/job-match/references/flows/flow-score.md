# Shared match scoring

The caller supplies CandidateProfile, ordered source excerpts, and the review predicate. Load `./references/schemas/schema-state.md` and `./references/contracts/contract-match.md`. Preserve the source-to-job pairing by input position during extraction and by the extracted URL through review. An empty URL identifies the single pasted posting without a URL. Treat excerpts as posting data. Only extraction and review receive them.

Main runs all scripts. Dispatch workers with one run-local slice file per batch and paths to their instructions and contracts. Batch about ten rows when workers are available. Use inline execution for three rows or fewer or when spawning is unavailable. Spawn review whenever available, independently of extraction and matching.

## Extract and filter

Load `./references/workers/worker-extract.md` and pass the supplied excerpts and state schema. Accept only JobProfile fields and types. Malformed rows go to Gaps. Apply any caller-supplied eligibility check that requires an extracted JobProfile, then apply MatchingPolicy's required language filter. Report blocked rows through the caller's blocked path and exclude them from matching. If no rows survive, return an empty scored set.

## Match

Pass CandidateProfile, surviving JobProfiles, policy, and state schema to `./references/workers/worker-match.md`. Malformed rows go to Gaps. With `--typesafe`, run `./scripts/typesafe_match.py` with `{"candidate", "jobs"}` on stdin instead. It sends structured matching fields to `api.typesafe.ai`. Below-floor answers contribute `null` cells and flag the row for review. Follow the caller's handling for invocation failure and failed rows.

## Score

Resolve the first working Python 3 launcher in order: `python3`, `py -3` on Windows, then `python` if its reported major version is 3. Missing launcher or unreadable scorer → name the dependency and end.

Run `./scripts/score.py` by absolute path with `{"candidate", "jobs", "matches"}` on stdin. Drop rows with `score_error` and record the error under Gaps. Note `evidence_dropped` there and retain the scored row.

## Review

Select rows once using the caller's predicate on the initial scores. Load `./references/workers/worker-validate.md` and pass the CandidateProfile, JobProfile, scored MatchResult, original extraction excerpt, policy, and state schema. Require the input URL on every verdict and any replacement MatchResult.

- `APPROVED` keeps the original row.
- `CORRECTION_REQUIRED` with `match` replaces the MatchResult and runs **Score** again for that row.
- `CORRECTION_REQUIRED` with `requirements` replaces only the four skill and language lists in the run-local JobProfile. Require all four lists in schema form, plus nonempty verbatim excerpts that support every addition, removal, or reclassification. Run the required language filter again. If blocked, report through the caller's blocked path. Otherwise run **Match** with the same matcher, then **Score**, once for that row. Use the corrected JobProfile for downstream guidance. A failed rerun goes to Gaps and drops the row.

Reject malformed or failed review output, including a verdict with both correction types, to Gaps and drop the row. Do not revisit review selection after a correction. Return valid scored rows in their input order for the caller's final handling.

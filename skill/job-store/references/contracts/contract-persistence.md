# Job store — persistence lock

Shared filesystem transaction for job-scout, job-prep, job-apply, job-inbox, and job-outreach.
Dossier shape, ownership, and writer-specific mutations remain in
`job-store/references/schemas/schema-dossier.md`.

1. Resolve `scout/jobs` through its deepest existing ancestor. STOP unless its
   physical path remains under canonical Profile root; only then create it.

2. Lock by normalized URL at `url-{digest}.lock`, where digest is the first
   32 lowercase SHA-256 hex characters of the UTF-8 URL.

3. Acquire with exclusive `mkdir`; immediately write a unique owner token to `owner`.
   A lock ≤15 minutes old retries at most 5 times/~10 seconds. A stale lock is
   reclaimed once. Permanent filesystem errors STOP.

4. Re-check owner, then re-scan every dossier by normalized URL under the lock.
   Multiple matches STOP, and so does a file whose `url` will not read or
   normalize, because it could be this URL's twin. Any other parse failure is
   named under Gaps and blocks no write. A file that still matches this URL is
   its dossier, and step 5 refuses a render that stays malformed.

5. Render the complete result into `.lock/place-{owner}.md`. Never open the
   final dossier path for writing. Pipe `{"paths": ["<place file>"]}` to
   `job-store/scripts/validate_dossier.py` (launcher per
   `job-store/references/schemas/schema-dossier.md` "URL normalize"). Any
   error, a `validate_error`, or an unreadable script → delete the place file,
   release, and STOP naming each error. The dossier stays as it was.

6. Re-check owner. Update uses atomic `mv`. Create uses hard-link then unlink;
   a taken name retries `-2`, `-3`. Never use `mv -n`.

7. Release only when the lock's owner still matches. Otherwise leave it untouched.

Owner loss, missing stage, or non-collision commit failure → STOP without
re-rendering. Never create or rename a dossier without its URL lock.

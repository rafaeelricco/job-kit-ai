# Resume Check MCP server: specification

Status: release 1 deployed on 2026-11-27 at the D-1 URL. D-1 was changed to
a path on the apex at the owner's request; the other decisions remain defaults.

## Goal

Publish a remote MCP server, **Resume Check**, that exposes Job Kit's
deterministic resume checks to AI assistants, running on the `r1cco.com` VPS
and deployed today over `ssh root@r1cco.com`. The server must be usable as a
custom connector in Claude and ChatGPT on day one, and meet the listing
requirements of the Claude connector directory and the ChatGPT and Codex
plugin directory.

Intended users: a job seeker who asks an assistant to check a resume file
before applying, and directory reviewers who test each tool.

What it does: the assistant sends a resume file to the server and gets back
the parsing risks a page view hides (no text layer, hidden text, contact
details only in a header, broken characters). The assistant rates the resume
against the Job Kit rubric, and the server computes the score, so the
arithmetic is the same on every host.

Authoritative sources:

| Topic                     | Source                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| File scan contract        | [`skill/job-resume-review/scripts/scan_cv.py`](skill/job-resume-review/scripts/scan_cv.py)            |
| Score contract            | [`skill/job-resume-review/scripts/review_score.py`](skill/job-resume-review/scripts/review_score.py)  |
| Rubric                    | [`skill/job-resume-review/references/rubric.md`](skill/job-resume-review/references/rubric.md)        |
| Release packaging         | [`scripts/package_release.py`](scripts/package_release.py)                                            |
| Claude connector review   | <https://claude.com/docs/connectors/building/review-criteria>                                         |
| Claude submission         | <https://claude.com/docs/connectors/building/submission>                                              |
| Claude file arguments     | <https://claude.com/docs/connectors/building/files>                                                   |
| OpenAI plugin submission  | <https://developers.openai.com/plugins/deploy/submission>                                             |
| OpenAI plugin package     | <https://developers.openai.com/plugins/build/plugins>                                                 |
| OpenAI file parameters    | <https://developers.openai.com/apps-sdk/reference/>                                                   |

All external pages were read on 2026-11-27. Review rules change; re-read the
submission pages before each submission.

## Tracking

- IDs are stable. `FR-n` is a behavior group, `FR-n.m` one criterion, `NFR-n`
  one guarantee. Never renumber or reuse an ID; record removed IDs here.
- `[ ]` means not yet verified. It does not necessarily mean absent. Check a
  box only after observing the behavior, not after writing the code.
- **(R1)** marks what today's release needs. Unmarked items are follow-ups.
- Removed IDs: none.

## Proposed decisions

Each is a default chosen to make a one-day build possible. Change them here
first; requirements below refer to them by ID.

| ID  | Decision                | Default                                                                                                    | Why it matters                                                                                                                                  |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | Public endpoint         | `https://r1cco.com/job-kit-ai/mcp`, pages under `https://r1cco.com/job-kit-ai/`                            | OpenAI does not let a published plugin change its MCP URL without support. The apex already has DNS and TLS, so no new record or certificate.   |
| D-2 | Code location           | A top-level `mcp/` directory in this repository                                                            | `package_release.py` ships only `LICENSE`, `skill/` and `scripts/`, so the server stays out of skill releases.                                  |
| D-3 | Tools                   | `get_review_rubric`, `score_resume_review`, `scan_resume_url`, `scan_resume_file`                          | Tool names and schemas are scanned and approved by the directories. Later changes are held until re-approved.                                   |
| D-4 | Authentication          | None                                                                                                       | No tool acts on a user account. Both directories accept unauthenticated servers.                                                                |
| D-5 | Interactive UI          | None in release 1                                                                                          | A UI adds a content security policy, screenshots and extra review. It is the first follow-up.                                                   |
| D-6 | Scan by public URL      | Included (`scan_resume_url`)                                                                               | Works on every MCP host and gives reviewers a testable path. Risk: a reviewer may read it as a general fetch tool. FR-6 limits it.              |
| D-7 | Publisher identity      | Rafael Ricco, individual                                                                                   | OpenAI rejects a listing whose publisher name is not a verified identity.                                                                       |
| D-8 | Per-address rate limit  | 30 requests per minute                                                                                     | A number chosen for a small VPS, not measured.                                                                                                  |

## Functional requirements

### FR-1 MCP endpoint

- [x] FR-1.1 **(R1)** The D-1 URL speaks MCP over Streamable HTTP. From MCP
      Inspector, `initialize`, `tools/list` and `tools/call` all succeed.
- [x] FR-1.2 **(R1)** The server is stateless. A `tools/call` succeeds with no
      earlier request from the same client, and after a service restart.
- [x] FR-1.3 **(R1)** Every tool is callable with no credentials (D-4).
- [x] FR-1.4 **(R1)** `tools/list` returns exactly the D-3 tools.
- [x] FR-1.5 **(R1)** Every tool has a `title`, a description, an
      `inputSchema`, an `outputSchema` and `readOnlyHint: true`.
- [x] FR-1.6 **(R1)** Every tool name is 64 characters or fewer.
- [x] FR-1.7 **(R1)** Each description states what the tool does and when to
      call it. It gives the model no instruction about other tools, other
      sources or its own behavior.
- [x] FR-1.8 **(R1)** A successful call returns structured content that
      validates against the tool's `outputSchema`, plus a text rendering of
      the same data.
- [x] FR-1.9 **(R1)** The server reports a name and a semantic version, and
      the version equals the one in the plugin manifest (FR-9.5).

### FR-2 `get_review_rubric`

- [x] FR-2.1 **(R1)** With no arguments, returns rubric version 2: the seven
      criteria, their weights, the 0 to 4 rating scale, the rule that bullets
      in the two most recent roles weigh double, the blocking cap, and the
      requirement weights used for alignment.
- [x] FR-2.2 **(R1)** The version, weights and cap in the response are read
      from `review_score.VERSION`, `WEIGHTS` and `CAP`. Changing a weight in
      that module changes the response with no other edit.
- [x] FR-2.3 **(R1)** The response is self-contained: it names no repository
      path and no file the host cannot read.
- [x] FR-2.4 **(R1)** The response is under 20 KB.

### FR-3 `score_resume_review`

- [x] FR-3.1 **(R1)** The input schema is the `review_score.py` stdin
      contract: optional `criteria`, `bullets`, `blocking` and `requirements`.
- [x] FR-3.2 **(R1)** For any valid payload, the result equals
      `review_score.score(payload)`.
- [x] FR-3.3 **(R1)** An empty payload returns `score: null`, `coverage: 0`
      and `provisional: true`.
- [x] FR-3.4 **(R1)** A non-empty `blocking` list caps `score` at 40 and sets
      `capped: true` when the weighted score is higher.
- [x] FR-3.5 **(R1)** An invalid payload returns a tool error carrying the
      module's message, for example
      `criteria.skills: rating must be an integer 0-4`, and no partial score.

### FR-4 `scan_resume_url`

- [x] FR-4.1 **(R1)** Given `url`, the server downloads the file and returns
      the `scan_cv.scan()` report: `format`, `bytes`, `pages` and `issues`,
      each issue with `code`, `severity`, `page` and `detail`.
- [x] FR-4.2 **(R1)** PDF and DOCX are accepted. The type is decided from the
      file's content, so a URL with no extension still works.
- [x] FR-4.3 **(R1)** The report for a downloaded file equals the report
      `scan_cv.py` prints for the same bytes on disk.
- [x] FR-4.4 **(R1)** A file with no findings returns `issues: []`.
- [x] FR-4.5 **(R1)** Any other file type returns a tool error that names the
      two supported types.

### FR-5 `scan_resume_file` (file attached in ChatGPT)

- [x] FR-5.1 **(R1)** The tool descriptor lists `file` in
      `_meta["openai/fileParams"]`. The `file` schema declares `download_url`,
      `file_id`, `mime_type` and `file_name`, and requires only the first two.
- [ ] FR-5.2 **(R1)** For a resume attached in a ChatGPT conversation, the
      tool returns the same report FR-4 returns for the same bytes.
- [x] FR-5.3 **(R1)** The download URL is used only during the call. Neither
      it nor `file_id` is stored or logged.

### FR-6 Download limits and failures

Applies to FR-4 and FR-5.

- [x] FR-6.1 **(R1)** Only `https` URLs are fetched. Any other scheme is
      rejected before a connection is made.
- [x] FR-6.2 **(R1)** A host that resolves to a loopback, private, link-local
      or cloud-metadata address is rejected. The check runs again on every
      redirect, and at most three redirects are followed.
- [x] FR-6.3 **(R1)** A download stops at 10 MB and returns a tool error that
      states the limit. Files between 2.5 MB and 10 MB are scanned and carry
      the `file_too_large` issue.
- [x] FR-6.4 **(R1)** A download that takes longer than 15 seconds returns a
      tool error.
- [x] FR-6.5 **(R1)** A corrupt, encrypted or unreadable file returns a tool
      error that says what failed. No response is a bare
      `Internal Server Error` or `Bad Request`.
- [x] FR-6.6 **(R1)** After any failed call, the next valid call succeeds.

### FR-7 Files attached in Claude

- [ ] FR-7.1 A tool takes a file argument marked with `x-mcp-file`, limited
      to PDF and DOCX, using the file object schema from the Claude file
      arguments page without changes.
- [ ] FR-7.2 For a resume attached in a Claude conversation, the two-call
      upload completes and the tool returns the same report FR-4 returns for
      the same bytes.
- [ ] FR-7.3 The uploaded bytes are deleted as soon as the report is built
      (NFR-1 applies).

### FR-8 Deployment on the VPS

- [x] FR-8.1 **(R1)** The D-1 host resolves to the VPS and serves a valid
      TLS certificate.
- [x] FR-8.2 **(R1)** The server process listens on a loopback address only.
      nginx is the only public entry.
- [x] FR-8.3 **(R1)** The process runs as a dedicated account without root or
      Docker-group rights.
- [ ] FR-8.4 **(R1)** The service starts at boot and restarts after a crash,
      with no manual step.
- [x] FR-8.5 **(R1)** `GET /job-kit-ai/healthz` on the D-1 host returns 200 while the
      server can answer a tool call.
- [ ] FR-8.6 **(R1)** nginx passes MCP responses through without buffering,
      so a streamed response arrives as it is produced.
- [x] FR-8.7 **(R1)** `pdftotext` (Poppler) is installed and on the service's
      path. A PDF scan succeeds on the VPS.
- [ ] FR-8.8 **(R1)** The deployment is repeatable from commands written in
      this repository. A second run on the same host upgrades in place.
- [x] FR-8.9 **(R1)** After deployment, `https://r1cco.com/`,
      `https://r1cco.com/jobs/` and the Job Kit API health check answer as
      they did before.
- [ ] FR-8.10 `https://r1cco.com/.well-known/openai-apps-challenge` returns
      the exact token from the OpenAI portal as plain text.

### FR-9 Public pages and listing materials

- [x] FR-9.1 **(R1)** A public documentation page explains what Resume Check
      does, how to add it in Claude and ChatGPT, each tool, and one example
      prompt per tool.
- [x] FR-9.2 **(R1)** A public privacy policy states what is collected, how
      it is used and stored, third-party sharing, retention, and a contact.
      Its statements match NFR-1 and NFR-2.
- [x] FR-9.3 **(R1)** Public terms of service and support pages exist. The
      support page gives a working contact.
- [x] FR-9.4 **(R1)** All four pages are served over HTTPS on a domain that
      identifies the same publisher as the MCP host, with no login.
- [ ] FR-9.5 A plugin package for OpenAI contains `plugin.json` and
      `mcp.json` in the Agent Plugins format, with the D-1 URL declared as
      `streamable-http`, and passes the portal's package validation.
- [x] FR-9.6 Listing text fits the OpenAI limits: display name and short
      description 30 characters each, long description 4,000, up to three
      starter prompts of 128 characters.
- [ ] FR-9.7 A square icon of at least 48 by 48 pixels exists as PNG, in the
      package for OpenAI and as an upload for Claude.
- [ ] FR-9.8 Five positive and three negative review cases are written, each
      with prompt, tools triggered and expected behavior. Every positive case
      was run against the deployed server first.
- [x] FR-9.9 Sample resumes used by the review cases are synthetic, contain
      no real person's data, and are reachable at public HTTPS URLs.
- [ ] FR-9.10 A walkthrough video of the review cases is reachable at a URL
      a reviewer can open.

### FR-10 Verification in each host

- [x] FR-10.1 **(R1)** Every tool was called through MCP Inspector against
      the deployed URL and returned a successful result.
- [ ] FR-10.2 **(R1)** In Claude, added as a custom connector, a
      conversation ran `get_review_rubric`, `scan_resume_url` and
      `score_resume_review` and produced a scored review.
- [ ] FR-10.3 **(R1)** In ChatGPT, added as a custom MCP server, a
      conversation with an attached PDF ran `scan_resume_file` and
      `score_resume_review` and produced a scored review.
- [ ] FR-10.4 A scanned PDF with no text layer produces the blocking
      `no_text_layer` issue in both hosts, and the assistant's score is
      capped at 40.

### FR-11 Directory submissions

- [ ] FR-11.1 The server is submitted as an MCP connector at
      `claude.ai/directory/manage`, and the portal's tool sync reports no
      missing title or annotation.
- [ ] FR-11.2 The Claude listing is published, and its directory link is
      recorded in this repository's README.
- [ ] FR-11.3 The OpenAI plugin draft has the server connected, domain
      verification complete, and a finished tool scan with no required issue
      open.
- [ ] FR-11.4 The OpenAI plugin is submitted for review with the FR-9.8 to
      FR-9.10 materials.
- [ ] FR-11.5 The OpenAI plugin is published, and its directory link is
      recorded in the README.
- [ ] FR-11.6 A Gemini CLI extension that points at the D-1 URL is
      installable with `gemini extensions install`. The gallery listing rule
      (root `gemini-extension.json` plus the `gemini-cli-extension`
      repository topic) comes from a third-party guide; confirm it in the
      Gemini CLI documentation before relying on it.

## Non-functional requirements

- [x] NFR-1 **(R1)** No retention. Resume bytes and extracted text exist only
      in memory or in a per-call temporary directory that is removed before
      the response is sent, on success and on failure. A test asserts the
      directory is gone after both. Supports FR-4, FR-5, FR-7.
- [x] NFR-2 **(R1)** Logs hold only time, tool name, outcome, duration and
      byte count. They hold no resume text, file name, URL or issue detail.
- [x] NFR-3 **(R1)** One source of truth. The server imports `scan_cv` and
      `review_score` from `skill/job-resume-review/scripts/`; it copies no
      logic from them, and those two files are unchanged by this work.
- [ ] NFR-4 **(R1)** `scripts/test.sh --fast` passes, and the archives built
      by `scripts/package_release.py` contain no file from the server.
- [x] NFR-5 **(R1)** The server has automated tests, run by one documented
      command, that cover every tool, every FR-6 rejection, and the FR-4.3
      equality.
- [x] NFR-6 **(R1)** Server dependencies are pinned by a lock file, including
      the MCP SDK version.
- [x] NFR-7 **(R1)** nginx limits each client address to the D-8 rate and
      answers 429 above it. Request bodies above 1 MB are refused on the MCP
      path.
- [x] NFR-8 **(R1)** The repository, the plugin package and the logs contain
      no secret. Any host configuration with a secret lives on the VPS only.
- [ ] NFR-9 The published tool schemas stay backward compatible. A change to
      a name or schema is deployed only together with a directory rescan.

## Constraints and exclusions

Constraints:

- The server lives outside `skill/` and `scripts/` (D-2).
- The skill scripts stay standard-library only and compatible with Python
  3.9, as `pyrightconfig.json` declares. The server may need a newer Python
  for the MCP SDK; that requirement applies to the server alone.
- Existing services on the VPS are not stopped, reconfigured or restarted,
  except for an nginx reload. The apex vhost gains one `include` line for the
  D-1 locations and nothing else. Known from this account's repositories, not
  checked on the host today: nginx serves the apex from
  `/etc/nginx/sites-available/r1cco.com`, the portfolio runs as a user
  service proxied on `127.0.0.1:3000`, `/jobs/` is static under
  `/var/www/r1cco.com/html`, and the Job Kit API is the Docker Compose
  project `job-kit-api` with its environment in `/etc/job-kit/api.env`.
- External prerequisites with their own lead time: individual identity verification on the OpenAI Platform (D-7),
  and a paid Claude plan on the submitting account.
- The privacy policy and terms are the publisher's own statements. This
  document sets what they must cover, not their legal wording.

Exclusions:

- No model calls from the server. The host assistant reads the resume and
  assigns the ratings; the server only scans files and computes scores.
- No agent built with the OpenAI Agents SDK in this server. An agent that
  uses Resume Check as a tool is a separate follow-up.
- No interactive UI, widget or MCP App in release 1 (D-5).
- No accounts, sign-in, stored history or user settings.
- No OCR, and no scan of pasted text. The scan needs the original file.
- No job search, match scoring, pay normalization, resume rewriting or
  application submission. Those Job Kit scripts and skills are not exposed.
- No submission of Job Kit's skills as a plugin.
- No Grok listing. No public directory for it was identified.

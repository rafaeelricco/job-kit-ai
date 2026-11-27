# Resume Check MCP server

A remote MCP server that exposes Job Kit's deterministic resume checks to AI
assistants. It imports `scan_cv.py` and `review_score.py` from
`skill/job-resume-review/scripts/` and copies none of their logic.
Requirements are in [`../SPEC.md`](../SPEC.md).

- MCP endpoint: `https://r1cco.com/job-kit-ai/mcp` (Streamable HTTP, stateless, no auth)
- Public pages: `https://r1cco.com/job-kit-ai/` with `privacy/`, `terms/` and `support/`
- Health check: `https://r1cco.com/job-kit-ai/healthz`

| Tool                  | Does                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `get_review_rubric`   | Returns rubric version 2, with numbers read from `review_score`.      |
| `score_resume_review` | Returns `review_score.score(arguments)`.                              |
| `scan_resume_url`     | Downloads a PDF or DOCX over https and returns `scan_cv.scan()`.      |
| `scan_resume_file`    | Same scan for a file attached in ChatGPT (`openai/fileParams`).       |

## Layout

| Path                     | Holds                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| `resume_check/server.py` | Tool descriptors, schemas, handlers, HTTP app, logging                |
| `resume_check/core.py`   | Rubric, score and scan over the skill scripts                         |
| `resume_check/fetch.py`  | https download: address checks, pinned connection, redirects, limits  |
| `site/`                  | Public pages; `site/brand/` images come from job-kit-platform         |
| `build_assets.py`        | Writes synthetic sample resumes into `site/samples/` at deploy        |
| `plugin/`                | OpenAI plugin package: `plugin.json`, `mcp.json`, `assets/icon.png`   |
| `deploy/`                | `deploy.sh`, `remote_install.sh`, systemd unit, nginx files           |
| `tests/`                 | Server tests and synthetic fixtures                                   |

## Develop and test

Requires Python 3.11 or newer, [uv](https://docs.astral.sh/uv/) and Poppler's
`pdftotext`. Tests that scan a PDF are skipped when `pdftotext` is missing.

```sh
cd mcp
uv run python -m unittest discover -s tests
```

Run the server locally on `127.0.0.1:3020`:

```sh
cd mcp
uv run python -m resume_check
npx @modelcontextprotocol/inspector   # connect to http://127.0.0.1:3020/mcp
```

Dependencies are pinned in `uv.lock`. After changing `pyproject.toml`, refresh
the hash-pinned file the VPS installs from:

```sh
cd mcp
uv lock && uv export --no-dev --format requirements-txt --no-emit-project -o requirements.lock
```

## Deploy

Commit first: the release is built from `HEAD`. Then, from the repository root:

```sh
mcp/deploy/deploy.sh            # default target root@r1cco.com
```

The script copies `mcp/` and `skill/job-resume-review/` to
`/opt/resume-check/releases/<id>`, builds a virtualenv from
`requirements.lock`, switches `/opt/resume-check/current`, restarts
`resume-check.service` (user `resume-check`, `127.0.0.1:3020`), installs
`/etc/nginx/conf.d/resume-check.conf` and `/etc/nginx/snippets/job-kit-ai.conf`,
adds one `include` line to the `r1cco.com` server block, tests and reloads
nginx, and waits for the health check. Running it again upgrades in place and
keeps the last three releases.

OpenAI domain verification: write the portal's token on the VPS only.

```sh
ssh root@r1cco.com 'printf %s "<token>" > /etc/resume-check/openai-apps-challenge'
```

## Directory review cases

`plugin/plugin.json` holds the five positive and three negative cases under
`extensions.com.openai.review.test_cases`. They use the synthetic samples at
`https://r1cco.com/job-kit-ai/samples/`. Re-run every positive case against the
deployed server before a submission.

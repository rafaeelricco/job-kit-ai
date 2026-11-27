# Resume review agent

A command-line agent on the [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
that reviews a resume through the [Resume Check](../mcp/README.md) MCP server.
It is a separate program from the server and imports none of its code.
Requirements: `SPEC.md`, FR-12.

What a run does:

1. An input guardrail checks that the request is a resume review with an
   https file URL. It runs before the agent and blocks any tool call when the
   check fails.
2. The agent calls `get_review_rubric` and `scan_resume_url`, reads the attached
   file, rates it, and calls `score_resume_review`.
3. It answers with a typed `ReviewReport`: score, capped flag, scan issues and
   at most three recommendations, each tied to a rubric criterion.
4. An output guardrail rejects an answer whose score or capped flag differs
   from the score tool's result, or that names an issue the scan did not return.

Traces are recorded with `trace_include_sensitive_data=False`, so model inputs
and tool payloads, including the resume, stay out of them.

## Run

Set `OPENAI_API_KEY` in the environment. `RESUME_AGENT_MODEL` overrides the
SDK's default model, and `RESUME_CHECK_URL` overrides the server URL.

```sh
cd review-agent
uv run python -m review_agent https://r1cco.com/job-kit-ai/samples/scanned.pdf
```

The JSON report goes to stdout. The trace link and the tools called go to
stderr. A refused request or a rejected answer exits 1.

## Test

Golden set: four cases on the synthetic samples, including the PDF with no
text layer. It needs the key and calls the model:

```sh
cd review-agent
uv run python -m review_agent.golden
```

Wiring tests: a scripted model stands in for OpenAI, while the MCP calls and
guardrails are real. No key is needed:

```sh
cd review-agent
uv run python -m unittest discover -s tests
```

Dependencies are pinned in `uv.lock` and `requirements.lock`.

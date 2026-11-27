"""Command line: review one resume URL and print a scored review as JSON.

Usage: python -m review_agent <https-resume-url> [request text]
Needs OPENAI_API_KEY in the environment. RESUME_AGENT_MODEL overrides the SDK's default model.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import List, Optional

from agents import InputGuardrailTripwireTriggered, OutputGuardrailTripwireTriggered, Runner, gen_trace_id, trace

from .agent import RecordTools, ReviewContext, ReviewReport, build_agent, build_input, resume_check_server, run_config

DEFAULT_REQUEST = "Review my resume and score it."


async def review(url: str, request: str = DEFAULT_REQUEST, model: Optional[str] = None
                 ) -> tuple[Optional[ReviewReport], ReviewContext, str, Optional[str]]:
    """Return (report or None, tool record, trace id, refusal reason or None)."""
    state = ReviewContext()
    trace_id = gen_trace_id()
    async with resume_check_server() as server:
        agent = build_agent(server, model)
        with trace("Resume Check review", trace_id=trace_id):
            try:
                result = await Runner.run(agent, build_input(url, request), context=state, hooks=RecordTools(),
                                          run_config=run_config(), max_turns=12)
            except InputGuardrailTripwireTriggered as refused:
                return None, state, trace_id, f"refused: {refused.guardrail_result.output.output_info}"
            except OutputGuardrailTripwireTriggered as rejected:
                return None, state, trace_id, f"answer rejected: {rejected.guardrail_result.output.output_info}"
    return result.final_output_as(ReviewReport), state, trace_id, None


def main(argv: List[str]) -> int:
    if len(argv) not in (2, 3):
        print(__doc__, file=sys.stderr)
        return 2
    if not os.environ.get("OPENAI_API_KEY"):
        print("review_agent: set OPENAI_API_KEY in the environment", file=sys.stderr)
        return 2
    report, state, trace_id, refusal = asyncio.run(review(argv[1], argv[2] if len(argv) == 3 else DEFAULT_REQUEST))
    print(f"trace: https://platform.openai.com/traces/trace?trace_id={trace_id}", file=sys.stderr)
    print(f"tools: {', '.join(state.tool_calls) or 'none'}", file=sys.stderr)
    if refusal:
        print(refusal, file=sys.stderr)
        return 1
    assert report is not None
    print(json.dumps(report.model_dump(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

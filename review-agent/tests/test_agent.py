"""The agent's wiring with a scripted model in place of OpenAI: real MCP calls, real guardrails, no API key.

Tool calls go to RESUME_CHECK_URL (default: the deployed server). Run: uv run python -m unittest discover -s tests
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from typing import Any, AsyncIterator, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agents import (  # noqa: E402
    InputGuardrailTripwireTriggered,
    OutputGuardrailTripwireTriggered,
    Runner,
    Usage,
    set_tracing_disabled,
)
from agents.items import ModelResponse  # noqa: E402
from agents.models.interface import Model  # noqa: E402
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText  # noqa: E402

from review_agent import agent as ra  # noqa: E402

SAMPLES = os.environ.get("RESUME_CHECK_SAMPLES", "https://r1cco.com/job-kit-ai/samples/")
RATINGS = {"criteria": {"positioning": 3, "skills": 3, "organization": 3, "visual": 4, "writing": 3, "parsing": 0},
           "bullets": [{"id": "E1.B1", "rating": 3, "recent": True}], "blocking": ["no_text_layer"]}

set_tracing_disabled(True)


def _call(name: str, arguments: dict, n: int) -> ResponseFunctionToolCall:
    return ResponseFunctionToolCall(type="function_call", call_id=f"call_{n}", name=name,
                                    arguments=json.dumps(arguments), id=f"fc_{n}", status="completed")


def _message(text: str) -> ResponseOutputMessage:
    return ResponseOutputMessage(id="msg_1", type="message", role="assistant", status="completed",
                                 content=[ResponseOutputText(type="output_text", text=text, annotations=[])])


class ScriptedModel(Model):
    """Returns the next scripted output each turn; records the tool names it was offered."""

    def __init__(self, turns: List[Any]) -> None:
        self.turns = list(turns)
        self.offered: List[str] = []
        self.calls = 0

    async def get_response(self, system_instructions, input, model_settings, tools, output_schema, handoffs,
                           tracing, *, previous_response_id=None, conversation_id=None, prompt=None) -> ModelResponse:
        self.calls += 1
        self.offered = [t.name for t in tools]
        return ModelResponse(output=[self.turns.pop(0)], usage=Usage(), response_id=None)

    def stream_response(self, *args: Any, **kwargs: Any) -> AsyncIterator[Any]:
        raise NotImplementedError


def review_turns(url: str, final: Optional[dict] = None) -> List[Any]:
    turns = [_call("get_review_rubric", {}, 1), _call("scan_resume_url", {"url": url}, 2),
             _call("score_resume_review", RATINGS, 3)]
    if final is not None:
        turns.append(_message(json.dumps(final)))
    return turns


class Accept(ScriptedModel):
    def __init__(self) -> None:
        super().__init__([_message(json.dumps({"is_resume_review": True, "reason": "asks for a review"}))])


class Refuse(ScriptedModel):
    def __init__(self) -> None:
        super().__init__([_message(json.dumps({"is_resume_review": False, "reason": "asks for a cover letter"}))])


async def run(model: ScriptedModel, classifier: ScriptedModel, url: str, request: str = "Review my resume.",
              state: Optional[ra.ReviewContext] = None):
    state = state if state is not None else ra.ReviewContext()
    ra.classifier.model = classifier
    async with ra.resume_check_server() as server:
        reviewer = ra.build_agent(server)
        reviewer.model = model
        result = await Runner.run(reviewer, ra.build_input(url, request), context=state, hooks=ra.RecordTools(),
                                  run_config=ra.run_config())
    return result, state


class AgentRunTest(unittest.TestCase):
    def test_review_uses_tools_and_reports_their_numbers(self) -> None:  # FR-12.2, FR-12.3, FR-12.4
        url = SAMPLES + "scanned.pdf"
        state = ra.ReviewContext()

        class Reviewer(ScriptedModel):
            async def get_response(self, *args: Any, **kwargs: Any) -> ModelResponse:
                if not self.turns:  # final answer: copy the numbers the score tool returned
                    self.turns.append(_message(json.dumps({
                        "score": state.score["score"], "capped": state.score["capped"],
                        "issues": [{"code": "no_text_layer", "severity": "blocking"}],
                        "recommendations": [{"criterion": "parsing",
                                             "change": "Export the resume from its source document."}]})))
                return await super().get_response(*args, **kwargs)

        model = Reviewer(review_turns(url))
        result, _ = asyncio.run(run(model, Accept(), url, state=state))
        report = result.final_output_as(ra.ReviewReport)
        self.assertEqual(state.tool_calls, ["get_review_rubric", "scan_resume_url", "score_resume_review"])
        self.assertEqual(set(model.offered), {"get_review_rubric", "score_resume_review", "scan_resume_url",
                                              "scan_resume_file"})
        self.assertEqual(report.score, state.score["score"])
        self.assertLessEqual(report.score, 40)
        self.assertTrue(report.capped)
        self.assertIn("no_text_layer", [i["code"] for i in state.issues])

    def test_wrong_score_is_rejected(self) -> None:  # FR-12.6
        url = SAMPLES + "scanned.pdf"
        final = {"score": 99, "capped": False, "issues": [], "recommendations": []}
        with self.assertRaises(OutputGuardrailTripwireTriggered) as caught:
            asyncio.run(run(ScriptedModel(review_turns(url, final)), Accept(), url))
        self.assertIn("differs from the score tool", caught.exception.guardrail_result.output.output_info)

    def test_invented_issue_is_rejected(self) -> None:  # FR-12.6
        state = ra.ReviewContext(score={"score": 80, "capped": False}, issues=[])
        report = ra.ReviewReport(score=80, capped=False, issues=[ra.Issue(code="hidden_text", severity="blocking")],
                                 recommendations=[])
        self.assertIn("did not return: hidden_text", ra.check_report(state, report))
        self.assertIsNone(ra.check_report(state, report.model_copy(update={"issues": []})))

    def test_non_review_request_stops_before_tools(self) -> None:  # FR-12.5
        model = ScriptedModel(review_turns(SAMPLES + "clean.pdf"))
        with self.assertRaises(InputGuardrailTripwireTriggered) as caught:
            asyncio.run(run(model, Refuse(), SAMPLES + "clean.pdf", "Write a cover letter for a marketing job."))
        self.assertEqual(model.calls, 0)
        self.assertEqual(caught.exception.guardrail_result.output.output_info, "asks for a cover letter")

    def test_non_https_url_stops_before_any_model_call(self) -> None:  # FR-12.5
        model, classifier = ScriptedModel([]), Accept()
        with self.assertRaises(InputGuardrailTripwireTriggered) as caught:
            asyncio.run(run(model, classifier, "http://example.com/cv.pdf"))
        self.assertEqual((model.calls, classifier.calls), (0, 0))
        self.assertIn("https", caught.exception.guardrail_result.output.output_info)


class StaticTest(unittest.TestCase):
    def test_trace_excludes_sensitive_data(self) -> None:  # FR-12.7
        self.assertFalse(ra.run_config().trace_include_sensitive_data)

    def test_no_scan_or_score_code_imported(self) -> None:  # FR-12.2
        source = (Path(ra.__file__)).read_text(encoding="utf-8")
        for name in ("scan_cv", "review_score", "resume_check"):
            self.assertNotIn(f"import {name}", source)
        self.assertNotIn("scan_cv", sys.modules)
        self.assertNotIn("review_score", sys.modules)

    def test_at_most_three_recommendations(self) -> None:  # FR-12.4
        with self.assertRaises(ValueError):
            ra.ReviewReport(score=1, capped=False, issues=[], recommendations=[
                ra.Recommendation(criterion="writing", change="x")] * 4)


if __name__ == "__main__":
    unittest.main()

"""A resume review agent on the OpenAI Agents SDK that uses Resume Check over MCP (SPEC FR-12).

The agent reads the resume itself (the file is attached to the model input), rates it against the rubric
from get_review_rubric, and must take every number from score_resume_review. It imports no scan or score code.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlsplit

from agents import (
    Agent,
    GuardrailFunctionOutput,
    RunConfig,
    RunContextWrapper,
    RunHooks,
    TResponseInputItem,
    input_guardrail,
    output_guardrail,
)
from agents.mcp import MCPServerStreamableHttp
from pydantic import BaseModel, Field

RESUME_CHECK_URL = os.environ.get("RESUME_CHECK_URL", "https://r1cco.com/job-kit-ai/mcp")
SCAN_TOOLS = {"scan_resume_url", "scan_resume_file"}
REQUIRED_TOOLS = ("get_review_rubric", "scan_resume_url", "score_resume_review")
Criterion = Literal["positioning", "bullets", "skills", "organization", "visual", "writing", "parsing"]


# ---------------------------------------------------------------- output


class Issue(BaseModel):
    code: str
    severity: Literal["blocking", "major", "minor"]


class Recommendation(BaseModel):
    criterion: Criterion = Field(description="The rubric criterion this change improves.")
    change: str = Field(description="One concrete change, tied to a located part of the resume.")


class ReviewReport(BaseModel):
    score: Optional[int] = Field(description="Exactly the score returned by score_resume_review.")
    capped: bool = Field(description="Exactly the capped flag returned by score_resume_review.")
    issues: List[Issue] = Field(description="The scan issues, exactly as returned by the scan tool.")
    recommendations: List[Recommendation] = Field(max_length=3, description="At most three changes.")


# ---------------------------------------------------------------- run state


@dataclass
class ReviewContext:
    """What the tools returned during this run; the output guardrail checks the answer against it."""

    tool_calls: List[str] = field(default_factory=list)
    score: Optional[Dict[str, Any]] = None
    issues: Optional[List[Dict[str, Any]]] = None


def _structured(result: object) -> Optional[Dict[str, Any]]:
    """Tool results arrive as text; Resume Check returns its JSON as the text rendering."""
    text = result if isinstance(result, str) else json.dumps(result) if isinstance(result, (dict, list)) else None
    if text is None:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    if isinstance(data, dict) and isinstance(data.get("text"), str):  # a content item wrapper
        try:
            data = json.loads(data["text"])
        except ValueError:
            return None
    return data if isinstance(data, dict) else None


class RecordTools(RunHooks[ReviewContext]):
    async def on_tool_end(self, context: RunContextWrapper[ReviewContext], agent: Any, tool: Any,
                          result: object) -> None:
        record(context.context, getattr(tool, "name", ""), result)


def record(state: ReviewContext, name: str, result: object) -> None:
    state.tool_calls.append(name)
    data = _structured(result)
    if data is None:
        return
    if name == "score_resume_review" and "score" in data:
        state.score = data
    elif name in SCAN_TOOLS and isinstance(data.get("issues"), list):
        state.issues = data["issues"]


# ---------------------------------------------------------------- guardrails


class RequestCheck(BaseModel):
    is_resume_review: bool
    reason: str


classifier = Agent(
    name="Request check",
    instructions="Decide whether the user's request asks to review, check, scan or score their own resume or CV. "
                 "Requests for anything else, such as writing a cover letter, searching jobs, or summarizing a "
                 "web page, are not resume reviews.",
    output_type=RequestCheck,
)


def _user_text(items: str | List[TResponseInputItem]) -> str:
    if isinstance(items, str):
        return items
    parts: List[str] = []
    for item in items:
        content = item.get("content") if isinstance(item, dict) else None
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            parts.extend(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "input_text")
    return "\n".join(parts)


def _file_urls(items: str | List[TResponseInputItem]) -> List[str]:
    if isinstance(items, str):
        return []
    return [c["file_url"] for item in items if isinstance(item, dict) and isinstance(item.get("content"), list)
            for c in item["content"] if isinstance(c, dict) and c.get("type") == "input_file" and c.get("file_url")]


def url_problem(url: str) -> Optional[str]:
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        return "the resume must be given as a public https URL"
    return None


@input_guardrail(name="resume review request", run_in_parallel=False)
async def resume_request_only(context: RunContextWrapper[ReviewContext], agent: Agent[Any],
                              items: str | List[TResponseInputItem]) -> GuardrailFunctionOutput:
    """Blocking: runs before the agent's first model call, so no tool runs on a refused request."""
    urls = _file_urls(items)
    if not urls:
        return GuardrailFunctionOutput(output_info="no resume file was given", tripwire_triggered=True)
    problem = url_problem(urls[0])
    if problem:
        return GuardrailFunctionOutput(output_info=problem, tripwire_triggered=True)
    from agents import Runner  # local import keeps module import cheap

    verdict = await Runner.run(classifier, _user_text(items), context=context.context, run_config=run_config())
    check = verdict.final_output_as(RequestCheck)
    return GuardrailFunctionOutput(output_info=check.reason, tripwire_triggered=not check.is_resume_review)


def check_report(state: ReviewContext, report: ReviewReport) -> Optional[str]:
    """Return why the answer contradicts the tool results, or None when it agrees with them."""
    if state.score is None:
        return "the answer was produced without a score_resume_review result"
    if report.score != state.score.get("score"):
        return f"the answer's score {report.score} differs from the score tool's {state.score.get('score')}"
    if report.capped != state.score.get("capped"):
        return "the answer's capped flag differs from the score tool's"
    if state.issues is None:
        return "the answer was produced without a scan result"
    scanned = {(i.get("code"), i.get("severity")) for i in state.issues}
    invented = [i.code for i in report.issues if (i.code, i.severity) not in scanned]
    if invented:
        return f"the answer names issues the scan did not return: {', '.join(invented)}"
    return None


@output_guardrail(name="numbers match the tools")
async def matches_tools(context: RunContextWrapper[ReviewContext], agent: Agent[Any],
                        output: ReviewReport) -> GuardrailFunctionOutput:
    problem = check_report(context.context, output)
    return GuardrailFunctionOutput(output_info=problem or "ok", tripwire_triggered=problem is not None)


# ---------------------------------------------------------------- agent

INSTRUCTIONS = """You review a job seeker's resume with the Resume Check tools.

1. Call get_review_rubric and follow it.
2. Call scan_resume_url with the resume URL from the user's message.
3. Read the attached resume and rate every criterion you can assess, and every experience or project bullet,
   on the rubric's 0-4 scales. Every blocking-severity scan issue is a blocking defect.
4. Call score_resume_review with those ratings and blocking defects.
5. Answer with the score and capped flag exactly as score_resume_review returned them, the scan issues exactly as
   the scan returned them, and at most three recommended changes, each tied to one rubric criterion.
Never compute or adjust a score yourself."""


def resume_check_server() -> MCPServerStreamableHttp:
    return MCPServerStreamableHttp(
        params={"url": RESUME_CHECK_URL, "timeout": 30},
        name="Resume Check",
        cache_tools_list=True,
        client_session_timeout_seconds=30,
    )


def build_agent(server: MCPServerStreamableHttp, model: Optional[str] = None) -> Agent[ReviewContext]:
    kwargs: Dict[str, Any] = {}
    if model or os.environ.get("RESUME_AGENT_MODEL"):
        kwargs["model"] = model or os.environ["RESUME_AGENT_MODEL"]
    return Agent[ReviewContext](
        name="Resume reviewer",
        instructions=INSTRUCTIONS,
        mcp_servers=[server],
        output_type=ReviewReport,
        input_guardrails=[resume_request_only],
        output_guardrails=[matches_tools],
        **kwargs,
    )


def build_input(url: str, request: str) -> List[TResponseInputItem]:
    return [{"role": "user", "content": [
        {"type": "input_text", "text": f"{request}\nResume URL: {url}"},
        {"type": "input_file", "file_url": url},
    ]}]


def run_config() -> RunConfig:
    # Sensitive data (model inputs and outputs, tool arguments and results) stays out of the trace, so the
    # resume's text never reaches it; spans for every tool call and guardrail result are still recorded.
    return RunConfig(workflow_name="Resume Check review", trace_include_sensitive_data=False)

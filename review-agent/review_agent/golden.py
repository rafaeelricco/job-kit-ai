"""Golden set: run the agent on the synthetic samples and assert tools called and score bounds (FR-12.8).

Usage: python -m review_agent.golden     (needs OPENAI_API_KEY; calls the model and the live Resume Check server)
"""
from __future__ import annotations

import asyncio
import os
import sys
from dataclasses import dataclass
from typing import List, Optional

from .__main__ import review

SAMPLES = os.environ.get("RESUME_CHECK_SAMPLES", "https://r1cco.com/job-kit-ai/samples/")


@dataclass
class Case:
    name: str
    file: str
    max_score: Optional[int] = None
    expect_capped: Optional[bool] = None
    expect_issue: Optional[str] = None
    refused: bool = False
    request: str = "Review my resume and score it."


CASES = [
    Case("clean PDF", "clean.pdf"),
    Case("no text layer", "scanned.pdf", max_score=40, expect_issue="no_text_layer"),
    Case("contact only in header", "header-contact.docx", max_score=40, expect_issue="contact_in_header_footer"),
    Case("not a review", "clean.pdf", refused=True, request="Write a cover letter for a marketing job."),
]


async def run_case(case: Case) -> List[str]:
    report, state, _, refusal = await review(SAMPLES + case.file, case.request)
    failures: List[str] = []
    if case.refused:
        if refusal is None or not refusal.startswith("refused"):
            failures.append(f"expected a refusal, got {refusal or 'an answer'}")
        if state.tool_calls:
            failures.append(f"tools ran on a refused request: {state.tool_calls}")
        return failures
    if refusal:
        return [refusal]
    assert report is not None
    for tool in ("get_review_rubric", "scan_resume_url", "score_resume_review"):
        if tool not in state.tool_calls:
            failures.append(f"{tool} was not called")
    if state.score is None or report.score != state.score.get("score"):
        failures.append("the printed score is not the score tool's result")
    if report.score is None or not 0 <= report.score <= 100:
        failures.append(f"score {report.score} out of range")
    if case.max_score is not None and (report.score is None or report.score > case.max_score):
        failures.append(f"score {report.score} above {case.max_score}")
    if case.expect_issue and case.expect_issue not in [i.code for i in report.issues]:
        failures.append(f"missing issue {case.expect_issue}")
    if len(report.recommendations) > 3:
        failures.append("more than three recommendations")
    return failures


async def main() -> int:
    if not os.environ.get("OPENAI_API_KEY"):
        print("golden: set OPENAI_API_KEY in the environment", file=sys.stderr)
        return 2
    failed = 0
    for case in CASES:
        failures = await run_case(case)
        print(f"{'FAIL' if failures else 'ok  '} {case.name}" + "".join(f"\n     {f}" for f in failures))
        failed += bool(failures)
    print(f"{len(CASES) - failed}/{len(CASES)} cases passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

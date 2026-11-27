"""Resume Check MCP server: stateless Streamable HTTP over the low-level MCP SDK server."""
from __future__ import annotations

import json
import logging
import os
import shutil
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

import anyio
import mcp_types as types
from mcp.server.lowlevel import Server
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import PlainTextResponse
from starlette.routing import Route

from . import __version__, core

NAME = "resume-check"
WEBSITE = "https://r1cco.com/job-kit-ai/"
MAX_REQUEST_BYTES = 1_000_000

log = logging.getLogger("resume_check")

# ---------------------------------------------------------------- schemas

NULLABLE_INT = {"type": ["integer", "null"]}
NULLABLE_NUMBER = {"type": ["number", "null"]}
RATING = {"type": "integer", "minimum": 0, "maximum": 4}

SCAN_OUTPUT = {
    "type": "object",
    "properties": {
        "format": {"type": "string", "enum": ["pdf", "docx"]},
        "bytes": {"type": "integer", "minimum": 0},
        "pages": {**NULLABLE_INT, "description": "Page count for a PDF; null for a DOCX."},
        "issues": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "code": {"type": "string"},
                    "severity": {"type": "string", "enum": ["blocking", "major", "minor"]},
                    "page": {**NULLABLE_INT, "description": "1-based page, or null when the issue is document-wide."},
                    "detail": {"type": "string"},
                },
                "required": ["code", "severity", "page", "detail"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["format", "bytes", "pages", "issues"],
    "additionalProperties": False,
}

SCORE_INPUT = {
    "type": "object",
    "properties": {
        "criteria": {
            "type": "object",
            "description": "Integer rating 0-4 per assessed criterion. Omit a criterion that was not assessed.",
            "properties": {name: {**RATING, "description": core.LABELS[name][0]}
                           for name in core.review_score.RATED},
            "additionalProperties": False,
        },
        "bullets": {
            "type": "array",
            "description": "One entry per experience or project bullet. Omit the key when bullets were not "
                           "assessed; an empty array means the resume has no achievement descriptions and rates 0.",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Location label, for example E1.B1."},
                    "rating": RATING,
                    "recent": {"type": "boolean", "description": "True for bullets in the two most recent roles."},
                },
                "required": ["rating", "recent"],
            },
        },
        "blocking": {
            "type": "array",
            "description": "One short string per blocking defect. Omit or send [] when there are none.",
            "items": {"type": "string", "minLength": 1},
        },
        "requirements": {
            "type": "array",
            "description": "Only with a job posting: one entry per deduplicated posting requirement. "
                           "Omit without a posting.",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "kind": {"type": "string", "enum": ["must", "preference", "unclassified"]},
                    "credit": {"type": "number", "enum": [0, 0.5, 1]},
                },
                "required": ["kind", "credit"],
            },
        },
    },
    "additionalProperties": False,
}

SCORE_OUTPUT = {
    "type": "object",
    "properties": {
        "rubric_version": {"type": "integer"},
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "weight": {"type": "integer"},
                    "rating": NULLABLE_NUMBER,
                    "points": NULLABLE_NUMBER,
                },
                "required": ["name", "weight", "rating", "points"],
                "additionalProperties": False,
            },
        },
        "coverage": {"type": "integer", "description": "Sum of the weights that were assessed, out of 100."},
        "weighted_score": {**NULLABLE_INT, "description": "Score before the blocking cap."},
        "score": {**NULLABLE_INT, "description": "Final 0-100 score; null when nothing was assessed."},
        "capped": {"type": "boolean"},
        "provisional": {"type": "boolean", "description": "True when coverage is under 100."},
        "alignment": {**NULLABLE_INT, "description": "Posting alignment percentage; null without requirements."},
    },
    "required": ["rubric_version", "criteria", "coverage", "weighted_score", "score", "capped",
                 "provisional", "alignment"],
    "additionalProperties": False,
}

RUBRIC_OUTPUT = {
    "type": "object",
    "properties": {
        "rubric_version": {"type": "integer"},
        "disclaimer": {"type": "string"},
        "rating_scale": {"type": "object", "additionalProperties": {"type": "string"}},
        "criteria": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "label": {"type": "string"},
                    "weight": {"type": "integer"},
                    "assess": {"type": "string"},
                    "rated_by": {"type": "string", "enum": ["criteria", "bullets"]},
                },
                "required": ["name", "label", "weight", "assess", "rated_by"],
            },
        },
        "bullets": {"type": "object"},
        "blocking": {"type": "object"},
        "alignment": {"type": "object"},
        "how_to_score": {"type": "string"},
    },
    "required": ["rubric_version", "rating_scale", "criteria", "bullets", "blocking", "alignment"],
}

OPENAI_FILE = {
    "type": "object",
    "properties": {
        "download_url": {"type": "string"},
        "file_id": {"type": "string"},
        "mime_type": {"type": "string"},
        "file_name": {"type": "string"},
    },
    "required": ["download_url", "file_id"],
    "additionalProperties": False,
}


def _annotations(title: str, open_world: bool) -> types.ToolAnnotations:
    return types.ToolAnnotations(title=title, read_only_hint=True, destructive_hint=False,
                                 idempotent_hint=True, open_world_hint=open_world)


TOOLS: List[types.Tool] = [
    types.Tool(
        name="get_review_rubric",
        title="Get resume review rubric",
        description="Returns the Job Kit resume rubric (version, the seven weighted criteria, the 0-4 rating "
                    "scale, the bullet weighting rule, blocking defects with their score cap, and posting "
                    "alignment weights). Call it before rating a resume so the ratings follow this rubric.",
        input_schema={"type": "object", "properties": {}, "additionalProperties": False},
        output_schema=RUBRIC_OUTPUT,
        annotations=_annotations("Get resume review rubric", False),
    ),
    types.Tool(
        name="score_resume_review",
        title="Score a resume review",
        description="Computes the 0-100 resume score from rubric ratings: criterion ratings, per-bullet "
                    "ratings, blocking defects and, with a posting, requirement credits. Returns the weighted "
                    "score, the blocking cap, assessed coverage and posting alignment. Call it after rating a "
                    "resume against the rubric, instead of doing the arithmetic.",
        input_schema=SCORE_INPUT,
        output_schema=SCORE_OUTPUT,
        annotations=_annotations("Score a resume review", False),
    ),
    types.Tool(
        name="scan_resume_url",
        title="Scan a resume file by URL",
        description="Downloads a PDF or DOCX resume from a public https URL and reports parsing risks a page "
                    "view hides: no text layer, hidden text, contact details only in a header or footer, "
                    "broken or private-use characters, text boxes, tables, images and file size. Call it when "
                    "the user gives a link to their resume file. The file is not stored.",
        input_schema={
            "type": "object",
            "properties": {"url": {"type": "string", "format": "uri",
                                   "description": "Public https URL of a PDF or DOCX resume, up to 10 MB."}},
            "required": ["url"],
            "additionalProperties": False,
        },
        output_schema=SCAN_OUTPUT,
        annotations=_annotations("Scan a resume file by URL", True),
    ),
    types.Tool(
        name="scan_resume_file",
        title="Scan an attached resume file",
        description="Reports parsing risks in a PDF or DOCX resume the user attached to the conversation: no "
                    "text layer, hidden text, contact details only in a header or footer, broken or "
                    "private-use characters, text boxes, tables, images and file size. Call it when the user "
                    "attaches their resume file. The file is not stored.",
        input_schema={
            "type": "object",
            "properties": {"file": {**OPENAI_FILE, "description": "The attached PDF or DOCX resume."}},
            "required": ["file"],
            "additionalProperties": False,
        },
        output_schema=SCAN_OUTPUT,
        annotations=_annotations("Scan an attached resume file", True),
        meta={"openai/fileParams": ["file"]},
    ),
]

# ---------------------------------------------------------------- handlers


def _ok(data: Dict[str, Any]) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=json.dumps(data, indent=2))],
                                structured_content=data)


def _error(message: str) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=message)], is_error=True)


async def _rubric(arguments: Dict[str, Any]) -> Dict[str, Any]:
    return core.rubric()


async def _score(arguments: Dict[str, Any]) -> Dict[str, Any]:
    return core.score(arguments)


async def _scan_url(arguments: Dict[str, Any]) -> Dict[str, Any]:
    url = arguments.get("url")
    return await anyio.to_thread.run_sync(core.scan_url, url)


async def _scan_file(arguments: Dict[str, Any]) -> Dict[str, Any]:
    url = core.file_download_url(arguments.get("file"))
    return await anyio.to_thread.run_sync(core.scan_url, url)


HANDLERS: Dict[str, Callable[[Dict[str, Any]], Awaitable[Dict[str, Any]]]] = {
    "get_review_rubric": _rubric,
    "score_resume_review": _score,
    "scan_resume_url": _scan_url,
    "scan_resume_file": _scan_file,
}


async def call_tool(name: str, arguments: Optional[Dict[str, Any]]) -> types.CallToolResult:
    """Run one tool. Logs only time, tool, outcome, duration and byte count (NFR-2)."""
    started = time.monotonic()
    outcome = "error"
    size: Optional[int] = None
    try:
        handler = HANDLERS.get(name)
        if handler is None:
            return _error(f"unknown tool: {name}")
        if arguments is not None and not isinstance(arguments, dict):
            return _error("arguments must be an object")
        try:
            data = await handler(arguments or {})
        except core.ToolError as error:
            return _error(str(error))
        except Exception as error:  # never a bare Internal Server Error, never exception text in logs
            log.error("tool=%s unexpected=%s", name, type(error).__name__)
            return _error(f"{name} failed unexpectedly ({type(error).__name__}); the request was not completed")
        outcome = "ok"
        if isinstance(data.get("bytes"), int):
            size = data["bytes"]
        return _ok(data)
    finally:
        log.info("tool=%s outcome=%s duration_ms=%d bytes=%s", name if name in HANDLERS else "unknown",
                 outcome, (time.monotonic() - started) * 1000, "-" if size is None else size)


async def _on_list_tools(ctx: Any, params: Any) -> types.ListToolsResult:
    return types.ListToolsResult(tools=TOOLS)


async def _on_call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    return await call_tool(params.name, params.arguments)


def build_server() -> Server[Any]:
    return Server(NAME, version=__version__, title="Resume Check", website_url=WEBSITE,
                  description="Deterministic resume file scans and rubric scoring from Job Kit.",
                  on_list_tools=_on_list_tools, on_call_tool=_on_call_tool)


async def healthz(request: Request) -> PlainTextResponse:
    try:
        result = core.score({"criteria": {"parsing": 4}})
        healthy = result["score"] == 100 and shutil.which("pdftotext") is not None
    except Exception:
        healthy = False
    return PlainTextResponse("ok\n" if healthy else "unhealthy\n", status_code=200 if healthy else 503)


def create_app() -> Starlette:
    server = build_server()
    # A public, unauthenticated server with no ambient credentials: DNS-rebinding protection adds nothing,
    # and its Host/Origin allow-lists would reject MCP Inspector and browser-based clients.
    return server.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        max_request_body_size=MAX_REQUEST_BYTES,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
        custom_starlette_routes=[Route("/healthz", healthz, methods=["GET", "HEAD"])],
    )


def configure_logging() -> None:
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")
    log.setLevel(logging.INFO)


def main() -> None:
    import uvicorn

    configure_logging()
    uvicorn.run(create_app(), host="127.0.0.1", port=int(os.environ.get("RESUME_CHECK_PORT", "3020")),
                access_log=False, log_level="warning", proxy_headers=False, server_header=False)


if __name__ == "__main__":
    main()

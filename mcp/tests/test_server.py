"""Tools, schemas, equality with the skill scripts, retention and logging (SPEC FR-1..FR-6, FR-9, NFR-1..NFR-5)."""
from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional
from unittest import mock

HERE = Path(__file__).resolve().parent
MCP_DIR = HERE.parent
REPO = MCP_DIR.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(MCP_DIR))

import jsonschema  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

import fixtures  # noqa: E402
from resume_check import __version__, core, server  # noqa: E402
from resume_check.fetch import FetchError  # noqa: E402

SCAN_CV = REPO / "skill" / "job-resume-review" / "scripts" / "scan_cv.py"
HAS_PDFTOTEXT = shutil.which("pdftotext") is not None
TOOL_SCHEMAS = {tool.name: tool for tool in server.TOOLS}
PNG_SIGNATURE = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def call(name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
    return asyncio.run(server.call_tool(name, arguments))


def text_of(result: Any) -> str:
    return result.content[0].text


def ok(name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    result = call(name, arguments)
    assert not result.is_error, text_of(result)
    jsonschema.validate(result.structured_content, TOOL_SCHEMAS[name].output_schema)  # FR-1.8
    assert json.loads(text_of(result)) == result.structured_content
    return result.structured_content


def cli_report(data: bytes, suffix: str) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / f"cv.{suffix}"
        path.write_bytes(data)
        proc = subprocess.run([sys.executable, str(SCAN_CV), str(path)], capture_output=True, text=True)
        return json.loads(proc.stdout)


def serve(data: bytes):  # a fetcher returning fixed bytes, standing in for the network
    return mock.patch.object(core, "fetch", lambda url: data)


def scan(data: bytes, url: str = "https://files.example.com/download/7f3a") -> Any:
    with serve(data):
        return call("scan_resume_url", {"url": url})


class DescriptorTest(unittest.TestCase):
    def test_exact_tools(self) -> None:  # FR-1.4
        self.assertEqual([t.name for t in server.TOOLS],
                         ["get_review_rubric", "score_resume_review", "scan_resume_url", "scan_resume_file"])

    def test_descriptor_fields(self) -> None:  # FR-1.5, FR-1.6
        for tool in server.TOOLS:
            with self.subTest(tool=tool.name):
                self.assertLessEqual(len(tool.name), 64)
                self.assertTrue(tool.title)
                self.assertTrue(tool.description)
                self.assertTrue(tool.annotations.read_only_hint)
                self.assertFalse(tool.annotations.destructive_hint)
                jsonschema.Draft202012Validator.check_schema(tool.input_schema)
                jsonschema.Draft202012Validator.check_schema(tool.output_schema)

    def test_descriptions_name_no_other_tool(self) -> None:  # FR-1.7
        for tool in server.TOOLS:
            for other in server.TOOLS:
                if other.name != tool.name and other.name != "score_resume_review":
                    self.assertNotIn(other.name, tool.description, tool.name)

    def test_openai_file_params(self) -> None:  # FR-5.1
        tool = TOOL_SCHEMAS["scan_resume_file"]
        self.assertEqual(tool.meta, {"openai/fileParams": ["file"]})
        file_schema = tool.input_schema["properties"]["file"]
        self.assertEqual(set(file_schema["properties"]), {"download_url", "file_id", "mime_type", "file_name"})
        self.assertEqual(file_schema["required"], ["download_url", "file_id"])

    def test_version_matches_plugin_manifest(self) -> None:  # FR-1.9
        manifest = json.loads((MCP_DIR / "plugin" / "plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], __version__)
        self.assertRegex(__version__, r"^\d+\.\d+\.\d+$")


class ListingTest(unittest.TestCase):  # FR-9.5, FR-9.6, FR-9.7
    def test_plugin_package(self) -> None:
        plugin = MCP_DIR / "plugin"
        manifest = json.loads((plugin / "plugin.json").read_text(encoding="utf-8"))
        servers = json.loads((plugin / "mcp.json").read_text(encoding="utf-8"))["mcpServers"]
        self.assertEqual(list(servers.values()), [{"type": "streamable-http", "url": "https://r1cco.com/job-kit-ai/mcp",
                                                   "extensions": {"com.openai": {"auth": {"type": "none"}}}}])
        face = manifest["extensions"]["com.openai"]["interface"]
        self.assertLessEqual(len(face["displayName"]), 30)
        self.assertLessEqual(len(face["shortDescription"]), 30)
        self.assertLessEqual(len(face["longDescription"]), 4000)
        self.assertLessEqual(len(face["defaultPrompt"]), 3)
        self.assertTrue(all(len(p) <= 128 for p in face["defaultPrompt"]))
        cases = manifest["extensions"]["com.openai"]["review"]["test_cases"]
        self.assertEqual((len(cases["positive"]), len(cases["negative"])), (5, 3))
        for case in cases["positive"]:
            self.assertTrue(set(case) >= {"description", "prompt", "tools_triggered", "expected_behavior"})
        icon = (plugin / face["logo"]).read_bytes()
        self.assertEqual(icon[:8], PNG_SIGNATURE)
        width, height = int.from_bytes(icon[16:20], "big"), int.from_bytes(icon[20:24], "big")
        self.assertEqual(width, height)
        self.assertGreaterEqual(width, 48)

    def test_score_case_expectation(self) -> None:  # the "Score given ratings" review case says 85
        payload = {"criteria": {"positioning": 3, "skills": 4, "organization": 3, "visual": 4, "writing": 3,
                                "parsing": 4},
                   "bullets": [{"rating": 4, "recent": True}, {"rating": 3, "recent": True},
                               {"rating": 2, "recent": False}]}
        data = ok("score_resume_review", payload)
        self.assertEqual((data["score"], data["coverage"], data["provisional"], data["capped"]), (85, 100, False, False))


class RubricTest(unittest.TestCase):
    def test_rubric(self) -> None:  # FR-2.1
        data = ok("get_review_rubric")
        self.assertEqual(data["rubric_version"], 2)
        self.assertEqual([c["name"] for c in data["criteria"]], list(core.review_score.WEIGHTS))
        self.assertEqual(sum(c["weight"] for c in data["criteria"]), 100)
        self.assertEqual(set(data["rating_scale"]), {"0", "1", "2", "3", "4"})
        self.assertEqual(data["bullets"]["recent_weight"], 2)
        self.assertEqual(data["blocking"]["cap"], 40)
        self.assertEqual(data["alignment"]["kind_weights"], {"must": 2, "preference": 1, "unclassified": 1})

    def test_numbers_come_from_review_score(self) -> None:  # FR-2.2
        weights = dict(core.review_score.WEIGHTS, visual=7)
        with mock.patch.object(core.review_score, "WEIGHTS", weights), \
                mock.patch.object(core.review_score, "CAP", 33), mock.patch.object(core.review_score, "VERSION", 9):
            data = core.rubric()
        self.assertEqual(next(c["weight"] for c in data["criteria"] if c["name"] == "visual"), 7)
        self.assertEqual(data["blocking"]["cap"], 33)
        self.assertEqual(data["rubric_version"], 9)

    def test_self_contained_and_small(self) -> None:  # FR-2.3, FR-2.4
        text = json.dumps(core.rubric())
        self.assertLess(len(text.encode()), 20_000)
        for needle in ("skill/", "scripts/", ".py", ".md", "references"):
            self.assertNotIn(needle, text)


class ScoreTest(unittest.TestCase):
    PAYLOADS = [
        {},
        {"criteria": {"positioning": 3, "skills": 4, "organization": 2, "visual": 4, "writing": 3, "parsing": 4},
         "bullets": [{"id": "E1.B1", "rating": 4, "recent": True}, {"id": "E2.B1", "rating": 1, "recent": False}]},
        {"criteria": {"parsing": 0}, "bullets": [], "blocking": ["no_text_layer"]},
        {"criteria": {"positioning": 4, "skills": 4, "organization": 4, "visual": 4, "writing": 4, "parsing": 4},
         "bullets": [{"rating": 4, "recent": True}], "blocking": ["contact only in header"],
         "requirements": [{"id": "R1", "kind": "must", "credit": 1}, {"id": "R2", "kind": "preference", "credit": 0.5}]},
    ]

    def test_equals_module(self) -> None:  # FR-3.2
        for payload in self.PAYLOADS:
            with self.subTest(payload=payload):
                self.assertEqual(ok("score_resume_review", payload), core.review_score.score(payload))

    def test_empty(self) -> None:  # FR-3.3
        for arguments in (None, {}):
            data = ok("score_resume_review", arguments)
            self.assertIsNone(data["score"])
            self.assertEqual(data["coverage"], 0)
            self.assertTrue(data["provisional"])

    def test_blocking_cap(self) -> None:  # FR-3.4
        data = ok("score_resume_review", self.PAYLOADS[3])
        self.assertEqual(data["weighted_score"], 100)
        self.assertEqual(data["score"], 40)
        self.assertTrue(data["capped"])

    def test_invalid_payload(self) -> None:  # FR-3.5
        cases = {
            "criteria.skills: rating must be an integer 0-4": {"criteria": {"skills": 5}},
            "bullets[0]: needs a boolean recent": {"bullets": [{"rating": 2}]},
            "requirements[0]: credit must be 0, 0.5, or 1": {"requirements": [{"kind": "must", "credit": 2}]},
            "requirements: must be an array": {"requirements": None},
        }
        for message, payload in cases.items():
            with self.subTest(message=message):
                result = call("score_resume_review", payload)
                self.assertTrue(result.is_error)
                self.assertEqual(text_of(result), message)
                self.assertIsNone(result.structured_content)


@unittest.skipUnless(HAS_PDFTOTEXT, "pdftotext (Poppler) is not installed")
class ScanTest(unittest.TestCase):
    def test_equals_cli_for_every_fixture(self) -> None:  # FR-4.1, FR-4.3
        for name, build in fixtures.ALL.items():
            with self.subTest(fixture=name):
                data = build()
                with serve(data):
                    report = ok("scan_resume_url", {"url": "https://files.example.com/" + name})
                self.assertEqual(report, cli_report(data, name.rsplit(".", 1)[1]))

    def test_type_from_content(self) -> None:  # FR-4.2
        with serve(fixtures.clean_docx()):
            self.assertEqual(ok("scan_resume_url", {"url": "https://files.example.com/x"})["format"], "docx")
        with serve(fixtures.text_pdf()):
            self.assertEqual(ok("scan_resume_url", {"url": "https://files.example.com/cv.docx"})["format"], "pdf")

    def test_clean_files_have_no_issues(self) -> None:  # FR-4.4
        for build in (fixtures.text_pdf, fixtures.clean_docx):
            with serve(build()):
                self.assertEqual(ok("scan_resume_url", {"url": "https://files.example.com/a"})["issues"], [])

    def test_blocking_findings(self) -> None:  # FR-10.4 basis
        codes = {
            "blank.pdf": "no_text_layer",
            "header-contact.docx": "contact_in_header_footer",
            "hidden-text.docx": "hidden_text",
        }
        for name, code in codes.items():
            with serve(fixtures.ALL[name]()):
                issues = ok("scan_resume_url", {"url": "https://files.example.com/a"})["issues"]
            self.assertIn((code, "blocking"), [(i["code"], i["severity"]) for i in issues], name)

    def test_unsupported_type(self) -> None:  # FR-4.5
        for data in (b"plain text resume", PNG_SIGNATURE + b"0000", _zip({"a.txt": b"x"})):
            result = scan(data)
            self.assertTrue(result.is_error)
            self.assertIn("PDF and DOCX", text_of(result))

    def test_attached_file_matches_url_scan(self) -> None:  # FR-5.2
        data = fixtures.header_contact_docx()
        with serve(data):
            by_file = ok("scan_resume_file", {"file": {"download_url": "https://files.oaiusercontent.com/f",
                                                       "file_id": "file_123", "mime_type": "application/pdf",
                                                       "file_name": "cv.docx"}})
        self.assertEqual(by_file, cli_report(data, "docx"))

    def test_bad_file_argument(self) -> None:
        for arguments in ({}, {"file": "https://x"}, {"file": {"file_id": "f"}}, {"file": {"download_url": 3}}):
            result = call("scan_resume_file", arguments)
            self.assertTrue(result.is_error, arguments)

    def test_bad_url_argument(self) -> None:
        for arguments in ({}, {"url": 5}, {"url": ""}):
            result = call("scan_resume_url", arguments)
            self.assertTrue(result.is_error)
            self.assertIn("url", text_of(result))

    def test_large_file_scanned_with_issue(self) -> None:  # FR-6.3
        data = _zip({"[Content_Types].xml": b"<Types/>", "word/document.xml": fixtures.clean_docx_body(),
                     "word/media/pad.bin": os.urandom(3_000_000)}, stored=True)
        with serve(data):
            report = ok("scan_resume_url", {"url": "https://files.example.com/a"})
        self.assertIn("file_too_large", [i["code"] for i in report["issues"]])

    def test_corrupt_files(self) -> None:  # FR-6.5
        for data, needle in ((fixtures.corrupt_pdf(), "PDF could not be read"),
                             (fixtures.corrupt_docx(), "DOCX could not be read"),
                             (b"PK\x03\x04garbage", "cannot be opened")):
            result = scan(data)
            self.assertTrue(result.is_error)
            self.assertIn(needle, text_of(result))
            self.assertNotIn("Internal Server Error", text_of(result))

    def test_encrypted_docx_is_labelled_docx(self) -> None:  # FR-6.5
        data = bytearray(fixtures.clean_docx())
        for signature, flag_offset in ((b"PK", 6), (b"PK", 8)):  # local and central headers
            start = 0
            while (start := data.find(signature, start)) != -1:
                data[start + flag_offset] |= 0x1  # general purpose bit 0: entry is encrypted
                start += 4
        result = scan(bytes(data))
        self.assertTrue(result.is_error)
        self.assertTrue(text_of(result).startswith("the DOCX could not be read"), text_of(result))

    def test_download_errors_are_tool_errors(self) -> None:
        def failing(url: str) -> bytes:
            raise FetchError("download timed out after 15 seconds")
        with mock.patch.object(core, "fetch", failing):
            result = call("scan_resume_url", {"url": "https://files.example.com/a"})
        self.assertTrue(result.is_error)
        self.assertEqual(text_of(result), "download timed out after 15 seconds")

    def test_unexpected_exception_is_reported(self) -> None:
        def broken(url: str) -> bytes:
            raise ZeroDivisionError("secret detail")
        with mock.patch.object(core, "fetch", broken):
            result = call("scan_resume_url", {"url": "https://files.example.com/a"})
        self.assertTrue(result.is_error)
        self.assertIn("ZeroDivisionError", text_of(result))
        self.assertNotIn("secret detail", text_of(result))

    def test_next_call_after_failure_succeeds(self) -> None:  # FR-6.6
        self.assertTrue(scan(fixtures.corrupt_pdf()).is_error)
        self.assertFalse(scan(fixtures.text_pdf()).is_error)

    def test_busy_when_all_download_slots_taken(self) -> None:
        for _ in range(core.MAX_CONCURRENT_DOWNLOADS):
            core._download_slots.acquire()
        try:
            result = scan(fixtures.text_pdf())
        finally:
            for _ in range(core.MAX_CONCURRENT_DOWNLOADS):
                core._download_slots.release()
        self.assertTrue(result.is_error)
        self.assertIn("busy", text_of(result))

    def test_slow_downloads_do_not_take_scan_slots(self) -> None:
        """Held download slots, up to one less than the pool, leave every scan slot free."""
        for _ in range(core.MAX_CONCURRENT_DOWNLOADS - 1):
            core._download_slots.acquire()
        try:
            self.assertFalse(scan(fixtures.text_pdf()).is_error)
        finally:
            for _ in range(core.MAX_CONCURRENT_DOWNLOADS - 1):
                core._download_slots.release()

    def test_scan_waits_briefly_for_a_slot(self) -> None:
        for _ in range(core.MAX_CONCURRENT_SCANS):
            core._scan_slots.acquire()
        threading.Timer(0.3, core._scan_slots.release).start()
        try:
            self.assertFalse(scan(fixtures.text_pdf()).is_error)
        finally:
            for _ in range(core.MAX_CONCURRENT_SCANS - 1):
                core._scan_slots.release()

    def test_busy_when_scan_slots_stay_taken(self) -> None:
        for _ in range(core.MAX_CONCURRENT_SCANS):
            core._scan_slots.acquire()
        try:
            with mock.patch.object(core, "SCAN_SLOT_WAIT_SECONDS", 0.2):
                result = scan(fixtures.text_pdf())
        finally:
            for _ in range(core.MAX_CONCURRENT_SCANS):
                core._scan_slots.release()
        self.assertTrue(result.is_error)
        self.assertIn("busy", text_of(result))


@unittest.skipUnless(HAS_PDFTOTEXT, "pdftotext (Poppler) is not installed")
class RetentionTest(unittest.TestCase):  # NFR-1
    def test_temp_dir_removed_on_success_and_failure(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            seen = []
            real_scan = core.scan_cv.scan

            def spy(path: Path) -> Dict[str, Any]:
                seen.append(path.parent)
                self.assertTrue(path.exists())
                return real_scan(path)

            with mock.patch.object(tempfile, "tempdir", root), mock.patch.object(core.scan_cv, "scan", spy):
                self.assertFalse(scan(fixtures.text_pdf()).is_error)
                self.assertTrue(scan(fixtures.corrupt_pdf()).is_error)
                self.assertTrue(scan(fixtures.corrupt_docx()).is_error)
            self.assertEqual(len(seen), 3)
            for directory in seen:
                self.assertEqual(directory.parent, Path(root))
                self.assertFalse(directory.exists())
            self.assertEqual(os.listdir(root), [])


@unittest.skipUnless(HAS_PDFTOTEXT, "pdftotext (Poppler) is not installed")
class LoggingTest(unittest.TestCase):  # NFR-2, FR-5.3
    def test_logs_hold_no_resume_data(self) -> None:
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        root = logging.getLogger()
        root.addHandler(handler)
        previous = root.level
        root.setLevel(logging.DEBUG)
        try:
            url = "https://files.oaiusercontent.com/secret-token-xyz/cv.pdf"
            with serve(fixtures.header_contact_docx()):
                call("scan_resume_file", {"file": {"download_url": url, "file_id": "file_secret_42",
                                                   "file_name": "Alex Example CV.docx"}})
            scan(fixtures.corrupt_pdf(), url)
        finally:
            root.removeHandler(handler)
            root.setLevel(previous)
        output = stream.getvalue()
        for secret in ("secret-token-xyz", "file_secret_42", "Alex", "example.com", "header1", "xref"):
            self.assertNotIn(secret, output)
        lines = [line for line in output.splitlines() if line.startswith("tool=")]
        self.assertEqual(len(lines), 2)
        for line in lines:
            self.assertRegex(line, r"^tool=scan_resume_(file|url) outcome=(ok|error) duration_ms=\d+ bytes=(\d+|-)$")


class HTTPTest(unittest.TestCase):  # FR-1.1, FR-1.2, FR-1.3, FR-8.5
    HEADERS = {"accept": "application/json, text/event-stream", "content-type": "application/json"}

    def rpc(self, client: TestClient, method: str, params: Optional[Dict[str, Any]] = None,
            headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        body: Dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
        if params is not None:
            body["params"] = params
        response = client.post("/mcp", headers={**self.HEADERS, **(headers or {})}, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_protocol(self) -> None:
        with TestClient(server.create_app(), base_url="http://127.0.0.1:3020") as client:
            init = self.rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                   "clientInfo": {"name": "test", "version": "1"}})
            self.assertEqual(init["result"]["serverInfo"]["name"], "resume-check")
            self.assertEqual(init["result"]["serverInfo"]["version"], __version__)
            listed = self.rpc(client, "tools/list", headers={"origin": "http://localhost:6274"})
            self.assertEqual(len(listed["result"]["tools"]), 4)
            scan_tool = next(t for t in listed["result"]["tools"] if t["name"] == "scan_resume_file")
            self.assertEqual(scan_tool["_meta"], {"openai/fileParams": ["file"]})
            self.assertTrue(scan_tool["annotations"]["readOnlyHint"])
            self.assertIn("outputSchema", scan_tool)

    def test_stateless_call_without_initialize(self) -> None:
        for _ in range(2):  # a fresh app each time stands in for a service restart
            with TestClient(server.create_app(), base_url="http://r1cco.com") as client:
                result = self.rpc(client, "tools/call", {"name": "score_resume_review",
                                                         "arguments": {"criteria": {"parsing": 4}}})
                self.assertEqual(result["result"]["structuredContent"]["score"], 100)
                self.assertFalse(result["result"].get("isError", False))

    def test_oversized_body_refused(self) -> None:
        with TestClient(server.create_app()) as client:
            response = client.post("/mcp", headers=self.HEADERS, content=b"{" + b" " * 1_100_000 + b"}")
            self.assertEqual(response.status_code, 413)

    @unittest.skipUnless(HAS_PDFTOTEXT, "pdftotext (Poppler) is not installed")
    def test_healthz(self) -> None:
        with TestClient(server.create_app()) as client:
            response = client.get("/healthz")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, "ok\n")


class IsolationTest(unittest.TestCase):  # NFR-3, NFR-4
    def test_imports_the_skill_scripts(self) -> None:
        self.assertEqual(Path(core.scan_cv.__file__).resolve(), SCAN_CV.resolve())
        self.assertEqual(Path(core.review_score.__file__).resolve(), SCAN_CV.with_name("review_score.py").resolve())

    def test_deploy_scripts_are_executable(self) -> None:
        listed = subprocess.run(["git", "ls-files", "-s", "mcp/deploy"], cwd=REPO, capture_output=True, text=True)
        modes = {line.split("	")[1]: line.split()[0] for line in listed.stdout.splitlines()}
        for name in ("mcp/deploy/deploy.sh", "mcp/deploy/remote_install.sh", "mcp/deploy/bin/pdftotext"):
            self.assertEqual(modes.get(name), "100755", name)

    def test_release_archives_exclude_server(self) -> None:
        sys.path.insert(0, str(REPO / "scripts"))
        import package_release
        with tempfile.TemporaryDirectory() as out:
            package_release.build_release("v0.0.0", Path(out))
            with zipfile.ZipFile(Path(out) / "job-kit-v0.0.0.zip") as archive:
                names = archive.namelist()
        self.assertTrue(names)
        self.assertFalse([n for n in names if n.startswith("job-kit/mcp/") or "resume_check" in n])


def _zip(members: Dict[str, bytes], stored: bool = False) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return out.getvalue()


if __name__ == "__main__":
    unittest.main()

import json
import subprocess
import sys
import threading
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCRIPT = Path(__file__).with_name("collect.py")


@contextmanager
def board_server(extra_responses=None):
    calls = []
    responses = extra_responses or {}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            calls.append(self.path)
            if self.path == "/jobs/truncated":
                self.send_response(200)
                self.send_header("Content-Length", "1000")
                self.end_headers()
                self.wfile.write(b'{"jobs": [')
                self.close_connection = True
                return
            if self.path == "/jobs/malformed":
                self.connection.sendall(b"not an HTTP status\r\n\r\n")
                self.close_connection = True
                return
            if self.path in responses:
                body = responses[self.path].encode("utf-8")
            else:
                slug = self.path.rsplit("/", 1)[-1]
                body = json.dumps({"jobs": [{"title": "Senior Software Engineer",
                                             "absolute_url": "https://example.test/" + slug}]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield "http://127.0.0.1:{0}".format(server.server_port), calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class CollectCliTests(unittest.TestCase):
    def run_collect(self, origin, **sources):
        payload = {"route": {"ats": "greenhouse", "url": origin + "/jobs/{slug}",
                             "items": "jobs", "posting_url": "absolute_url", "title": "title"},
                   "positions": ["Senior Software Engineer"], "date_posted": "all_time",
                   "now": "2026-10-22T12:00:00Z"}
        payload.update(sources)
        proc = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(payload).encode("utf-8"),
                              capture_output=True, timeout=10)
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8"))
        return json.loads(proc.stdout.decode("utf-8"))

    def test_bad_http_response_preserves_other_boards(self):
        for broken in ("truncated", "malformed"):
            with self.subTest(broken=broken), board_server() as (origin, calls):
                out = self.run_collect(origin, slugs=["good", broken, "good2"])
                self.assertEqual([row["slug"] for row in out["candidates"]], ["good", "good2"])
                self.assertEqual([row["status"] for row in out["slugs"]], ["ok", "failed", "ok"])
                self.assertTrue(out["slugs"][1]["error"])
                self.assertCountEqual(calls, ["/jobs/good", "/jobs/" + broken, "/jobs/good2"])

    def test_utf8_in_and_out(self):
        payload = {"route": {"ats": "lever"}, "positions": ["Engenheiro de Software Sênior"]}
        run = subprocess.run([sys.executable, str(SCRIPT)],
                             input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                             capture_output=True)
        out = json.loads(run.stdout.decode("utf-8"))
        self.assertEqual(run.returncode, 1)
        self.assertIn("collect_error", out)


if __name__ == "__main__":
    unittest.main()

"""A local HTTPS server for download tests. Its certificate names resume.test and evil.test."""
from __future__ import annotations

import shutil
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Dict

from fixtures import text_pdf

Route = Callable[[BaseHTTPRequestHandler], None]


def _send(handler: BaseHTTPRequestHandler, status: int, body: bytes = b"", headers: Dict[str, str] | None = None,
          length: bool = True) -> None:
    handler.send_response(status)
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    if length:
        handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    if body:
        handler.wfile.write(body)


def _big_chunked(handler: BaseHTTPRequestHandler) -> None:
    handler.send_response(200)
    handler.send_header("Connection", "close")
    handler.end_headers()
    block = b"%PDF-" + b"0" * 65531
    try:
        for _ in range(200):  # ~13 MB with no Content-Length
            handler.wfile.write(block)
    except OSError:
        pass


def _drip(handler: BaseHTTPRequestHandler) -> None:
    handler.send_response(200)
    handler.send_header("Content-Length", "100000")
    handler.end_headers()
    try:
        for _ in range(100):
            handler.wfile.write(b"%")
            handler.wfile.flush()
            time.sleep(0.2)
    except OSError:
        pass


def _drip_headers(handler: BaseHTTPRequestHandler) -> None:
    try:
        handler.wfile.write(b"HTTP/1.1 200 OK\r\n")
        for i in range(100):
            handler.wfile.write(b"X-Slow-%d: 1\r\n" % i)
            handler.wfile.flush()
            time.sleep(0.2)
    except OSError:
        pass


ROUTES: Dict[str, Route] = {
    "/drip-headers": _drip_headers,
    "/curr%C3%ADculo.pdf": lambda h: _send(h, 200, text_pdf()),
    "/resume.pdf": lambda h: _send(h, 200, text_pdf(), {"Content-Type": "application/pdf"}),
    "/download/abc123": lambda h: _send(h, 200, text_pdf(), {"Content-Type": "application/octet-stream"}),
    "/redirect": lambda h: _send(h, 302, headers={"Location": "/resume.pdf"}),
    "/redirect-private": lambda h: _send(h, 302, headers={"Location": "https://evil.test/resume.pdf"}),
    "/redirect-http": lambda h: _send(h, 302, headers={"Location": "http://resume.test/resume.pdf"}),
    "/loop": lambda h: _send(h, 302, headers={"Location": "/loop"}),
    "/big": lambda h: _send(h, 200, headers={"Content-Length": "11000000"}, length=False),
    "/big-chunked": _big_chunked,
    "/drip": _drip,
    "/missing": lambda h: _send(h, 404, b"not found"),
}


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        route = ROUTES.get(self.path)
        if route is None:
            _send(self, 404)
        else:
            route(self)

    def log_message(self, format: str, *args: object) -> None:  # silence
        pass


class TLSServer:
    def __init__(self) -> None:
        if shutil.which("openssl") is None:
            raise RuntimeError("openssl is required for download tests")
        self.dir = Path(tempfile.mkdtemp(prefix="tls-test-"))
        cert, key = self.dir / "cert.pem", self.dir / "key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=resume.test", "-addext", "subjectAltName=DNS:resume.test,DNS:evil.test",
                        "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(cert, key)
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.daemon_threads = True
        self.httpd.socket = server_context.wrap_socket(self.httpd.socket, server_side=True)
        self.port = self.httpd.server_address[1]
        self.client_context = ssl.create_default_context(cafile=str(cert))
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.dir, ignore_errors=True)

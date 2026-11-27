"""FR-6 download limits and failures, against a local TLS server."""
from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from typing import List

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures import text_pdf  # noqa: E402
from resume_check import fetch as f  # noqa: E402
from tls_server import TLSServer  # noqa: E402

HOSTS = {"resume.test": ["127.0.0.1"], "evil.test": ["10.0.0.7"]}


def resolver(host: str, port: int) -> List[str]:
    if host not in HOSTS:
        raise OSError("unknown host")
    return HOSTS[host]


def test_check(ip: str) -> bool:
    """The real check, except the local test server's loopback address."""
    return ip == "127.0.0.1" or f.address_allowed(ip)


class AddressCheckTest(unittest.TestCase):
    def test_rejects_non_public_addresses(self) -> None:
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1",
                   "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "fc00::1", "fd00:ec2::254",
                   "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
                   "::127.0.0.1", "fec0::1", "2002:7f00:1::", "ff02::1", "not-an-ip"]:
            with self.subTest(ip=ip):
                self.assertFalse(f.address_allowed(ip))

    def test_accepts_public_addresses(self) -> None:
        for ip in ["8.8.8.8", "76.13.169.200", "2606:4700:4700::1111"]:
            with self.subTest(ip=ip):
                self.assertTrue(f.address_allowed(ip))


class URLCheckTest(unittest.TestCase):
    def never(self, host: str, port: int) -> List[str]:
        raise AssertionError("no resolution or connection may happen")

    def test_rejected_before_connecting(self) -> None:
        cases = {
            "http://resume.test/a.pdf": "only https",
            "ftp://resume.test/a.pdf": "only https",
            "file:///etc/passwd": "only https",
            "https://user:pw@resume.test/a.pdf": "credentials",
            "https://resume.test:8443/a.pdf": "port 443",
            "https://localhost/a.pdf": "private or local",
            "https://metadata.google.internal/": "private or local",
            "": "non-empty",
        }
        for url, message in cases.items():
            with self.subTest(url=url):
                with self.assertRaisesRegex(f.FetchError, message):
                    f.fetch(url, resolver=self.never)

    def test_private_resolution_rejected(self) -> None:
        with self.assertRaisesRegex(f.FetchError, "private or local"):
            f.fetch("https://evil.test/a.pdf", resolver=resolver)
        with self.assertRaisesRegex(f.FetchError, "private or local"):
            f.fetch("https://resume.test/a.pdf", resolver=resolver)  # 127.0.0.1 with the real check


class DownloadTest(unittest.TestCase):
    server: TLSServer

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = TLSServer()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.close()

    def get(self, path: str, **kwargs: object) -> bytes:
        return f.fetch("https://resume.test" + path, resolver=resolver, context=self.server.client_context,
                       address_check=test_check, port=self.server.port, **kwargs)  # type: ignore[arg-type]

    def test_download(self) -> None:
        self.assertEqual(self.get("/resume.pdf"), text_pdf())

    def test_url_without_extension(self) -> None:
        self.assertEqual(self.get("/download/abc123"), text_pdf())

    def test_relative_redirect(self) -> None:
        self.assertEqual(self.get("/redirect"), text_pdf())

    def test_redirect_to_private_address(self) -> None:
        with self.assertRaisesRegex(f.FetchError, "private or local"):
            self.get("/redirect-private")

    def test_redirect_to_http(self) -> None:
        with self.assertRaisesRegex(f.FetchError, "only https"):
            self.get("/redirect-http")

    def test_redirect_limit(self) -> None:
        with self.assertRaisesRegex(f.FetchError, "more than 3 redirects"):
            self.get("/loop")

    def test_declared_size_limit(self) -> None:
        with self.assertRaisesRegex(f.FetchError, "10 MB"):
            self.get("/big")

    def test_streamed_size_limit(self) -> None:
        with self.assertRaisesRegex(f.FetchError, "10 MB"):
            self.get("/big-chunked")

    def test_deadline_covers_slow_body(self) -> None:
        started = time.monotonic()
        with self.assertRaisesRegex(f.FetchError, "timed out"):
            self.get("/drip", deadline_seconds=1.0)
        self.assertLess(time.monotonic() - started, 3.0)

    def test_deadline_covers_slow_headers(self) -> None:
        started = time.monotonic()
        with self.assertRaisesRegex(f.FetchError, "timed out"):
            self.get("/drip-headers", deadline_seconds=1.0)
        self.assertLess(time.monotonic() - started, 3.0)

    def test_deadline_covers_slow_dns(self) -> None:
        def slow(host: str, port: int) -> List[str]:
            time.sleep(3)
            return ["127.0.0.1"]
        started = time.monotonic()
        with self.assertRaisesRegex(f.FetchError, "timed out"):
            f.fetch("https://resume.test/resume.pdf", resolver=slow, address_check=test_check,
                    port=self.server.port, deadline_seconds=0.5)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_http_error_status(self) -> None:
        with self.assertRaisesRegex(f.FetchError, "HTTP 404"):
            self.get("/missing")

    def test_untrusted_certificate(self) -> None:
        with self.assertRaisesRegex(f.FetchError, "TLS certificate"):
            f.fetch("https://resume.test/resume.pdf", resolver=resolver, address_check=test_check,
                    port=self.server.port)

    def test_success_after_failure(self) -> None:
        with self.assertRaises(f.FetchError):
            self.get("/missing")
        self.assertEqual(self.get("/resume.pdf"), text_pdf())


if __name__ == "__main__":
    unittest.main()

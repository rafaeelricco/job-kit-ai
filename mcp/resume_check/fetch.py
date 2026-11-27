"""Download a resume from a public https URL with SSRF and resource limits (SPEC FR-6).

Every resolved address is vetted, the connection is pinned to a vetted address so DNS cannot
change between check and connect, redirects are re-checked, and one watchdog enforces a single
deadline over DNS, TLS, headers and body.
"""
from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from typing import Callable, List, Optional, Tuple
from urllib.parse import urljoin, urlsplit

MAX_DOWNLOAD_BYTES = 10_000_000
DEADLINE_SECONDS = 15.0
MAX_REDIRECTS = 3
CHUNK = 65_536

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Resolver = Callable[[str, int], List[str]]

_BLOCKED_NETWORKS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
    "::/96", "::1/128", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2002::/16",
    "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8", "fd00:ec2::254/128",
)]
_METADATA_HOSTS = {"metadata.google.internal", "metadata", "instance-data"}


class FetchError(Exception):
    """A download failure whose message is safe to show the caller."""


def _embedded_ipv4(address: IPAddress) -> Optional[ipaddress.IPv4Address]:
    if isinstance(address, ipaddress.IPv4Address):
        return None
    if address.ipv4_mapped is not None:
        return address.ipv4_mapped
    if address.sixtofour is not None:
        return address.sixtofour
    if address.teredo is not None:
        return address.teredo[1]
    packed = address.packed
    if packed[:12] == b"\x00" * 12 or packed[:12] == bytes.fromhex("0064ff9b0000000000000000"):
        return ipaddress.IPv4Address(packed[12:])  # IPv4-compatible or NAT64 well-known prefix
    return None


def address_allowed(text: str) -> bool:
    try:
        address = ipaddress.ip_address(text.split("%", 1)[0])
    except ValueError:
        return False
    for candidate in filter(None, (address, _embedded_ipv4(address))):
        if (not candidate.is_global or candidate.is_multicast or candidate.is_reserved
                or candidate.is_loopback or candidate.is_link_local or candidate.is_private
                or getattr(candidate, "is_site_local", False)
                or any(candidate in network for network in _BLOCKED_NETWORKS
                       if network.version == candidate.version)):
            return False
    return True


def system_resolver(host: str, port: int) -> List[str]:
    infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    seen: List[str] = []
    for info in infos:
        ip = str(info[4][0])
        if ip not in seen:
            seen.append(ip)
    return seen


class _Deadline:
    """One deadline for the whole download. On expiry it shuts the live socket so no read can stall."""

    def __init__(self, seconds: float) -> None:
        self.end = time.monotonic() + seconds
        self.expired = False
        self._lock = threading.Lock()
        self._sock: Optional[socket.socket] = None
        self._timer = threading.Timer(seconds, self._fire)
        self._timer.daemon = True
        self._timer.start()

    def remaining(self) -> float:
        left = self.end - time.monotonic()
        if left <= 0 or self.expired:
            raise FetchError(f"download timed out after {DEADLINE_SECONDS:g} seconds")
        return left

    def watch(self, sock: Optional[socket.socket]) -> None:
        with self._lock:
            self._sock = sock
            if self.expired and sock is not None:
                self._shutdown(sock)

    def _fire(self) -> None:
        with self._lock:
            self.expired = True
            if self._sock is not None:
                self._shutdown(self._sock)

    @staticmethod
    def _shutdown(sock: socket.socket) -> None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def cancel(self) -> None:
        self._timer.cancel()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS to a fixed IP while TLS SNI and certificate checks use the URL's host name."""

    def __init__(self, host: str, ip: str, deadline: _Deadline, context: ssl.SSLContext, port: int) -> None:
        super().__init__(host, port, timeout=deadline.remaining(), context=context)
        self._ip = ip
        self._port = port
        self._deadline = deadline
        self._context = context

    def connect(self) -> None:
        raw = socket.create_connection((self._ip, self._port), timeout=self._deadline.remaining())
        self._deadline.watch(raw)
        try:
            raw.settimeout(self._deadline.remaining())
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def _resolve(host: str, resolver: Resolver, deadline: _Deadline) -> List[str]:
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(resolver, host, 443)
        try:
            return future.result(timeout=deadline.remaining())
        except FutureTimeout:
            raise FetchError(f"download timed out after {DEADLINE_SECONDS:g} seconds") from None
        except OSError:
            raise FetchError("download failed: the host name could not be resolved") from None


def _check_url(url: str) -> Tuple[str, str]:
    """Return (host, path) for an acceptable URL, or raise before any connection."""
    if not isinstance(url, str) or not url.strip():
        raise FetchError("url must be a non-empty string")
    parts = urlsplit(url.strip())
    if parts.scheme.lower() != "https":
        raise FetchError("only https URLs are supported")
    if parts.username is not None or parts.password is not None:
        raise FetchError("URLs with embedded credentials are not supported")
    try:
        port = parts.port
    except ValueError:
        raise FetchError("the URL has an invalid port") from None
    if port not in (None, 443):
        raise FetchError("only the default https port 443 is supported")
    host = (parts.hostname or "").rstrip(".").lower()
    if not host:
        raise FetchError("the URL has no host")
    if host in _METADATA_HOSTS or host == "localhost" or host.endswith(".localhost") or host.endswith(".internal"):
        raise FetchError("the URL points to a private or local address")
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return host, path


def fetch(url: str, *, resolver: Resolver = system_resolver,
          context: Optional[ssl.SSLContext] = None,
          deadline_seconds: float = DEADLINE_SECONDS,
          address_check: Callable[[str], bool] = address_allowed,
          port: int = 443) -> bytes:
    """Download url and return its bytes, or raise FetchError with a caller-safe message.

    address_check and port exist for tests against a local server; production uses the defaults.
    """
    context = context or ssl.create_default_context()
    deadline = _Deadline(deadline_seconds)
    try:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            host, path = _check_url(current)
            addresses = _resolve(host, resolver, deadline)
            if not addresses:
                raise FetchError("download failed: the host name could not be resolved")
            if not all(address_check(ip) for ip in addresses):
                raise FetchError("the URL points to a private or local address")
            status, location, body = _get(host, path, addresses, deadline, context, port)
            if status in (301, 302, 303, 307, 308):
                if not location:
                    raise FetchError(f"download failed: HTTP {status} without a Location header")
                current = urljoin(current, location)
                continue
            if not 200 <= status < 300:
                raise FetchError(f"download failed: HTTP {status}")
            return body
        raise FetchError(f"download failed: more than {MAX_REDIRECTS} redirects")
    except FetchError:
        if deadline.expired:
            raise FetchError(f"download timed out after {DEADLINE_SECONDS:g} seconds") from None
        raise
    except ssl.SSLCertVerificationError:
        raise FetchError("download failed: the server's TLS certificate is not valid") from None
    except (OSError, http.client.HTTPException, ssl.SSLError) as error:
        if deadline.expired:
            raise FetchError(f"download timed out after {DEADLINE_SECONDS:g} seconds") from None
        raise FetchError(f"download failed: {type(error).__name__}") from None
    finally:
        deadline.cancel()


def _get(host: str, path: str, addresses: List[str], deadline: _Deadline,
         context: ssl.SSLContext, port: int) -> Tuple[int, Optional[str], bytes]:
    last: Optional[BaseException] = None
    for ip in addresses:  # try each vetted address while time remains (dual-stack hosts)
        connection = _PinnedHTTPSConnection(host, ip, deadline, context, port)
        try:
            try:
                connection.connect()
            except (OSError, ssl.SSLError) as error:
                if isinstance(error, ssl.SSLCertVerificationError) or deadline.expired:
                    raise
                last = error
                continue
            connection.request("GET", path, headers={
                "Host": host, "User-Agent": "resume-check/1", "Accept": "*/*",
                "Accept-Encoding": "identity", "Connection": "close"})
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                return response.status, response.getheader("Location"), b""
            if not 200 <= response.status < 300:
                return response.status, None, b""
            declared = response.getheader("Content-Length")
            if declared and declared.isdigit() and int(declared) > MAX_DOWNLOAD_BYTES:
                raise FetchError(_too_large())
            chunks: List[bytes] = []
            total = 0
            while True:
                deadline.remaining()
                chunk = response.read1(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise FetchError(_too_large())
                chunks.append(chunk)
            return response.status, None, b"".join(chunks)
        finally:
            deadline.watch(None)
            connection.close()
    assert last is not None
    raise last


def _too_large() -> str:
    return f"the file exceeds the {MAX_DOWNLOAD_BYTES // 1_000_000} MB download limit"

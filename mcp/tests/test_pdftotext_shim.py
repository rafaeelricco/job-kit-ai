"""The bounded pdftotext shim in deploy/bin (Codex security finding on unbounded extractor output)."""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
MCP_DIR = HERE.parent
SHIM = MCP_DIR / "deploy" / "bin" / "pdftotext"
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(MCP_DIR))

import fixtures  # noqa: E402
from resume_check import core  # noqa: E402

FAKES = {
    "ok.py": "import sys; sys.stdout.write('Alex Example\\nalex@example.com\\n\\f')",
    "flood.py": "import sys\nwhile True:\n    sys.stdout.write('x' * 65536)",
    "slow.py": "import time; time.sleep(30)",
    "chatty.py": "import sys; sys.stderr.write('Syntax Warning: noise\\n' * 50000); sys.stderr.flush(); "
                 "sys.stdout.write('Alex Example\\n\\f')",
    "broken.py": "import sys; sys.stderr.write('Syntax Error: Couldn\\'t read xref table\\n'); sys.exit(1)",
}


class ShimTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="shim-test-"))
        for name, source in FAKES.items():
            (self.dir / name).write_text(source, encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_shim(self, fake: str, **env: str) -> subprocess.CompletedProcess:
        environment = dict(os.environ, RESUME_CHECK_PDFTOTEXT=str(self.dir / fake), **env)
        return subprocess.run([sys.executable, str(SHIM), "-enc", "UTF-8", "in.pdf", "-"], env=environment,
                              capture_output=True, timeout=60)

    def test_passes_output_through(self) -> None:
        result = self.run_shim("ok.py")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.replace(b"\r\n", b"\n"), b"Alex Example\nalex@example.com\n\f")

    def test_stops_output_past_the_limit(self) -> None:
        started = time.monotonic()
        result = self.run_shim("flood.py", RESUME_CHECK_PDFTOTEXT_MAX_BYTES="1000000")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"exceeds the 1000000 byte limit", result.stderr)
        self.assertLessEqual(len(result.stdout), 1_000_000)
        self.assertLess(time.monotonic() - started, 15)

    def test_default_output_limit_is_2_mb(self) -> None:
        result = self.run_shim("flood.py")
        self.assertIn(b"exceeds the 2000000 byte limit", result.stderr)

    def test_stops_at_the_deadline(self) -> None:
        started = time.monotonic()
        result = self.run_shim("slow.py", RESUME_CHECK_PDFTOTEXT_TIMEOUT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"exceeded 1 seconds", result.stderr)
        self.assertLess(time.monotonic() - started, 10)

    def test_chatty_stderr_does_not_block(self) -> None:
        """About 1 MB of diagnostics must not fill the pipe and stall a good extraction."""
        result = self.run_shim("chatty.py", RESUME_CHECK_PDFTOTEXT_TIMEOUT="10")
        self.assertEqual(result.returncode, 0, result.stderr[-200:])
        self.assertEqual(result.stdout.replace(b"\r\n", b"\n"), b"Alex Example\n\f")

    def test_passes_failures_through(self) -> None:
        result = self.run_shim("broken.py")
        self.assertEqual(result.returncode, 1)
        self.assertIn(b"Couldn't read xref table", result.stderr)

    def test_missing_binary(self) -> None:
        result = self.run_shim("does-not-exist")
        self.assertEqual(result.returncode, 127)
        self.assertIn(b"cannot run", result.stderr)


@unittest.skipUnless(os.name == "posix", "scan_cv finds the shim by PATH, which needs an executable script")
class ScanThroughShimTest(unittest.TestCase):
    """scan_cv.py runs `pdftotext` from PATH, exactly as it does under resume-check.service."""

    def setUp(self) -> None:
        self.bin = Path(tempfile.mkdtemp(prefix="shim-bin-"))
        target = self.bin / "pdftotext"
        target.write_text(f"#!{sys.executable}\n" + SHIM.read_text(encoding="utf-8").split("\n", 1)[1], encoding="utf-8")
        target.chmod(target.stat().st_mode | stat.S_IEXEC)
        for name, source in FAKES.items():
            (self.bin / name).write_text(source, encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.bin, ignore_errors=True)

    def scan(self, **env: str):
        path = f"{self.bin}{os.pathsep}{os.environ.get('PATH', '')}"
        with mock.patch.dict(os.environ, {"PATH": path, **env}):
            return core.scan_bytes(fixtures.text_pdf())

    def test_flood_becomes_an_unreadable_pdf_error(self) -> None:
        with self.assertRaises(core.ToolError) as caught:
            self.scan(RESUME_CHECK_PDFTOTEXT=str(self.bin / "flood.py"))
        self.assertIn("the PDF could not be read", str(caught.exception))
        self.assertIn("byte limit", str(caught.exception))

    @unittest.skipUnless(Path("/usr/bin/pdftotext").exists(), "Poppler is not installed at /usr/bin")
    def test_real_pdftotext_through_the_shim_matches(self) -> None:
        through_shim = self.scan()
        self.assertEqual(through_shim, core.scan_bytes(fixtures.text_pdf()))
        self.assertEqual(through_shim["issues"], [])


if __name__ == "__main__":
    unittest.main()

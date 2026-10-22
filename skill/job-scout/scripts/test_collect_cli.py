import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("collect.py")


class CollectCliTests(unittest.TestCase):
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

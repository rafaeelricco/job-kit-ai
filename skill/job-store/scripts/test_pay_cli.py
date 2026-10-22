import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("pay.py")


class PayCliTests(unittest.TestCase):
    def test_utf8_stdin_period_word(self):
        payload = {"min": {"currency": "USD", "monthly": "5000", "annual": "60000"},
                   "rows": [{"url": "b", "salary": "R$ 25.000 / mês"}]}
        proc = subprocess.run([sys.executable, str(SCRIPT)],
                              input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                              capture_output=True, check=False)
        self.assertEqual(proc.returncode, 0)
        row = json.loads(proc.stdout.decode("utf-8"))["rows"][0]
        # 25000 x 12 x 0.198059 = 59400, under the 60000 floor: "mês" was read as month
        self.assertEqual((row["pay_usd_year"], row["below_min"]), ("59400", True))


if __name__ == "__main__":
    unittest.main()

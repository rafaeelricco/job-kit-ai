import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("pay.py")


class PayCliTests(unittest.TestCase):
    def run_pay(self, payload):
        proc = subprocess.run([sys.executable, str(SCRIPT)],
                              input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                              capture_output=True, check=False)
        return proc.returncode, json.loads(proc.stdout.decode("utf-8"))

    def test_periods_belong_to_wages_not_other_amounts_or_benefits(self):
        cases = (
            ("$50,000 per year or $4,167 per month", "50000", True),
            ("$4,167 per month or $50,000 per year", "50000", True),
            ("$50,000 per year ($4,167 per month)", "50000", True),
            ("$50,000 per year, $4,167 per month", "50000", True),
            ("$8,000 monthly + 30 days vacation per year", "96000", False),
            ("$40 - $50 per hour + $2,000 annual bonus", "83200-104000", False),
            ("R$ 30.000 + annual bonus", "71300", False),
            ("$8,000 monthly, annual leave included", "96000", False),
            ("$40 - $50 per hour", "83200-104000", False),
            ("R$ 30.000", "71300", False),
        )
        payload = {"min": {"currency": "USD", "monthly": "5000", "annual": "60000"},
                   "rows": [{"url": str(i), "salary": phrase} for i, (phrase, _, _) in enumerate(cases)]}
        code, out = self.run_pay(payload)
        self.assertEqual(code, 0)
        for row, (phrase, pay, below) in zip(out["rows"], cases):
            with self.subTest(phrase=phrase):
                self.assertEqual((row["pay_usd_year"], row["below_min"]), (pay, below))

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

    def test_partial_currency_conversion_stays_unknown(self):
        for salary in ("USD 50,000 per year; AED 300,000 per year",
                       "AED 300,000 per year; USD 50,000 per year"):
            with self.subTest(salary=salary):
                code, out = self.run_pay({"min": {"currency": "USD", "monthly": "5000", "annual": "60000"},
                                          "rows": [{"url": "mixed", "salary": salary}]})
                self.assertEqual(code, 0)
                self.assertEqual(out["rows"], [{"url": "mixed", "pay_usd_year": "—", "below_min": False}])


if __name__ == "__main__":
    unittest.main()

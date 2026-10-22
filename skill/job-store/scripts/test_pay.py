import unittest
from pay import figures, yearly_usd, pay_payload

RATES = {"USD": 1.0, "GBP": 1.25, "EUR": 1.1, "BRL": 0.2}
MIN = {"currency": "USD", "monthly": "5000", "annual": "60000"}

CASES = (  # phrase → pay_usd_year at RATES
    ("$120,000 - $150,000", "120000-150000"),
    ("£80,000 - £100,000", "100000-125000"),
    ("USD 50-70/hour", "104000-145600"),
    ("€4,500 per month", "59400"),
    ("R$ 20.000 / mês", "48000"),
    ("$3K - $7K", "36000-84000"),          # no period, largest < 20000 → month
    ("R$ 15.000", "36000"),                # no period: USD value and face amount both read month
    ("$80k–$155k", "80000-155000"),
    ("US $143,800; United Kingdom £90,300", "112900-143800"),
    ("350 - 400 EUR/day", "100100-114400"),
    ("Competitive", "—"),
    ("—", "—"),
    ("CHF 120,000", "—"),                  # currency absent from RATES → unknown
    ("6 257 - 8 069 USD net per month, B2B", "75100-96800"),  # space-grouped thousands
    ("100 000 - 200 000 EUR/year", "110000-220000"),
    ("5 200 - 6 200 USD/month", "62400-74400"),
)

class PayTests(unittest.TestCase):
    def test_phrases(self):
        for phrase, want in CASES:
            with self.subTest(phrase=phrase):
                code, out = pay_payload({"min": MIN, "rows": [{"url": "u", "salary": phrase}]}, RATES)
                self.assertEqual((code, out["rows"][0]["pay_usd_year"]), (0, want))

    def test_min_and_floor(self):
        code, out = pay_payload({"min": MIN, "rows": [
            {"url": "a", "salary": "$3K - $4.5K per month"},   # high 54000 < 60000
            {"url": "b", "salary": "$40/hour"},               # 83200
            {"url": "c", "salary": "—"}]}, RATES)
        self.assertEqual(out["min_usd_year"], 60000)
        self.assertEqual([r["below_min"] for r in out["rows"]], [True, False, False])

    def test_empty_min_never_drops(self):
        code, out = pay_payload({"min": {"currency": "", "monthly": "", "annual": ""},
                                 "rows": [{"url": "a", "salary": "$10/hour"}]}, RATES)
        self.assertEqual((out["min_usd_year"], out["rows"][0]["below_min"]), (None, False))

    def test_bad_payload(self):
        for payload in ([], {"rows": None}, {"min": MIN, "rows": [{"url": "a"}]}):
            code, out = pay_payload(payload, RATES)
            self.assertEqual(code, 1)
            self.assertIn("pay_error", out)

if __name__ == "__main__":
    unittest.main()

"""Phrases from real postings that pay.py once misread, plus the profile floor shapes."""

import unittest

from pay import pay_payload

RATES = {"USD": 1.0, "GBP": 1.25, "EUR": 1.1, "BRL": 0.2}
MIN = {"currency": "USD", "monthly": "5000", "annual": "60000"}

CASES = (  # phrase → pay_usd_year at RATES
    # no printed period: decided on the USD value, so large local-currency monthly pay stays monthly
    ("R$ 22.000 - R$ 30.000 (CLT)", "52800-72000"),
    ("R$ 25.000", "60000"),
    # a schedule is not a pay period; only figures carrying or ranged with a currency count
    ("40 hrs/week at $60/hr", "124800"),
    ("$1.2M OTE", "1200000"),
    # a k on the high end of a range applies to a small low end too
    ("£45-55k", "56300-68800"),
    ("$100-120k", "100000-120000"),
    ("120-150K USD", "120000-150000"),
    # a retirement plan is not pay
    ("$150k + 401k", "150000"),
    # apostrophe thousands separators
    ("$120'000", "120000"),
    ("€120’000", "132000"),
    # a lone figure too small to be any wage is junk, not hourly pay
    ("USD 5", "—"),
)


class PayCaseTests(unittest.TestCase):
    def test_real_phrases(self):
        for phrase, want in CASES:
            with self.subTest(phrase=phrase):
                code, out = pay_payload({"min": MIN, "rows": [{"url": "u", "salary": phrase}]}, RATES)
                self.assertEqual((code, out["rows"][0]["pay_usd_year"]), (0, want))

    def test_misread_phrases_never_drop(self):
        rows = [{"url": phrase, "salary": phrase} for phrase, _ in CASES]
        code, out = pay_payload({"min": MIN, "rows": rows}, RATES)
        self.assertEqual([r["url"] for r in out["rows"] if r["below_min"]], [])

    def test_min_shapes(self):
        for floor in (
            {"currency": "USD", "monthly": 5000, "annual": 60000},
            {"currency": "usd", "monthly": "5,000", "annual": "60,000"},
            {"currency": "$", "monthly": "5000", "annual": "60000"},
            {"currency": "USD", "monthly": "5000", "annual": "60010"},   # within rounding
        ):
            with self.subTest(floor=floor):
                code, out = pay_payload({"min": floor, "rows": []}, RATES)
                self.assertEqual((code, out.get("min_usd_year")), (0, 60000))

    def test_unresolvable_min_is_an_error_not_a_silent_no_floor(self):
        for floor in (
            {"currency": "XYZ", "monthly": "5000", "annual": "60000"},
            {"currency": "USD", "monthly": "lots", "annual": "60000"},
            {"currency": "USD", "monthly": "5000", "annual": ""},
            {"currency": "", "monthly": "5000", "annual": "60000"},
            {"currency": "USD", "monthly": "5000", "annual": "82000"},     # 60000 ≠ 82000
        ):
            with self.subTest(floor=floor):
                code, out = pay_payload({"min": floor, "rows": []}, RATES)
                self.assertEqual(code, 1)
                self.assertIn("min", out["pay_error"])

    def test_target_shape_rounding_is_consistent(self):
        code, out = pay_payload({"min": {"currency": "USD", "monthly": "6833", "annual": "82000"},
                                 "rows": []}, RATES)
        self.assertEqual((code, out["min_usd_year"]), (0, 82000))


if __name__ == "__main__":
    unittest.main()

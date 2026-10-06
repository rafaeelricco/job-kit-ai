import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from geography import geography_payload


SCRIPT = Path(__file__).with_name("geography.py").resolve()
REGIONS = ["Americas", "Latin America and the Caribbean", "South America"]


class GeographyTests(unittest.TestCase):
    def test_brazil_public_contract(self):
        code, result = geography_payload({"country": "Brazil", "places": ["Brazil", "LATAM", "South America", "worldwide", "United States"]})
        self.assertEqual(code, 0)
        self.assertEqual(result, {"country": "Brazil", "regions": REGIONS, "matches": [True, True, True, True, False]})

    def test_country_names_codes_and_aliases_normalize(self):
        for country in ("Brazil", "br", "BRA", "  bRaSiL  "):
            with self.subTest(country=country):
                self.assertEqual(geography_payload({"country": country})[1], {"country": "Brazil", "regions": REGIONS, "matches": []})
        for country, place in (("United States", "USA"), ("US", "United States"), ("United Kingdom", "GB"), ("UK", "GBR")):
            with self.subTest(country=country):
                self.assertEqual(geography_payload({"country": country, "places": [place]})[1]["matches"], [True])

    def test_common_and_accented_country_names_resolve(self):
        for country, name in (("Netherlands", "Netherlands (Kingdom of the)"), ("South Korea", "Republic of Korea"), ("Vietnam", "Viet Nam"), ("Russia", "Russian Federation"), ("Turkey", "Türkiye"), ("Turkiye", "Türkiye"), ("Czech Republic", "Czechia"), ("Bolivia", "Bolivia (Plurinational State of)"), ("Iran", "Iran (Islamic Republic of)"), ("Tanzania", "United Republic of Tanzania"), ("México", "Mexico"), ("Cote d'Ivoire", "Côte d’Ivoire")):
            with self.subTest(country=country):
                self.assertEqual(geography_payload({"country": country})[1]["country"], name)

    def test_regions_are_not_a_brazil_only_special_case(self):
        for country, region in (("Argentina", "LATAM"), ("Mexico", "Latin America"), ("India", "Asia"), ("France", "Europe"), ("Japan", "Eastern Asia"), ("Australia", "Oceania"), ("South Africa", "Africa")):
            with self.subTest(country=country):
                self.assertEqual(geography_payload({"country": country, "places": [region]})[1]["matches"], [True])

    def test_bare_two_letter_places_match_only_the_residence_code(self):
        result = geography_payload({"country": "United States", "places": ["CA", "co", "NA", "GA", "US", "Canada", "CAN"]})[1]
        self.assertEqual(result["matches"], [None, None, None, None, True, False, False])
        self.assertEqual(geography_payload({"country": "Canada", "places": ["CA"]})[1]["matches"], [True])

    def test_unmapped_labels_are_unknown(self):
        result = geography_payload({"country": "Brazil", "places": ["EMEA", "APAC", "somewhere", ""]})[1]
        self.assertEqual(result["matches"], [None] * 4)

    def test_eu_resolves_through_member_group(self):
        self.assertEqual(geography_payload({"country": "Brazil", "places": ["EU", "European Union"]})[1]["matches"], [False, False])
        self.assertEqual(geography_payload({"country": "Portugal", "places": ["EU", "European Union"]})[1]["matches"], [True, True])
        data = json.loads(SCRIPT.with_suffix(".json").read_text(encoding="utf-8"))
        self.assertEqual(len(data["groups"]["european union"]["countries"]), 27)

    def test_unknown_country_does_not_confirm_worldwide(self):
        for country in ("", "Atlantis"):
            with self.subTest(country=country):
                self.assertEqual(geography_payload({"country": country, "places": ["LATAM", "worldwide"]}), (0, {"country": None, "regions": [], "matches": [None, None]}))

    def test_inclusion_and_exclusion_can_be_compared_separately(self):
        result = geography_payload({"country": "Brazil", "places": ["LATAM", "Brazil", "United States"]})[1]
        self.assertEqual(result["matches"], [True, True, False])

    def test_invalid_payloads_are_errors(self):
        for payload in (None, [], {}, {"country": None}, {"country": 1}, {"country": "Brazil", "places": None}, {"country": "Brazil", "places": "LATAM"}, {"country": "Brazil", "places": [True]}):
            with self.subTest(payload=payload):
                code, result = geography_payload(payload)
                self.assertEqual(code, 1)
                self.assertEqual(set(result), {"geography_error"})
                self.assertIsInstance(result["geography_error"], str)

    def test_bundled_dataset_is_complete_and_attributed(self):
        data = json.loads(SCRIPT.with_suffix(".json").read_text(encoding="utf-8"))
        self.assertEqual(data["source"], "https://unstats.un.org/unsd/methodology/m49/")
        self.assertEqual(data["retrieved_at"], "2026-10-06")
        self.assertEqual(len(data["countries"]), 248)
        self.assertEqual(data["countries"]["BR"]["regions"], REGIONS)
        for code, country in data["countries"].items():
            with self.subTest(code=code):
                self.assertEqual(len(code), 2)
                self.assertEqual(len(country["alpha3"]), 3)
                self.assertTrue(country["name"])
                self.assertIsInstance(country["regions"], list)

    def test_cli_resolves_data_from_its_own_directory_and_utf8(self):
        with tempfile.TemporaryDirectory() as unrelated:
            env = dict(os.environ, PYTHONIOENCODING="ascii", PYTHONUTF8="0")
            completed = subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps({"country": "Côte d’Ivoire", "places": ["Africa"]}, ensure_ascii=False).encode("utf-8"), capture_output=True, cwd=unrelated, env=env)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8"))
        output = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(output["matches"], [True])
        self.assertEqual(set(output), {"country", "regions", "matches"})

    def test_cli_invalid_json_returns_error_json(self):
        completed = subprocess.run([sys.executable, str(SCRIPT)], input=b"{broken", capture_output=True)
        self.assertEqual(completed.returncode, 1)
        self.assertEqual(set(json.loads(completed.stdout)), {"geography_error"})


if __name__ == "__main__":
    unittest.main()

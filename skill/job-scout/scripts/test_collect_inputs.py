import json
import os
import tempfile
import unittest

from collect import collect

NOW = "2026-10-22T12:00:00Z"
POSITIONS = ["Senior Software Engineer"]

GREENHOUSE = {
    "kind": "board",
    "ats": "greenhouse",
    "url": "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
    "items": "jobs",
    "posting_url": "absolute_url",
    "title": "title",
    "location": "location.name",
    "date": "first_published",
}
LEVER = {
    "kind": "board",
    "ats": "lever",
    "url": "https://api.lever.co/v0/postings/{slug}?mode=json",
    "items": "$",
    "posting_url": "hostedUrl",
    "title": "text",
    "location": "categories.location",
    "date": "createdAt",
}


def make_fetch(responses):
    """Fake fetch: canned (status, body) per URL, 404 otherwise; records calls."""
    calls = []

    def fetch(url):
        calls.append(url)
        return responses.get(url, (404, ""))

    fetch.calls = calls
    return fetch


def board_fetch():
    url = GREENHOUSE["url"].replace("{slug}", "acme")
    jobs = [
        {"title": "Senior Software Engineer", "absolute_url": "https://boards.greenhouse.io/acme/jobs/1",
         "first_published": "2026-10-19T12:00:00Z"},
        {"title": "Senior Software Engineer", "absolute_url": "https://boards.greenhouse.io/acme/jobs/2",
         "first_published": "2026-10-13T12:00:00Z"},
    ]
    return make_fetch({url: (200, json.dumps({"jobs": jobs}))})


class DatePostedTests(unittest.TestCase):
    def run_window(self, date_posted):
        payload = {"route": GREENHOUSE, "slugs": ["acme"], "lists": [], "positions": POSITIONS,
                   "date_posted": date_posted, "now": NOW}
        return collect(payload, board_fetch(), sleep=lambda _: None)

    def urls(self, out):
        return sorted(c["url"][-1] for c in out["candidates"])

    def test_bool_map_true_key_is_the_window(self):
        code, out = self.run_window({"week": True})
        self.assertEqual(code, 0)
        self.assertEqual(self.urls(out), ["1"])

    def test_bool_map_without_true_key_is_no_bound(self):
        code, out = self.run_window({"week": False})
        self.assertEqual(code, 0)
        self.assertEqual(self.urls(out), ["1", "2"])

    def test_false_is_no_bound(self):
        code, out = self.run_window(False)
        self.assertEqual(code, 0)
        self.assertEqual(self.urls(out), ["1", "2"])

    def test_unknown_string_is_still_an_error(self):
        code, out = self.run_window("fortnight")
        self.assertEqual(code, 1)
        self.assertIn("collect_error", out)


class ListSkippedTests(unittest.TestCase):
    def test_skipped_rows_are_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "lever.csv")
            with open(path, "w", encoding="utf-8", newline="") as handle:
                handle.write("name,url\n"
                             "Acme,https://jobs.lever.co/acme\n"
                             "Beta,https://jobs.eu.lever.co/beta\n"
                             "Gamma,https://job-boards.greenhouse.io/gamma\n")
            payload = {"route": LEVER, "slugs": [], "lists": [path], "positions": POSITIONS,
                       "date_posted": "", "now": NOW}
            code, out = collect(payload, make_fetch({}), sleep=lambda _: None)
        self.assertEqual(code, 0)
        self.assertEqual(len(out["lists"]), 1)
        self.assertEqual(out["lists"][0]["slugs"], 1)
        self.assertEqual(out["lists"][0]["skipped"], 2)

    def test_failed_list_reports_zero_skipped(self):
        payload = {"route": LEVER, "slugs": [], "lists": ["https://lists.test/x.json"],
                   "positions": POSITIONS, "date_posted": "", "now": NOW}
        code, out = collect(payload, make_fetch({}), sleep=lambda _: None)
        self.assertEqual(out["lists"][0]["status"], "failed")
        self.assertEqual(out["lists"][0]["skipped"], 0)


if __name__ == "__main__":
    unittest.main()

import os
import tempfile
import unittest
from datetime import datetime, timezone

from collect import collect

NOW = "2026-10-22T12:00:00Z"
POSITIONS = ["Senior Software Engineer", "Backend Engineer"]

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


def gh_url(slug):
    return "https://boards-api.greenhouse.io/v1/boards/{0}/jobs?content=true".format(slug)


def lever_url(slug):
    return "https://api.lever.co/v0/postings/{0}?mode=json".format(slug)


def ok(value):
    import json
    return 200, json.dumps(value)


def make_fetch(responses):
    """Fake fetch: canned (status, body[, retry_after]) per URL, 404 otherwise; records calls."""
    calls = []

    def fetch(url):
        calls.append(url)
        value = responses.get(url, (404, ""))
        if isinstance(value, list):  # a sequence of responses, last one repeats
            index = min(sum(1 for c in calls if c == url) - 1, len(value) - 1)
            return value[index]
        return value

    fetch.calls = calls
    return fetch


def epoch_ms(year, month, day):
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp() * 1000)


class CollectTests(unittest.TestCase):
    def setUp(self):
        self.sleeps = []
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_collect(self, payload, fetch):
        return collect(payload, fetch, sleep=self.sleeps.append)

    def write(self, name, text):
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        return path

    def test_reads_every_list_and_every_slug_without_caps(self):
        import json
        json_slugs = ["a{0}".format(i) for i in range(75)]
        csv_text = "name,url\n" + "".join(
            "Co b{0},https://boards.greenhouse.io/b{0}\n".format(i) for i in range(75))
        csv_path = self.write("greenhouse.csv", csv_text)
        responses = {"https://lists.test/g.json": (200, json.dumps(json_slugs))}
        for slug in json_slugs + ["b{0}".format(i) for i in range(75)]:
            responses[gh_url(slug)] = ok({"jobs": [
                {"title": "Senior Software Engineer", "absolute_url": "https://boards.greenhouse.io/{0}/jobs/{1}".format(slug, n),
                 "first_published": "2026-10-20T10:00:00Z", "location": {"name": "Remote"}}
                for n in range(3)]})
        fetch = make_fetch(responses)
        code, out = self.run_collect({
            "route": GREENHOUSE, "slugs": [], "lists": ["https://lists.test/g.json", csv_path],
            "positions": POSITIONS, "date_posted": "week", "now": NOW}, fetch)
        self.assertEqual(code, 0)
        self.assertEqual(len(out["candidates"]), 450)
        self.assertEqual(len(out["slugs"]), 150)
        self.assertTrue(all(s["status"] == "ok" and s["items"] == 3 and s["kept"] == 3 for s in out["slugs"]))
        self.assertEqual([(l["status"], l["slugs"]) for l in out["lists"]], [("ok", 75), ("ok", 75)])
        self.assertEqual(sum(1 for c in fetch.calls if "boards-api" in c), 150)
        first = next(c for c in out["candidates"] if c["slug"] == "b3")
        self.assertEqual(first["company"], "Co b3")
        self.assertEqual(first["location"], "Remote")
        self.assertEqual(first["matched_query"], "Senior Software Engineer")

    def test_title_listed_and_date_filters(self):
        route = dict(GREENHOUSE, listed="isListed", date="published")
        base = "https://boards.greenhouse.io/acme/jobs/"
        jobs = [
            {"title": "Senior Software Engineer II", "absolute_url": base + "1", "published": "2026-10-21T12:00:00Z"},
            {"title": "Software Engineering Manager", "absolute_url": base + "2", "published": "2026-10-21T12:00:00Z"},
            {"title": "Backend Engineer (Remote)", "absolute_url": base + "3", "published": "2026-10-21T12:00:00Z", "isListed": False},
            {"title": "Senior Backend-Engineer", "absolute_url": base + "4", "published": "2026-10-13T12:00:00Z"},
            {"title": "Backend Engineer", "absolute_url": base + "5"},
            {"title": "Backend Engineer, Payments", "absolute_url": base + "6", "published": epoch_ms(2026, 10, 20)},
            {"title": "Senior Software Engineer", "absolute_url": base + "7", "published": int(epoch_ms(2026, 10, 19) / 1000)},
            {"title": "Senior Software Engineer", "absolute_url": base + "8", "published": epoch_ms(2026, 10, 10)},
        ]
        fetch = make_fetch({gh_url("acme"): ok({"jobs": jobs})})
        code, out = self.run_collect({
            "route": route, "slugs": ["acme"], "lists": [],
            "positions": POSITIONS, "date_posted": "week", "now": NOW}, fetch)
        self.assertEqual(code, 0)
        self.assertEqual([(c["url"], c["matched_query"]) for c in out["candidates"]], [
            (base + "1", "Senior Software Engineer"),
            (base + "6", "Backend Engineer"),
            (base + "7", "Senior Software Engineer"),
            (base + "5", "Backend Engineer"),
        ])
        self.assertEqual(out["candidates"][1]["date"], "2026-10-20T00:00:00Z")
        self.assertEqual(out["candidates"][3]["date"], "")
        self.assertEqual((out["slugs"][0]["items"], out["slugs"][0]["kept"]), (8, 4))

    def test_failed_slug_and_list_are_reported_not_zero(self):
        responses = {
            gh_url("good"): ok({"jobs": [{"title": "Backend Engineer", "absolute_url": "https://boards.greenhouse.io/good/jobs/1"}]}),
            gh_url("bad"): (500, "boom"),
            gh_url("slow"): [(429, "", "7"), ok({"jobs": []})],
            "https://lists.test/gone.json": (404, ""),
            "https://lists.test/garbage.json": (200, "[not json"),
        }
        fetch = make_fetch(responses)
        missing_file = os.path.join(self.tmp.name, "missing.csv")
        code, out = self.run_collect({
            "route": GREENHOUSE, "slugs": ["good", "bad", "slow"],
            "lists": ["https://lists.test/gone.json", "https://lists.test/garbage.json", missing_file],
            "positions": POSITIONS, "date_posted": "all_time", "now": NOW}, fetch)
        self.assertEqual(code, 0)
        by_slug = {s["slug"]: s for s in out["slugs"]}
        self.assertEqual(by_slug["good"]["status"], "ok")
        self.assertEqual(by_slug["bad"]["status"], "failed")
        self.assertTrue(by_slug["bad"]["error"])
        self.assertEqual((by_slug["bad"]["items"], by_slug["bad"]["kept"]), (0, 0))
        self.assertEqual(fetch.calls.count(gh_url("bad")), 5)
        self.assertEqual(by_slug["slow"]["status"], "ok")
        self.assertEqual(fetch.calls.count(gh_url("slow")), 2)
        self.assertIn(7.0, self.sleeps)
        self.assertEqual([l["status"] for l in out["lists"]], ["failed", "failed", "failed"])
        self.assertEqual(len(out["candidates"]), 1)

    def test_lever_eu_and_greenhouse_embed(self):
        lever_csv = self.write("lever.csv",
                               "name,url\nAcme,https://jobs.lever.co/acme\nEuco,https://jobs.eu.lever.co/euco\n"
                               "Api,https://api.eu.lever.co/v0/postings/apico\n")
        responses = {lever_url("acme"): ok([
            {"text": "Backend Engineer", "hostedUrl": "https://jobs.lever.co/acme/1",
             "createdAt": epoch_ms(2026, 10, 21), "categories": {"location": "Berlin"}}])}
        fetch = make_fetch(responses)
        code, out = self.run_collect({
            "route": LEVER, "slugs": [], "lists": [lever_csv],
            "positions": POSITIONS, "date_posted": "week", "now": NOW}, fetch)
        self.assertEqual(code, 0)
        self.assertEqual([s["slug"] for s in out["slugs"]], ["acme"])
        self.assertEqual(out["lists"][0]["slugs"], 1)
        self.assertEqual(fetch.calls, [lever_url("acme")])
        self.assertEqual(out["candidates"][0]["location"], "Berlin")
        self.assertEqual(out["candidates"][0]["company"], "Acme")

        gh_csv = self.write("greenhouse.csv",
                            "url\nhttps://job-boards.greenhouse.io/embed/job_app?for=acme&token=9\n"
                            "https://job-boards.greenhouse.io/embed/job_app?token=9\n"
                            "https://jobs.lever.co/zzz\n")
        fetch = make_fetch({gh_url("acme"): ok({"jobs": []})})
        code, out = self.run_collect({
            "route": GREENHOUSE, "slugs": [], "lists": [gh_csv],
            "positions": POSITIONS, "date_posted": "", "now": NOW}, fetch)
        self.assertEqual(code, 0)
        self.assertEqual([s["slug"] for s in out["slugs"]], ["acme"])
        self.assertEqual(fetch.calls, [gh_url("acme")])

    def test_bad_payload(self):
        good = {"route": GREENHOUSE, "slugs": [], "lists": [], "positions": POSITIONS,
                "date_posted": "week", "now": NOW}
        no_slug = dict(good, route=dict(GREENHOUSE, url="https://boards-api.greenhouse.io/v1/boards/jobs"))
        no_url = dict(good, route={k: v for k, v in GREENHOUSE.items() if k != "url"})
        for payload in ([], no_slug, no_url, dict(good, positions="Backend Engineer"),
                        {k: v for k, v in good.items() if k != "positions"}):
            code, out = self.run_collect(payload, make_fetch({}))
            self.assertEqual(code, 1)
            self.assertIn("collect_error", out)


if __name__ == "__main__":
    unittest.main()

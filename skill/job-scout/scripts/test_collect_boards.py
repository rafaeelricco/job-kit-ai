import json
import os
import tempfile
import unittest
from datetime import datetime, timezone

from collect import collect

NOW = "2026-10-22T12:00:00Z"
POSITIONS = ["Senior Software Engineer", "Backend Engineer"]
GREENHOUSE = {
    "kind": "board", "ats": "greenhouse",
    "url": "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
    "items": "jobs", "posting_url": "absolute_url", "title": "title",
    "location": "location.name", "date": "first_published",
}
LEVER = {
    "kind": "board", "ats": "lever",
    "url": "https://api.lever.co/v0/postings/{slug}?mode=json",
    "items": "$", "posting_url": "hostedUrl", "title": "text",
    "location": "categories.location", "date": "createdAt",
}
ROOTS = {"greenhouse": "https://job-boards.greenhouse.io/acme", "lever": "https://jobs.lever.co/acme"}
CANDIDATE_KEYS = ("slug", "company", "title", "url", "date", "location", "matched_query", "api_evidence")


def gh_api(slug):
    return GREENHOUSE["url"].replace("{slug}", slug)


def lever_api(slug):
    return LEVER["url"].replace("{slug}", slug)


def epoch_ms(day):
    return int(datetime(2026, 10, day, 12, tzinfo=timezone.utc).timestamp() * 1000)


def board(company_id="acme.com", name="Acme", url=ROOTS["greenhouse"], **extra):
    return dict({"company_id": company_id, "name": name, "url": url}, **extra)


def gh_job(slug="acme", job_id=1, **extra):
    return dict({
        "title": "Senior Software Engineer",
        "absolute_url": "https://job-boards.greenhouse.io/{0}/jobs/{1}".format(slug, job_id),
        "location": {"name": "Remote"},
        "first_published": "2026-10-21T12:00:00Z",
    }, **extra)


def lever_job(slug="acme", job_id="1", **extra):
    return dict({
        "text": "Backend Engineer",
        "hostedUrl": "https://jobs.lever.co/{0}/{1}".format(slug, job_id),
        "categories": {"location": "Remote"},
        "createdAt": epoch_ms(21),
        "descriptionPlain": "Build APIs",
    }, **extra)


def ok(value):
    return 200, json.dumps(value)


def make_fetch(responses):
    calls = []

    def fetch(url):
        calls.append(url)
        value = responses.get(url, (404, ""))
        if isinstance(value, list):
            index = min(sum(1 for call in calls if call == url) - 1, len(value) - 1)
            return value[index]
        return value

    fetch.calls = calls
    return fetch


class BoardApiTests(unittest.TestCase):
    def setUp(self):
        self.sleeps = []
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = directory.name

    def write(self, name, text):
        path = os.path.join(self.dir, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def payload(self, route, boards, **extra):
        return dict({"route": dict(route), "boards": boards, "positions": POSITIONS,
                     "date_posted": "week", "now": NOW}, **extra)

    def run_collect(self, payload, fetch):
        return collect(payload, fetch, sleep=self.sleeps.append)

    def summary(self, out):
        return [(row["slug"], row["status"], row["items"], row["kept"]) for row in out["slugs"]]

    def test_greenhouse_reads_us_legacy_and_eu_roots_and_keeps_employer_hosted_links(self):
        rows = [
            board(),
            board("beta.com", "Beta", "https://boards.greenhouse.io/beta/"),
            board("gamma.eu", "Gamma", "https://job-boards.eu.greenhouse.io/gamma?utm=x"),
            board("delta.eu", "Delta", "https://boards.eu.greenhouse.io/delta"),
        ]
        own_site = gh_job(absolute_url="http://acme.test/careers/1?gh_jid=1", content="&lt;p&gt;Build&lt;/p&gt;")
        fetch = make_fetch({
            gh_api("acme"): ok({"jobs": [own_site, gh_job(job_id=2, first_published="2026-10-01T09:00:00-04:00"),
                                         gh_job(job_id=3, title="Recruiter")]}),
            gh_api("beta"): ok({"jobs": []}),
            gh_api("gamma"): ok({"jobs": [gh_job("gamma", 9)]}),
            gh_api("delta"): ok({"jobs": []}),
        })
        code, out = self.run_collect(self.payload(GREENHOUSE, rows), fetch)

        self.assertEqual(code, 0)
        self.assertCountEqual(fetch.calls, [gh_api("acme"), gh_api("beta"), gh_api("gamma"), gh_api("delta")])
        self.assertEqual(self.summary(out), [("acme", "ok", 3, 1), ("beta", "ok", 0, 0), ("gamma", "ok", 1, 1),
                                             ("delta", "ok", 0, 0)])
        acme = next(row for row in out["candidates"] if row["slug"] == "acme")
        self.assertEqual(tuple(acme), CANDIDATE_KEYS)
        self.assertEqual((acme["company"], acme["url"], acme["location"], acme["date"]),
                         ("Acme", own_site["absolute_url"], "Remote", "2026-10-21T12:00:00Z"))
        self.assertEqual(acme["api_evidence"], {
            "request_url": gh_api("acme"), "board_url": ROOTS["greenhouse"], "job": own_site,
        })
        self.assertEqual(out["lists"], [])

    def test_greenhouse_route_without_content_is_accepted_and_optional_paths_default(self):
        bare = "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
        route = {key: value for key, value in GREENHOUSE.items() if key not in ("location", "date")}
        route["url"] = bare
        request = bare.replace("{slug}", "acme")
        fetch = make_fetch({request: ok({"jobs": [gh_job(), gh_job(job_id=2, first_published="2026-10-01T12:00:00Z")]})})
        code, out = self.run_collect(self.payload(route, [board()]), fetch)

        self.assertEqual(code, 0)
        [candidate] = out["candidates"]
        self.assertEqual((candidate["url"], candidate["location"], candidate["api_evidence"]["request_url"]),
                         ("https://job-boards.greenhouse.io/acme/jobs/1", "Remote", request))

    def test_lever_reads_a_root_array_and_keeps_tenant_case(self):
        rows = [
            board("01health.ai", "01Health", "https://jobs.lever.co/32Co"),
            board("empty.co", "Empty", "https://jobs.lever.co/empty"),
        ]
        fetch = make_fetch({
            lever_api("32Co"): ok([lever_job("32Co", "a"), lever_job("32Co", "old", createdAt=epoch_ms(1))]),
            lever_api("empty"): ok([]),
        })
        code, out = self.run_collect(self.payload(LEVER, rows), fetch)

        self.assertEqual(code, 0)
        self.assertCountEqual(fetch.calls, [lever_api("32Co"), lever_api("empty")])
        self.assertEqual(self.summary(out), [("32Co", "ok", 2, 1), ("empty", "ok", 0, 0)])
        [candidate] = out["candidates"]
        self.assertEqual(tuple(candidate), CANDIDATE_KEYS)
        self.assertEqual(
            (candidate["company"], candidate["url"], candidate["location"], candidate["date"], candidate["matched_query"]),
            ("01Health", "https://jobs.lever.co/32Co/a", "Remote", "2026-10-21T12:00:00Z", "Backend Engineer"))
        self.assertEqual(candidate["api_evidence"]["job"]["descriptionPlain"], "Build APIs")

    def test_roots_on_another_host_or_instance_fail_only_their_board_without_a_get(self):
        cases = [
            (LEVER, "https://jobs.eu.lever.co/acme"),
            (LEVER, "https://jobs.ashbyhq.com/acme"),
            (LEVER, "https://jobs.lever.co/acme/1234"),
            (GREENHOUSE, "https://job-boards.greenhouse.io/embed/job_board?for=acme"),
            (GREENHOUSE, "https://job-boards.greenhouse.io/acme/jobs/1"),
            (GREENHOUSE, "https://greenhouse.io/acme"),
        ]
        for route, url in cases:
            with self.subTest(url=url):
                fetch = make_fetch({})
                code, out = self.run_collect(self.payload(route, [board(url=url)]), fetch)
                self.assertEqual(code, 0)
                [report] = out["slugs"]
                self.assertEqual((report["status"], report["board_url"], report["http_status"]), ("failed", url, 0))
                self.assertTrue(report["error"].startswith("invalid board url: "))
                self.assertEqual(fetch.calls, [])

    def test_posting_links_are_checked_per_ats(self):
        cases = [
            (LEVER, lever_api("acme"), [lever_job(hostedUrl="https://jobs.lever.co/other/1")]),
            (LEVER, lever_api("acme"), [lever_job(hostedUrl="https://evil.example/acme/1")]),
            (LEVER, lever_api("acme"), [lever_job(hostedUrl="https://jobs.lever.co/acme/1/apply")]),
            (GREENHOUSE, gh_api("acme"), {"jobs": [gh_job(absolute_url="ftp://acme.test/jobs/1")]}),
            (GREENHOUSE, gh_api("acme"), {"jobs": [gh_job(absolute_url="/jobs/1")]}),
            (GREENHOUSE, gh_api("acme"), {"jobs": [{"title": "Backend Engineer"}]}),
        ]
        for index, (route, request, body) in enumerate(cases):
            with self.subTest(index=index):
                rows = [board(url=ROOTS[route["ats"]])]
                code, out = self.run_collect(self.payload(route, rows), make_fetch({request: ok(body)}))
                self.assertEqual((code, out["candidates"]), (0, []))
                [report] = out["slugs"]
                self.assertEqual(report["status"], "failed")
                self.assertIn("unsafe posting URL", report["error"])

    def test_route_must_be_the_official_api_shape_before_any_fetch(self):
        invalid_routes = [
            dict(GREENHOUSE, url="https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=false"),
            dict(GREENHOUSE, url="https://evil.example/v1/boards/{slug}/jobs"),
            dict(GREENHOUSE, posting_url="url"),
            dict(GREENHOUSE, date="updated_at"),
            dict(LEVER, url="https://api.lever.co/v0/postings/{slug}"),
            dict(LEVER, url="https://api.eu.lever.co/v0/postings/{slug}?mode=json"),
            dict(LEVER, items="data"),
            dict(LEVER, ats="workday"),
        ]
        for route in invalid_routes:
            with self.subTest(route=route):
                fetch = make_fetch({})
                code, out = self.run_collect(self.payload(route, [board(url=ROOTS.get(route["ats"], ROOTS["lever"]))]), fetch)
                self.assertEqual(code, 1)
                self.assertIn("collect_error", out)
                self.assertEqual(fetch.calls, [])

    def test_slug_lists_add_boards_after_pack_rows_and_skip_taken_or_disabled_tenants(self):
        path = self.write("greenhouse.csv", "\n".join([
            "name,url",
            "Acme Listed,https://job-boards.greenhouse.io/ACME",
            "Off Listed,https://job-boards.greenhouse.io/off",
            "Delta,https://job-boards.greenhouse.io/delta",
            "Embed,https://job-boards.greenhouse.io/embed/job_board?for=epsilon",
            "Elsewhere,https://jobs.lever.co/zeta",
        ]) + "\n")
        missing = os.path.join(self.dir, "missing.csv")
        rows = [board(), board("off.com", "Off", "https://job-boards.greenhouse.io/off", enabled=False)]
        fetch = make_fetch({gh_api(slug): ok({"jobs": [gh_job(slug)]}) for slug in ("acme", "delta", "epsilon")})
        code, out = self.run_collect(self.payload(GREENHOUSE, rows, lists=[path, missing]), fetch)

        self.assertEqual(code, 0)
        self.assertCountEqual(fetch.calls, [gh_api("acme"), gh_api("delta"), gh_api("epsilon")])
        self.assertEqual([(row["company_id"], row["name"], row["slug"], row["board_url"]) for row in out["slugs"]], [
            ("acme.com", "Acme", "acme", ROOTS["greenhouse"]),
            ("", "Delta", "delta", "https://job-boards.greenhouse.io/delta"),
            ("", "Embed", "epsilon", "https://job-boards.greenhouse.io/epsilon"),
        ])
        self.assertCountEqual([row["company"] for row in out["candidates"]], ["Acme", "Delta", "Embed"])
        read, failed = out["lists"]
        self.assertEqual((read["source"], read["status"], read["slugs"], read["skipped"]), (path, "ok", 4, 1))
        self.assertEqual((failed["source"], failed["status"]), (missing, "failed"))

    def test_lists_alone_scan_and_an_unsafe_list_slug_fails_only_its_board(self):
        path = self.write("lever.json", '["acme", ".."]')
        fetch = make_fetch({lever_api("acme"): ok([lever_job()])})
        code, out = self.run_collect(self.payload(LEVER, [], lists=[path]), fetch)

        self.assertEqual(code, 0)
        self.assertEqual(fetch.calls, [lever_api("acme")])
        good, bad = out["slugs"]
        self.assertEqual((good["slug"], good["name"], good["board_url"], good["status"], good["kept"]),
                         ("acme", "acme", ROOTS["lever"], "ok", 1))
        self.assertEqual((bad["status"], bad["http_status"]), ("failed", 0))
        self.assertIn("invalid board url", bad["error"])


if __name__ == "__main__":
    unittest.main()

import io
import json
import sys
import unittest
from unittest import mock

import collect as collect_module
from collect import collect


NOW = "2026-10-22T12:00:00Z"
POSITIONS = ["Senior Software Engineer", "Backend Engineer"]
ROUTE = {
    "kind": "board",
    "ats": "ashby",
    "url": "https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true",
    "items": "jobs",
    "posting_url": "jobUrl",
    "title": "title",
    "location": "location",
    "date": "publishedAt",
    "listed": "isListed",
}


def api_url(slug):
    return "https://api.ashbyhq.com/posting-api/job-board/{0}?includeCompensation=true".format(slug)


def board(company_id="acme", name="Acme", url="https://jobs.ashbyhq.com/acme", **extra):
    result = {"company_id": company_id, "name": name, "url": url}
    result.update(extra)
    return result


def job(slug="acme", job_id="1", **extra):
    result = {
        "title": "Senior Software Engineer",
        "jobUrl": "https://jobs.ashbyhq.com/{0}/{1}".format(slug, job_id),
        "isListed": True,
        "publishedAt": "2026-10-21T12:00:00Z",
        "location": "Remote",
    }
    result.update(extra)
    return result


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


class AshbyCollectTests(unittest.TestCase):
    def setUp(self):
        self.sleeps = []

    def payload(self, boards=None, **extra):
        result = {
            "route": dict(ROUTE),
            "boards": [board()] if boards is None else boards,
            "positions": POSITIONS,
            "date_posted": "week",
            "now": NOW,
        }
        result.update(extra)
        return result

    def run_collect(self, payload, fetch):
        return collect(payload, fetch, sleep=self.sleeps.append)

    def test_official_request_candidate_shape_and_full_api_evidence(self):
        original = job(descriptionHtml="<p>Build useful tools</p>", compensation={"currencyCode": "USD"})
        original["jobUrl"] = "https://jobs.ashbyhq.com/acme/1/application"
        fetch = make_fetch({api_url("acme"): ok({"jobs": [original]})})
        code, out = self.run_collect(self.payload(), fetch)

        self.assertEqual(code, 0)
        self.assertEqual(fetch.calls, [api_url("acme")])
        candidate = out["candidates"][0]
        self.assertEqual(tuple(candidate),
                         ("slug", "company", "title", "url", "date", "location", "matched_query", "api_evidence"))
        self.assertEqual(candidate["slug"], "acme")
        self.assertEqual(candidate["company"], "Acme")
        self.assertEqual(candidate["url"], original["jobUrl"])
        self.assertEqual(candidate["api_evidence"], {
            "request_url": api_url("acme"),
            "board_url": "https://jobs.ashbyhq.com/acme",
            "job": original,
        })
        self.assertEqual(out["slugs"], [{
            "company_id": "acme", "name": "Acme", "slug": "acme",
            "board_url": "https://jobs.ashbyhq.com/acme", "status": "ok", "error": "",
            "items": 1, "kept": 1, "http_status": 200,
        }])
        self.assertEqual(out["lists"], [])

    def test_filters_titles_listed_and_dates_but_keeps_optional_fields_absent(self):
        jobs = [
            job(job_id="listed"),
            job(job_id="unlisted", isListed=False),
            job(job_id="old", publishedAt="2026-10-01T12:00:00Z"),
            job(job_id="mismatch", title="Software Engineering Manager"),
            {"title": "Backend Engineer", "jobUrl": "https://jobs.ashbyhq.com/acme/without-metadata"},
        ]
        fetch = make_fetch({api_url("acme"): ok({"jobs": jobs})})
        code, out = self.run_collect(self.payload(), fetch)

        self.assertEqual(code, 0)
        self.assertEqual([item["url"] for item in out["candidates"]], [
            "https://jobs.ashbyhq.com/acme/listed",
            "https://jobs.ashbyhq.com/acme/without-metadata",
        ])
        self.assertEqual(out["candidates"][0]["matched_query"], "Senior Software Engineer")
        self.assertEqual(out["candidates"][1]["matched_query"], "Backend Engineer")
        self.assertEqual(out["candidates"][1]["date"], "")
        self.assertEqual(out["candidates"][1]["location"], "")
        self.assertEqual((out["slugs"][0]["items"], out["slugs"][0]["kept"]), (5, 2))

    def test_standard_optional_ashby_paths_apply_when_route_omits_them(self):
        route = {key: value for key, value in ROUTE.items() if key not in ("location", "date", "listed")}
        jobs = [
            job(job_id="listed", publishedAt="2026-10-21T12:00:00Z", location="Remote"),
            job(job_id="unlisted", isListed=False),
        ]
        fetch = make_fetch({api_url("acme"): ok({"jobs": jobs})})
        code, out = self.run_collect(self.payload(route=route), fetch)

        self.assertEqual(code, 0)
        self.assertEqual([item["url"] for item in out["candidates"]],
                         ["https://jobs.ashbyhq.com/acme/listed"])
        self.assertEqual(out["candidates"][0]["location"], "Remote")
        self.assertEqual(out["candidates"][0]["date"], "2026-10-21T12:00:00Z")

    def test_disabled_boards_and_casefolded_tenants_are_skipped_or_deduplicated_in_order(self):
        rows = [
            board("off", "Off", "https://jobs.ashbyhq.com/off", enabled=False),
            board("first", "First Name", "https://jobs.ashbyhq.com/Acme/"),
            board("duplicate", "Duplicate Name", "https://jobs.ashbyhq.com/acme"),
            board("second", "Second", "https://jobs.ashbyhq.com/beta"),
        ]
        fetch = make_fetch({api_url("Acme"): ok({"jobs": []}), api_url("beta"): ok({"jobs": []})})
        code, out = self.run_collect(self.payload(rows), fetch)

        self.assertEqual(code, 0)
        self.assertCountEqual(fetch.calls, [api_url("Acme"), api_url("beta")])
        self.assertEqual([item["company_id"] for item in out["slugs"]], ["first", "second"])
        self.assertEqual([item["name"] for item in out["slugs"]], ["First Name", "Second"])

        fetch = make_fetch({})
        code, out = self.run_collect(self.payload([{
            "enabled": False, "url": "https://jobs.ashbyhq.com/%2e%2e",
        }]), fetch)
        self.assertEqual((code, out["candidates"], out["slugs"], out["lists"], fetch.calls), (0, [], [], [], []))

    def test_invalid_board_urls_fail_only_their_board_without_a_get(self):
        invalid_urls = [
            "ftp://jobs.ashbyhq.com/acme",
            "https://evil.example/acme",
            "https://user@jobs.ashbyhq.com/acme",
            "https://jobs.ashbyhq.com:443/acme",
            "https://jobs.ashbyhq.com/acme/jobs/123",
            "https://jobs.ashbyhq.com/acme%2fother",
            "https://jobs.ashbyhq.com/../other",
            "https://jobs.ashbyhq.com/%2e%2e",
        ]
        for url in invalid_urls:
            with self.subTest(url=url):
                fetch = make_fetch({})
                code, out = self.run_collect(self.payload([board(url=url)]), fetch)
                self.assertEqual(code, 0)
                self.assertEqual(out["candidates"], [])
                [report] = out["slugs"]
                self.assertEqual((report["company_id"], report["board_url"], report["status"]),
                                 ("acme", url, "failed"))
                self.assertTrue(report["error"].startswith("invalid board url: "))
                self.assertEqual(fetch.calls, [])

    def test_http_query_and_fragment_board_roots_request_only_the_tenant(self):
        rows = [
            board("beta", "Beta", "https://jobs.ashbyhq.com/beta?utm_source=careers"),
            board("gamma", "Gamma", "http://jobs.ashbyhq.com/gamma/#jobs"),
        ]
        fetch = make_fetch({api_url("beta"): ok({"jobs": [job("beta")]}),
                            api_url("gamma"): ok({"jobs": [job("gamma")]})})
        code, out = self.run_collect(self.payload(rows), fetch)

        self.assertEqual(code, 0)
        self.assertCountEqual(fetch.calls, [api_url("beta"), api_url("gamma")])
        self.assertEqual([(row["slug"], row["status"]) for row in out["slugs"]],
                         [("beta", "ok"), ("gamma", "ok")])
        self.assertEqual(out["slugs"][0]["board_url"], "https://jobs.ashbyhq.com/beta?utm_source=careers")

    def test_one_invalid_board_url_does_not_stop_valid_boards_in_the_pack(self):
        rows = [
            board(),
            board("beta", "Beta", "https://evil.example/beta"),
            board("gamma", "Gamma", "https://jobs.ashbyhq.com/gamma/jobs/1"),
        ]
        fetch = make_fetch({api_url("acme"): ok({"jobs": [job()]})})
        code, out = self.run_collect(self.payload(rows), fetch)

        self.assertEqual(code, 0)
        self.assertEqual(fetch.calls, [api_url("acme")])
        self.assertEqual([row["slug"] for row in out["candidates"]], ["acme"])
        acme, beta, gamma = out["slugs"]
        self.assertEqual((acme["status"], acme["kept"]), ("ok", 1))
        for report in (beta, gamma):
            self.assertEqual((report["status"], report["http_status"]), ("failed", 0))
            self.assertIn("invalid board url", report["error"])

    def test_official_api_url_variants_build_the_request_from_the_route(self):
        base = "https://api.ashbyhq.com/posting-api/job-board/{slug}"
        for url in (base, base + "?includeCompensation=false"):
            with self.subTest(url=url):
                expected = url.replace("{slug}", "acme")
                fetch = make_fetch({expected: ok({"jobs": [job()]})})
                code, out = self.run_collect(self.payload(route=dict(ROUTE, url=url)), fetch)
                self.assertEqual(code, 0)
                self.assertEqual(fetch.calls, [expected])
                self.assertEqual(out["candidates"][0]["api_evidence"]["request_url"], expected)

    def test_main_writes_valid_output_when_a_description_has_a_lone_surrogate(self):
        rows = [board(), board("good", "Good", "https://jobs.ashbyhq.com/good")]
        bodies = {
            api_url("acme"): '{"jobs": [' + json.dumps(job())[:-1] + ', "descriptionPlain": "Great team \\ud83d"}]}',
            api_url("good"): json.dumps({"jobs": [job("good")]}),
        }
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(self.payload(rows)).encode("utf-8")))
        stdout = io.TextIOWrapper(io.BytesIO())
        with mock.patch.object(collect_module, "http_fetch", lambda url: (200, bodies[url], None)), \
                mock.patch.object(sys, "stdin", stdin), mock.patch.object(sys, "stdout", stdout):
            code = collect_module.main()
        out = json.loads(stdout.buffer.getvalue().decode("utf-8"))
        self.assertEqual(code, 0)
        self.assertEqual([row["status"] for row in out["slugs"]], ["ok", "ok"])
        acme = next(row for row in out["candidates"] if row["slug"] == "acme")
        self.assertEqual(acme["api_evidence"]["job"]["descriptionPlain"], "Great team \ud83d")

    def test_route_rows_and_legacy_inputs_are_validated_before_fetch(self):
        invalid_payloads = [
            self.payload([board(enabled="false")]),
            self.payload([board(managed_by="other-tool")]),
            self.payload([{"name": "Acme", "url": "https://jobs.ashbyhq.com/acme"}]),
            self.payload([{"enabled": False, "url": "https://jobs.ashbyhq.com/%2e%2e"}], slugs=["extra"]),
            self.payload([board()], slugs=["extra"]),
            self.payload([board()], lists=["https://example.test/slugs.csv"]),
            self.payload([board()], route=dict(ROUTE, ats="greenhouse")),
            self.payload([board()], route=dict(ROUTE, items="data.jobs")),
            self.payload([board()], route=dict(ROUTE, url="https://evil.example/{slug}")),
            self.payload([board()], route=dict(ROUTE, url="https://api.ashbyhq.com/posting-api/job-board/{slug}?x=1")),
            self.payload([board()], route=dict(ROUTE, url="http://api.ashbyhq.com/posting-api/job-board/{slug}")),
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                fetch = make_fetch({})
                code, out = self.run_collect(payload, fetch)
                self.assertEqual(code, 1)
                self.assertIn("collect_error", out)
                self.assertEqual(fetch.calls, [])

    def test_malformed_http_json_and_schema_failures_differ_from_empty_success(self):
        responses = {
            api_url("empty"): ok({"jobs": []}),
            api_url("missing"): ok({"data": []}),
            api_url("broken"): (200, "not json"),
        }
        rows = [
            board("empty", "Empty", "https://jobs.ashbyhq.com/empty"),
            board("missing", "Missing", "https://jobs.ashbyhq.com/missing"),
            board("broken", "Broken", "https://jobs.ashbyhq.com/broken"),
        ]
        code, out = self.run_collect(self.payload(rows), make_fetch(responses))

        self.assertEqual(code, 0)
        reports = {item["company_id"]: item for item in out["slugs"]}
        self.assertEqual((reports["empty"]["status"], reports["empty"]["items"]), ("ok", 0))
        self.assertEqual(reports["missing"]["status"], "failed")
        self.assertIn("items path", reports["missing"]["error"])
        self.assertEqual(reports["broken"]["status"], "failed")
        self.assertEqual(reports["broken"]["error"], "non-JSON response")
        self.assertEqual(out["candidates"], [])

    def test_bad_rows_and_unsafe_posting_urls_fail_only_their_board(self):
        bad_jobs = [
            ["not an object"],
            [{"jobUrl": "https://jobs.ashbyhq.com/acme/1"}],
            [job(jobUrl="https://evil.example/acme/1")],
            [job(jobUrl="http://jobs.ashbyhq.com/acme/1")],
            [job(jobUrl="https://jobs.ashbyhq.com/other/1")],
            [job(jobUrl="https://jobs.ashbyhq.com/acme/%2e%2e")],
            [job(jobUrl="https://jobs.ashbyhq.com/acme/1/other")],
            [job(jobUrl="https://jobs.ashbyhq.com/acme/1?source=jobs")],
            [job(jobUrl="https://jobs.ashbyhq.com:443/acme/1")],
            [job(jobUrl="https://user@jobs.ashbyhq.com/acme/1")],
            [job(jobUrl="https://jobs.ashbyhq.com/acme%2fother/1")],
            [job(isListed="false")],
        ]
        for index, jobs in enumerate(bad_jobs):
            with self.subTest(index=index):
                rows = [board(), board("good", "Good", "https://jobs.ashbyhq.com/good")]
                responses = {
                    api_url("acme"): ok({"jobs": jobs}),
                    api_url("good"): ok({"jobs": [job("good")]}),
                }
                code, out = self.run_collect(self.payload(rows), make_fetch(responses))
                self.assertEqual(code, 0)
                self.assertEqual([row["slug"] for row in out["candidates"]], ["good"])
                bad, good = out["slugs"]
                self.assertEqual((bad["status"], bad["kept"]), ("failed", 0))
                expected = ("not an object" if index == 0 else "no title" if index == 1
                            else "invalid isListed" if index == len(bad_jobs) - 1
                            else "unsafe posting URL")
                self.assertIn(expected, bad["error"])
                self.assertEqual((good["status"], good["kept"]), ("ok", 1))

    def test_board_http_failures_retry_and_partial_success_are_reported(self):
        rows = [
            board("retry", "Retry", "https://jobs.ashbyhq.com/retry"),
            board("down", "Down", "https://jobs.ashbyhq.com/down"),
        ]
        responses = {
            api_url("retry"): [(429, "", "3"), ok({"jobs": [job("retry")]})],
            api_url("down"): [(503, "still down")],
        }
        fetch = make_fetch(responses)
        code, out = self.run_collect(self.payload(rows), fetch)

        self.assertEqual(code, 0)
        reports = {item["company_id"]: item for item in out["slugs"]}
        self.assertEqual((reports["retry"]["status"], reports["retry"]["http_status"]), ("ok", 200))
        self.assertEqual((reports["down"]["status"], reports["down"]["http_status"]), ("failed", 503))
        self.assertEqual(fetch.calls.count(api_url("retry")), 2)
        self.assertEqual(fetch.calls.count(api_url("down")), 5)
        self.assertIn(3.0, self.sleeps)
        self.assertEqual(len(out["candidates"]), 1)

    def test_legacy_route_shape_is_unchanged_when_boards_key_is_absent(self):
        legacy_route = {
            "kind": "board", "ats": "greenhouse",
            "url": "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
            "items": "jobs", "posting_url": "absolute_url", "title": "title",
        }
        legacy_url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true"
        payload = {
            "route": legacy_route, "slugs": ["acme"], "lists": [],
            "positions": POSITIONS, "date_posted": "week", "now": NOW,
        }
        fetch = make_fetch({legacy_url: ok({"jobs": [{
            "title": "Backend Engineer", "absolute_url": "https://boards.greenhouse.io/acme/jobs/1",
        }]})})
        code, out = self.run_collect(payload, fetch)

        self.assertEqual(code, 0)
        self.assertEqual(set(out), {"candidates", "slugs", "lists"})
        self.assertEqual(set(out["candidates"][0]), {
            "slug", "company", "title", "url", "date", "location", "matched_query",
        })


if __name__ == "__main__":
    unittest.main()

import csv
import json
import os
import tempfile
import unittest

from collect_companies import FetchError, board_jobs, collect, title_match

HEADER = ["row_id", "region", "tier", "company_name", "ats", "ats_tenant"]
ROWS = [
    ["US-001", "US", "A", "Acme", "greenhouse", "acme"],
    ["UK-001", "UK", "A", "Brit", "workday", "brit/wd3/britcareers"],
    ["EU-001", "EU", "A", "Euro", "eightfold", "euro"],
    ["US-002", "US", "C", "Late", "greenhouse", "late"],
]
POSITIONS = ["Software Engineer", "Product Engineer"]


def gh(*titles):
    return {"jobs": [{"title": t, "absolute_url": "https://job-boards.greenhouse.io/acme/jobs/{}".format(i),
                      "location": {"name": "Remote"}, "first_published": "2026-10-20T10:00:00Z"}
                     for i, t in enumerate(titles)]}


class Fake:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, body):
        self.calls.append((url, body))
        answer = self.routes[url]
        if isinstance(answer, Exception):
            raise answer
        return answer(body) if callable(answer) else answer


class CollectTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.csv = os.path.join(self.dir, "companies.csv")
        with open(self.csv, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(HEADER)
            writer.writerows(ROWS)
        self.state = os.path.join(self.dir, "state.json")

    def payload(self, **over):
        p = {"csv": self.csv, "state": self.state, "pack": "companies", "regions": ["UK", "US", "EU"],
             "tiers": ["A"], "positions": POSITIONS, "limit": 40}
        p.update(over)
        return p

    def test_title_match_is_whole_word_and_ordered(self):
        self.assertEqual(title_match("Senior Software Engineer, AI", POSITIONS), "Software Engineer")
        self.assertIsNone(title_match("Software Engineering Manager", POSITIONS))
        self.assertEqual(title_match("product engineer (remote)", POSITIONS), "Product Engineer")

    def test_bad_payload_is_a_collect_error(self):
        code, out = collect({"state": self.state}, Fake({}), "2026-10-22T00:00:00+00:00")
        self.assertEqual(code, 1)
        self.assertIn("collect_error", out)

    def test_selects_by_region_and_tier_and_reports_unsupported(self):
        fake = Fake({
            "https://boards-api.greenhouse.io/v1/boards/acme/jobs": gh("Senior Software Engineer", "Recruiter"),
            "https://brit.wd3.myworkdayjobs.com/wday/cxs/brit/britcareers/jobs": {"total": 0, "jobPostings": []},
        })
        code, out = collect(self.payload(), fake, "2026-10-22T00:00:00+00:00")
        self.assertEqual(code, 0)
        self.assertEqual([c["title"] for c in out["candidates"]], ["Senior Software Engineer"])
        row = out["candidates"][0]
        self.assertEqual((row["company"], row["source"], row["channel"], row["matched_query"], row["date"]),
                         ("Acme", "companies", "ats", "Software Engineer", "2026-10-20"))
        self.assertEqual(out["boards"]["unsupported"], [{"row_id": "EU-001", "ats": "eightfold"}])
        self.assertNotIn("late", json.dumps(fake.calls))

    def test_overflow_queues_and_next_call_emits_queue_first(self):
        fake = Fake({
            "https://boards-api.greenhouse.io/v1/boards/acme/jobs": gh("Software Engineer", "Product Engineer"),
            "https://brit.wd3.myworkdayjobs.com/wday/cxs/brit/britcareers/jobs": {"total": 0, "jobPostings": []},
        })
        _, first = collect(self.payload(regions=["US"], limit=1), fake, "2026-10-22T00:00:00+00:00")
        self.assertEqual((len(first["candidates"]), first["queued"]), (1, 1))
        calls = len(fake.calls)
        _, second = collect(self.payload(regions=["US"], limit=1), fake, "2026-10-22T01:00:00+00:00")
        self.assertEqual(second["candidates"][0]["title"], "Product Engineer")
        self.assertEqual(len(fake.calls), calls)

    def test_failed_board_is_not_zero_jobs_and_is_retried(self):
        fake = Fake({"https://boards-api.greenhouse.io/v1/boards/acme/jobs": FetchError("HTTP 503")})
        _, out = collect(self.payload(regions=["US"]), fake, "2026-10-22T00:00:00+00:00")
        self.assertEqual(out["candidates"], [])
        self.assertEqual(out["boards"]["failed"], [{"row_id": "US-001", "ats": "greenhouse", "error": "HTTP 503"}])
        fake.routes["https://boards-api.greenhouse.io/v1/boards/acme/jobs"] = gh("Software Engineer")
        _, again = collect(self.payload(regions=["US"]), fake, "2026-10-22T01:00:00+00:00")
        self.assertEqual(len(again["candidates"]), 1)

    def test_oldest_checked_board_goes_first(self):
        with open(self.state, "w", encoding="utf-8") as f:
            json.dump({"boards": {"US-001": {"checked_at": "2026-10-21T00:00:00+00:00", "status": "done"}},
                       "queue": []}, f)
        fake = Fake({
            "https://boards-api.greenhouse.io/v1/boards/acme/jobs": gh(),
            "https://brit.wd3.myworkdayjobs.com/wday/cxs/brit/britcareers/jobs": {"total": 0, "jobPostings": []},
        })
        collect(self.payload(regions=["UK", "US"]), fake, "2026-10-22T00:00:00+00:00")
        self.assertIn("myworkdayjobs", fake.calls[0][0])

    def test_workday_pages_per_position_and_builds_posting_urls(self):
        def page(body):
            if body["searchText"] != "Software Engineer":
                return {"total": 0, "jobPostings": []}
            start = body["offset"]
            jobs = [{"title": "Software Engineer {}".format(i), "externalPath": "/job/Remote/SE_{}".format(i),
                     "locationsText": "Remote", "postedOn": "Posted Today"} for i in range(start, min(start + 20, 25))]
            return {"total": 25, "jobPostings": jobs}
        fake = Fake({"https://brit.wd3.myworkdayjobs.com/wday/cxs/brit/britcareers/jobs": page})
        jobs = board_jobs("workday", "brit/wd3/britcareers", POSITIONS, fake)
        self.assertEqual(len(jobs), 25)
        self.assertEqual(jobs[0]["url"], "https://brit.wd3.myworkdayjobs.com/britcareers/job/Remote/SE_0")
        self.assertEqual(jobs[0]["date"], "—")
        self.assertEqual([c[1]["offset"] for c in fake.calls if c[1]["searchText"] == "Software Engineer"], [0, 20])


class CoverageRegressionTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.csv = os.path.join(self.dir, "companies.csv")
        with open(self.csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            writer.writerow(HEADER + ["ats_evidence"])
            writer.writerow(["US-001", "US", "A", "Acme", "greenhouse", "acme",
                             "https://job-boards.greenhouse.io/acme"])
            writer.writerow(["UK-002", "UK", "A", "Move", "greenhouse", "move",
                             "https://job-boards.eu.greenhouse.io/move"])
            writer.writerow(["UK-003", "UK", "C", "Blank", "", "", ""])
        self.state = os.path.join(self.dir, "state.json")

    def payload(self, **over):
        p = {"csv": self.csv, "state": self.state, "pack": "companies", "regions": ["UK", "US"],
             "tiers": ["A", "C"], "positions": POSITIONS, "limit": 40}
        p.update(over)
        return p

    def test_eu_instance_is_unsupported_and_no_ats_is_counted(self):
        fake = Fake({"https://boards-api.greenhouse.io/v1/boards/acme/jobs": gh()})
        _, out = collect(self.payload(), fake, "2026-10-22T00:00:00+00:00")
        self.assertEqual(out["boards"]["unsupported"], [{"row_id": "UK-002", "ats": "greenhouse-eu"}])
        self.assertEqual(out["boards"]["no_ats"], 1)
        self.assertEqual(len(fake.calls), 1)

    def test_refetched_board_queues_only_new_postings(self):
        fake = Fake({"https://boards-api.greenhouse.io/v1/boards/acme/jobs": gh("Software Engineer")})
        _, first = collect(self.payload(), fake, "2026-10-22T00:00:00+00:00")
        self.assertEqual(len(first["candidates"]), 1)
        fake.routes["https://boards-api.greenhouse.io/v1/boards/acme/jobs"] = gh("Software Engineer", "Product Engineer")
        _, second = collect(self.payload(), fake, "2026-10-23T00:00:00+00:00")
        self.assertEqual([c["title"] for c in second["candidates"]], ["Product Engineer"])

    def test_workday_keeps_first_page_total(self):
        def page(body):
            start = body["offset"]
            jobs = [{"title": "Software Engineer {}".format(i), "externalPath": "/job/SE_{}".format(i)}
                    for i in range(start, min(start + 20, 50))] if body["searchText"] == "Software Engineer" else []
            return {"total": 50 if start == 0 else 0, "jobPostings": jobs}
        fake = Fake({"https://brit.wd3.myworkdayjobs.com/wday/cxs/brit/britcareers/jobs": page})
        self.assertEqual(len(board_jobs("workday", "brit/wd3/britcareers", POSITIONS, fake)), 50)

    def test_failed_fetch_keeps_sent_postings(self):
        fake = Fake({"https://boards-api.greenhouse.io/v1/boards/acme/jobs": gh("Software Engineer")})
        _, first = collect(self.payload(), fake, "2026-10-20T00:00:00+00:00")
        self.assertEqual(len(first["candidates"]), 1)
        fake.routes["https://boards-api.greenhouse.io/v1/boards/acme/jobs"] = FetchError("HTTP 503")
        _, failed = collect(self.payload(), fake, "2026-10-21T00:00:00+00:00")
        self.assertEqual(len(failed["boards"]["failed"]), 1)
        fake.routes["https://boards-api.greenhouse.io/v1/boards/acme/jobs"] = gh("Software Engineer")
        _, recovered = collect(self.payload(), fake, "2026-10-22T00:00:00+00:00")
        self.assertEqual(recovered["candidates"], [])

    def test_queue_follows_current_selection(self):
        fake = Fake({"https://boards-api.greenhouse.io/v1/boards/acme/jobs":
                     gh("Software Engineer", "Senior Software Engineer")})
        _, first = collect(self.payload(regions=["US"], limit=1), fake, "2026-10-20T00:00:00+00:00")
        self.assertEqual(first["queued"], 1)
        _, uk = collect(self.payload(regions=["UK"]), fake, "2026-10-21T00:00:00+00:00")
        self.assertEqual(uk["candidates"], [])
        _, other = collect(self.payload(regions=["US"], positions=["Data Scientist"]), fake,
                           "2026-10-22T00:00:00+00:00")
        self.assertEqual(other["candidates"], [])
        _, back = collect(self.payload(regions=["US"], positions=["Senior Software Engineer"]), fake,
                          "2026-10-23T00:00:00+00:00")
        self.assertEqual([(c["title"], c["matched_query"]) for c in back["candidates"]],
                         [("Senior Software Engineer", "Senior Software Engineer")])
        self.assertNotIn("row_id", back["candidates"][0])

    def test_held_queue_is_not_counted_as_queued(self):
        fake = Fake({"https://boards-api.greenhouse.io/v1/boards/acme/jobs":
                     gh("Software Engineer", "Senior Software Engineer")})
        collect(self.payload(regions=["US"], limit=1), fake, "2026-10-20T00:00:00+00:00")
        _, uk = collect(self.payload(regions=["UK"]), fake, "2026-10-21T00:00:00+00:00")
        self.assertEqual(uk["queued"], 0)
        with open(self.state, encoding="utf-8") as f:
            self.assertEqual(len(json.load(f)["queue"]), 1)

    def test_positions_change_keeps_listed_postings_sent(self):
        fake = Fake({"https://boards-api.greenhouse.io/v1/boards/acme/jobs": gh("Software Engineer")})
        _, first = collect(self.payload(), fake, "2026-10-20T00:00:00+00:00")
        self.assertEqual(len(first["candidates"]), 1)
        collect(self.payload(positions=["Data Scientist"]), fake, "2026-10-21T00:00:00+00:00")
        _, back = collect(self.payload(), fake, "2026-10-22T00:00:00+00:00")
        self.assertEqual(back["candidates"], [])

    def test_queue_entry_without_row_id_is_still_emitted(self):
        with open(self.state, "w", encoding="utf-8") as f:
            json.dump({"boards": {"US-001": {"checked_at": "2026-10-21T00:00:00+00:00", "status": "done",
                                             "sent": ["https://job-boards.greenhouse.io/acme/jobs/0"]}},
                       "queue": [{"company": "Acme", "title": "Software Engineer",
                                  "url": "https://job-boards.greenhouse.io/acme/jobs/0"}]}, f)
        _, out = collect(self.payload(limit=1), Fake({}), "2026-10-22T00:00:00+00:00")
        self.assertEqual([c["url"] for c in out["candidates"]], ["https://job-boards.greenhouse.io/acme/jobs/0"])

    def test_non_string_checked_at_does_not_crash(self):
        with open(self.state, "w", encoding="utf-8") as f:
            json.dump({"boards": {"US-001": {"checked_at": 5}}, "queue": [{"title": "no url"}]}, f)
        fake = Fake({"https://boards-api.greenhouse.io/v1/boards/acme/jobs": gh()})
        code, out = collect(self.payload(), fake, "2026-10-22T00:00:00+00:00")
        self.assertEqual((code, out["candidates"]), (0, []))


if __name__ == "__main__":
    unittest.main()

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import scout
import deck
from test_deck import OLD, SOURCE, STAMP, company, load_profile, make_profile, write_document


SCRIPT = Path(__file__).with_name("scout.py")


def findings(task, outcome="complete"):
    if task["kind"] == "source":
        return {"outcome": outcome, "checked_at": STAMP,
                "page": {"links": [], "next_pages": [], "complete": True}, "companies": {}, "boards": []}
    data = company()
    data["markets"] = {m: {"status": "qualified", "reason": "Verified headquarters.",
        "evidence_urls": ["https://acme.example/about"]} for m in task["markets"]}
    data["evidence"].append({"source_url": task["url"], "first_seen_at": STAMP,
        "event_type": "portfolio", "event_date": None})
    return {"outcome": outcome, "checked_at": STAMP,
            "companies": {"acme.example": data} if outcome == "complete" else {}, "boards": [],
            **({"error": "temporary failure"} if outcome != "complete" else {})}


class ScoutTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = make_profile(self.temp.name, [("uk", SOURCE, 123)])

    def start(self, limit=50, markets=None, refresh=False):
        return scout.start(self.root, markets or ["uk"], limit, refresh)

    def record_and_publish(self, run, task, outcome="complete"):
        scout.record(self.root, run["run_id"], task["id"], findings(task, outcome))
        return scout.publish_pending(self.root, task["markets"])

    def cli(self, payload):
        return subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(payload),
                              text=True, capture_output=True, cwd=self.temp.name, check=False)

    def test_default_is_fifty_unique_tasks_and_three_disjoint_assignments(self):
        run = scout.start(self.root, ["uk"], scout.DEFAULT_BATCH_SIZE, False)
        self.assertEqual(scout.DEFAULT_BATCH_SIZE, 50)
        self.assertEqual(scout.MAX_WORKERS, 3)
        self.assertEqual(len(run["tasks"]), 50)
        self.assertEqual(len({t["id"] for t in run["tasks"]}), 50)
        self.assertTrue(all(t["kind"] == "item" for t in run["tasks"]))
        path = self.root / "scout/runtime/company-scout/state.sqlite3"
        self.assertTrue(path.is_file())

    def test_resume_does_not_repeat_published_research(self):
        run = self.start()
        completed = run["tasks"][:17]
        for task in completed:
            self.record_and_publish(run, task)
        resumed = self.start()
        self.assertEqual(len(resumed["tasks"]), 50)
        self.assertTrue({t["id"] for t in completed}.isdisjoint(t["id"] for t in resumed["tasks"]))
        unfinished = {t["id"] for t in run["tasks"][17:]}
        self.assertTrue(unfinished.issubset(t["id"] for t in resumed["tasks"]))

    def test_record_is_durable_before_publication(self):
        run = self.start(1)
        task = run["tasks"][0]
        before = (self.root / "data/search_packs.yaml").read_bytes()
        scout.record(self.root, run["run_id"], task["id"], findings(task))
        self.assertEqual((self.root / "data/search_packs.yaml").read_bytes(), before)
        self.assertEqual(scout.status(self.root)["awaiting_publication"], 1)
        with patch.object(deck, "publish_result", side_effect=ValueError("deck changed")):
            report = scout.publish_pending(self.root, ["uk"])
        self.assertTrue(report["errors"])
        self.assertEqual(scout.status(self.root)["awaiting_publication"], 1)
        report = scout.publish_pending(self.root, ["uk"])
        self.assertEqual(report["published"], 1)
        self.assertEqual(scout.status(self.root)["awaiting_publication"], 0)
        self.assertNotIn(task["id"], [t["id"] for t in self.start(2)["tasks"]])

    def test_crash_after_yaml_replace_before_ack_is_replayable(self):
        run = self.start(1)
        task = run["tasks"][0]
        scout.record(self.root, run["run_id"], task["id"], findings(task))
        publish = deck.publish_result
        def publish_then_interrupt(*args, **kwargs):
            publish(*args, **kwargs)
            raise KeyboardInterrupt("crash after replacement")
        with patch.object(deck, "publish_result", side_effect=publish_then_interrupt):
            with self.assertRaises(KeyboardInterrupt):
                scout.publish_pending(self.root, ["uk"])
        saved = (self.root / "data/search_packs.yaml").read_bytes()
        self.assertEqual(scout.status(self.root)["awaiting_publication"], 1)
        self.assertEqual(scout.publish_pending(self.root, ["uk"])["published"], 1)
        self.assertEqual((self.root / "data/search_packs.yaml").read_bytes(), saved)

    def test_market_selection_does_not_consume_other_market_work(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 10), ("us", "https://us.example/portfolio", 10)])
            run = scout.start(root, ["uk"], 50, False)
            self.assertEqual(len(run["tasks"]), 10)
            self.assertTrue(all(t["markets"] == ["uk"] for t in run["tasks"]))
            us = scout.start(root, ["us"], 50, False)
            self.assertEqual(len(us["tasks"]), 10)
            self.assertTrue(all(t["markets"] == ["us"] for t in us["tasks"]))

    def test_source_fairness_keeps_large_source_from_monopolizing_batch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 1000), ("uk", "https://small.example/portfolio", 30)])
            run = scout.start(root, ["uk"], 50, False)
            sources = [task["origins"][0]["source_url"] for task in run["tasks"]]
            self.assertEqual(sources.count(SOURCE), 25)
            self.assertEqual(sources.count("https://small.example/portfolio"), 25)

    def test_repeated_url_preserves_both_origins_in_one_assignment(self):
        second_source = "https://second.example/portfolio"
        document = load_profile(self.root)
        document["discovery"]["markets"]["uk"]["sources"]["other"] = {"url": second_source, "strategy": "portfolio"}
        document["discovery"]["observations"][second_source] = {
            "first_seen_at": OLD, "last_checked_at": OLD, "last_successful_check_at": OLD,
            "seen_urls": [SOURCE + "/company-0"], "pending_urls": [SOURCE + "/company-0"]}
        write_document(self.root, document)
        run = self.start(200)
        repeated = [t for t in run["tasks"] if t["url"] == SOURCE + "/company-0"]
        self.assertEqual(len(repeated), 1)
        self.assertEqual({o["source_url"] for o in repeated[0]["origins"]}, {SOURCE, second_source})
        self.record_and_publish(run, repeated[0])
        observations = load_profile(self.root)["discovery"]["observations"]
        self.assertNotIn(repeated[0]["url"], observations[SOURCE]["pending_urls"])
        self.assertNotIn(repeated[0]["url"], observations[second_source]["pending_urls"])

    def test_failed_task_goes_behind_never_attempted_items(self):
        run = self.start(1)
        failed = run["tasks"][0]
        self.record_and_publish(run, failed, "failed")
        self.assertEqual(scout.status(self.root)["failed"], 1)
        self.assertNotIn(failed["id"], [t["id"] for t in self.start(10)["tasks"]])
        self.assertIn(failed["url"], load_profile(self.root)["discovery"]["observations"][SOURCE]["pending_urls"])

    def test_refresh_is_explicit_and_bounded(self):
        self.assertTrue(all(t["kind"] == "item" for t in self.start(5)["tasks"]))
        run = self.start(2, refresh=True)
        self.assertLessEqual(len(run["tasks"]), 2)
        self.assertEqual(run["tasks"][0]["kind"], "source")

    def test_pagination_continues_and_does_not_claim_early_source_success(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0)])
            run = scout.start(root, ["uk"], 1, False)
            task = run["tasks"][0]
            self.assertEqual(task["kind"], "source")
            data = findings(task)
            data["page"] = {"links": [], "next_pages": [SOURCE + "?page=2"], "complete": False}
            scout.record(root, run["run_id"], task["id"], data)
            scout.publish_pending(root, ["uk"])
            self.assertEqual(load_profile(root)["discovery"]["observations"][SOURCE]["last_successful_check_at"], OLD)
            next_run = scout.start(root, ["uk"], 1, False)
            following = next_run["tasks"][0]
            self.assertEqual(following["url"], SOURCE + "?page=2")
            self.assertEqual(following["kind"], "source")
            scout.record(root, next_run["run_id"], following["id"], findings(following))
            scout.publish_pending(root, ["uk"])
            self.assertEqual(load_profile(root)["discovery"]["observations"][SOURCE]["last_successful_check_at"], STAMP)

    def test_known_companies_without_careers_are_revisited_oldest_first(self):
        older, newer = company("old.example"), company("new.example")
        older["careers"] = {"status": "not_found"}
        newer["last_checked_at"] = STAMP
        older["last_checked_at"] = OLD
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0)], {"new.example": newer, "old.example": older})
            run = scout.start(root, ["uk"], 50, False)
            companies = [t for t in run["tasks"] if t["kind"] == "company"]
            self.assertEqual([t["url"] for t in companies], ["https://old.example/", "https://new.example/"])

    def test_status_and_inspect_do_not_create_operational_files(self):
        runtime = self.root / "scout"
        before = (self.root / "data/search_packs.yaml").read_bytes()
        state = scout.status(self.root)
        self.assertEqual(state["awaiting_publication"], 0)
        scout.inspect(self.root, ["uk"])
        self.assertFalse(runtime.exists())
        self.assertEqual((self.root / "data/search_packs.yaml").read_bytes(), before)

    def test_invalid_selection_and_batch_size_write_nothing(self):
        for markets, limit in [(["unknown"], 50), (["all", "uk"], 50), (["uk"], 0), (["uk"], True)]:
            with self.subTest(markets=markets, limit=limit), self.assertRaises(ValueError):
                scout.start(self.root, markets, limit, False)
        self.assertFalse((self.root / "scout").exists())

    def test_cli_uses_json_stdin_from_unrelated_working_directory(self):
        proc = self.cli({"op": "start", "profile_root": str(self.root), "markets": ["uk"], "batch_size": 2})
        self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        output = json.loads(proc.stdout)
        self.assertEqual(len(output["tasks"]), 2)
        invalid = self.cli({"op": "start", "profile_root": str(self.root), "markets": ["uk"], "batch_size": 0})
        self.assertEqual(invalid.returncode, 1)
        self.assertIn("scout_error", json.loads(invalid.stdout))

    def test_record_requires_a_task_owned_by_the_run(self):
        run = self.start(1)
        with self.assertRaises(ValueError):
            scout.record(self.root, "not-a-run", run["tasks"][0]["id"], findings(run["tasks"][0]))
        with self.assertRaises(ValueError):
            scout.record(self.root, run["run_id"], "not-a-task", findings(run["tasks"][0]))
        self.assertEqual(scout.status(self.root)["awaiting_publication"], 0)

    def test_completion_in_one_market_preserves_other_market_pending_link(self):
        with tempfile.TemporaryDirectory() as folder:
            other_source = "https://us.example/companies"
            root = make_profile(folder, [("uk", SOURCE, 1), ("us", other_source, 0)])
            document = load_profile(root)
            document["discovery"]["observations"][other_source]["pending_urls"] = [SOURCE + "/company-0"]
            document["discovery"]["observations"][other_source]["seen_urls"] = [SOURCE + "/company-0"]
            write_document(root, document)
            run = scout.start(root, ["uk"], 50, False)
            task = run["tasks"][0]
            scout.record(root, run["run_id"], task["id"], findings(task))
            scout.publish_pending(root, ["uk"])
            us = scout.start(root, ["us"], 50, False)
            matching = [t for t in us["tasks"] if t["url"] == task["url"]]
            self.assertEqual(len(matching), 1)
            self.assertEqual(matching[0]["markets"], ["us"])

    def test_status_cli_does_not_need_yaml_dependency(self):
        proc = subprocess.run([sys.executable, "-I", str(SCRIPT)],
            input=json.dumps({"op": "status", "profile_root": str(self.root)}), text=True,
            capture_output=True, cwd=self.temp.name, check=False)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["awaiting_publication"], 0)
        self.assertFalse((self.root / "scout").exists())

    def test_small_batches_finish_company_review_before_opening_new_refresh_cycle(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0)], {"acme.example": company()})
            kinds = []
            for _ in range(2):
                run = scout.start(root, ["uk"], 1, False)
                task = run["tasks"][0]
                kinds.append(task["kind"])
                scout.record(root, run["run_id"], task["id"], findings(task))
                scout.publish_pending(root, ["uk"])
            self.assertEqual(kinds, ["source", "company"])

    def test_pagination_cycle_without_terminal_page_is_not_success(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0)])
            for next_url in (SOURCE + "?page=2", SOURCE):
                run = scout.start(root, ["uk"], 1, False)
                task = run["tasks"][0]
                result = findings(task)
                result["page"] = {"links": [], "next_pages": [next_url], "complete": False}
                scout.record(root, run["run_id"], task["id"], result)
                scout.publish_pending(root, ["uk"])
            self.assertEqual(load_profile(root)["discovery"]["observations"][SOURCE]["last_successful_check_at"], OLD)

    def test_last_page_linking_back_to_the_first_completes_the_crawl(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0)])
            for next_url, complete in ((SOURCE + "?page=2", False), (SOURCE, True)):
                run = scout.start(root, ["uk"], 1, False)
                task = run["tasks"][0]
                result = findings(task)
                result["page"] = {"links": [], "next_pages": [next_url], "complete": complete}
                scout.record(root, run["run_id"], task["id"], result)
                scout.publish_pending(root, ["uk"])
            self.assertEqual(load_profile(root)["discovery"]["observations"][SOURCE]["last_successful_check_at"], STAMP)
            self.assertEqual(scout.status(root)["progress"]["source_incomplete_cycles"], 0)

    def test_status_forgets_incomplete_crawl_after_a_complete_one(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0)])
            for complete in (False, True):
                run = scout.start(root, ["uk"], 1, False)
                task = run["tasks"][0]
                result = findings(task)
                result["page"]["complete"] = complete
                scout.record(root, run["run_id"], task["id"], result)
                scout.publish_pending(root, ["uk"])
            state = scout.status(root)
            self.assertEqual(state["progress"]["source_incomplete_cycles"], 0)
            self.assertEqual(state["pending"], 0)

    def test_status_keeps_unselected_market_backlog_after_subset_start(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 3), ("us", "https://us.example/portfolio", 3)])
            scout.start(root, ["uk", "us"], 1, False)
            scout.start(root, ["uk"], 1, False)
            state = scout.status(root)
            self.assertEqual(state["pending_by_market"], {"uk": 3, "us": 3})
            self.assertEqual(state["progress"]["item_pending"], 6)

    def test_failed_source_read_is_recorded_without_a_page(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0)])
            run = scout.start(root, ["uk"], 1, False)
            task = run["tasks"][0]
            scout.record(root, run["run_id"], task["id"],
                         {"outcome": "failed", "checked_at": STAMP, "error": "403 Forbidden"})
            self.assertEqual(scout.publish_pending(root, ["uk"])["published"], 1)
            self.assertEqual(scout.status(root)["failed"], 1)

    def test_failing_source_does_not_block_other_refresh_work(self):
        stuck = "https://stuck.example/portfolio"
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0), ("uk", stuck, 0)], {"acme.example": company()})
            for _ in range(2):
                run = scout.start(root, ["uk"], 50, False)
                for task in run["tasks"]:
                    scout.record(root, run["run_id"], task["id"],
                                 findings(task, "failed" if task["url"] == stuck else "complete"))
                scout.publish_pending(root, ["uk"])
            urls = {t["url"] for t in scout.start(root, ["uk"], 50, False)["tasks"]}
            self.assertEqual(urls, {SOURCE, stuck, "https://acme.example/"})

    def test_company_losing_a_market_is_not_reviewed_twice_in_one_cycle(self):
        acme, beta = company("acme.example"), company("beta.example")
        for data in (acme, beta):
            data["markets"]["us"] = dict(data["markets"]["uk"])
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0), ("us", "https://us.example/portfolio", 0)],
                                {"acme.example": acme, "beta.example": beta})
            run = scout.start(root, ["uk", "us"], 50, False)
            for task in run["tasks"]:
                if task["kind"] == "source":
                    scout.record(root, run["run_id"], task["id"], findings(task))
            first = next(t for t in run["tasks"] if t["url"] == "https://acme.example/")
            result = findings(first)
            reviewed = result["companies"]["acme.example"]
            reviewed["markets"]["us"] = {"status": "rejected", "reason": "Headquarters moved.",
                                         "evidence_urls": ["https://acme.example/about"]}
            scout.record(root, run["run_id"], first["id"], result)
            scout.publish_pending(root, ["uk", "us"])
            urls = [t["url"] for t in scout.start(root, ["uk", "us"], 50, False)["tasks"] if t["kind"] == "company"]
            self.assertEqual(urls, ["https://beta.example/"])

    def test_existing_deck_without_discovery_uses_template_without_display_writes(self):
        document = load_profile(self.root)
        del document["discovery"]
        write_document(self.root, document)
        path = self.root / "data/search_packs.yaml"
        before = path.read_bytes()
        scout.inspect(self.root, ["uk"])
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((self.root / "scout").exists())
        run = scout.start(self.root, ["uk"], 1, False)
        self.assertEqual(run["tasks"][0]["kind"], "source")
        self.assertEqual(path.read_bytes(), before)

    def test_small_source_does_not_leave_unused_batch_capacity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 1000), ("uk", "https://small.example/portfolio", 1)])
            run = scout.start(root, ["uk"], 50, False)
            self.assertEqual(len(run["tasks"]), 50)

    def test_source_refresh_does_not_requeue_already_researched_items(self):
        run = self.start(1)
        task = run["tasks"][0]
        self.record_and_publish(run, task)
        refresh = self.start(1, refresh=True)
        source = refresh["tasks"][0]
        result = findings(source)
        result["page"]["links"] = [task["url"]]
        scout.record(self.root, refresh["run_id"], source["id"], result)
        scout.publish_pending(self.root, ["uk"])
        self.assertNotIn(task["url"], load_profile(self.root)["discovery"]["observations"][SOURCE]["pending_urls"])

    def test_invalid_findings_do_not_poison_immutable_checkpoint(self):
        run = self.start(1)
        task = run["tasks"][0]
        bad = findings(task)
        bad["companies"] = {}
        with self.assertRaises(ValueError):
            scout.record(self.root, run["run_id"], task["id"], bad)
        self.assertEqual(scout.status(self.root)["awaiting_publication"], 0)
        scout.record(self.root, run["run_id"], task["id"], findings(task))
        self.assertEqual(scout.publish_pending(self.root, ["uk"])["published"], 1)

    def test_failed_item_is_retried_before_new_source_refresh(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 1)])
            run = scout.start(root, ["uk"], 1, False)
            task = run["tasks"][0]
            scout.record(root, run["run_id"], task["id"], findings(task, "failed"))
            scout.publish_pending(root, ["uk"])
            following = scout.start(root, ["uk"], 1, False)
            self.assertEqual(following["tasks"][0]["id"], task["id"])
            self.assertEqual(following["tasks"][0]["kind"], "item")

    def test_failed_items_rotate_after_another_failed_attempt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 2)])
            run = scout.start(root, ["uk"], 2, False)
            for task in run["tasks"]:
                scout.record(root, run["run_id"], task["id"], findings(task, "failed"))
                scout.publish_pending(root, ["uk"])
            retry = scout.start(root, ["uk"], 1, False)
            task = retry["tasks"][0]
            scout.record(root, retry["run_id"], task["id"], findings(task, "failed"))
            scout.publish_pending(root, ["uk"])
            following = scout.start(root, ["uk"], 1, False)
            self.assertNotEqual(following["tasks"][0]["id"], task["id"])

    def test_company_refresh_orders_quoted_and_unquoted_timestamps(self):
        older, newer = company("old.example"), company("new.example")
        older["last_checked_at"], newer["last_checked_at"] = OLD, "NEWER-STAMP"
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 0)], {"new.example": newer, "old.example": older})
            path = root / "data/search_packs.yaml"
            path.write_text(path.read_text(encoding="utf-8").replace("NEWER-STAMP", STAMP), encoding="utf-8")
            run = scout.start(root, ["uk"], 50, False)
            companies = [t["url"] for t in run["tasks"] if t["kind"] == "company"]
            self.assertEqual(companies, ["https://old.example/", "https://new.example/"])

    def test_status_reads_after_a_writer_dies_mid_transaction(self):
        self.start(2)
        database = self.root / "scout/runtime/company-scout/state.sqlite3"
        crash = (
            "import os, sqlite3, sys\n"
            "c = sqlite3.connect(sys.argv[1], isolation_level=None)\n"
            "c.execute('PRAGMA cache_size=1')\n"
            "c.execute('BEGIN IMMEDIATE')\n"
            "c.execute('CREATE TABLE filler(x TEXT)')\n"
            "for _ in range(3000): c.execute('INSERT INTO filler VALUES(?)', ('x' * 500,))\n"
            "os._exit(9)\n")
        subprocess.run([sys.executable, "-c", crash, str(database)], check=False)
        self.assertTrue(database.with_name("state.sqlite3-journal").exists())
        proc = self.cli({"op": "status", "profile_root": str(self.root)})
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["awaiting_publication"], 0)

    def test_cli_uses_utf8_even_on_a_legacy_windows_codepage(self):
        root = make_profile(self.root / "perfil-a\u00e7\u00e3o-\u65e5\u672c")
        payload = json.dumps({"op": "inspect", "profile_root": str(root), "markets": ["uk"]}, ensure_ascii=False).encode("utf-8")
        env = dict(os.environ, PYTHONIOENCODING="cp1252")
        proc = subprocess.run([sys.executable, str(SCRIPT)], input=payload, capture_output=True,
            cwd=self.temp.name, env=env, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout.decode("utf-8"))["profile_root"], str(root))


if __name__ == "__main__":
    unittest.main()

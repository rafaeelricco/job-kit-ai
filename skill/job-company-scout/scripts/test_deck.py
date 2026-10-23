import copy
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ruamel.yaml import YAML

import deck


STAMP = "2026-10-22T15:00:00Z"
OLD = "2026-10-01T12:00:00Z"
SOURCE = "https://investor.example/companies"


def load_profile(root):
    return YAML(typ="rt").load((Path(root) / "data/search_packs.yaml").read_text(encoding="utf-8"))


def write_document(root, document):
    stream = io.StringIO()
    parser = YAML(typ="rt")
    parser.indent(mapping=2, sequence=4, offset=2)
    parser.dump(document, stream)
    (Path(root) / "data/search_packs.yaml").write_text(stream.getvalue(), encoding="utf-8")


def company(host="acme.example", market="uk", careers="https://jobs.ashbyhq.com/acme"):
    return {
        "name": "Acme", "website": "https://" + host + "/", "aliases": [],
        "first_seen_at": OLD, "last_checked_at": STAMP, "last_successful_check_at": STAMP,
        "relevance": {"status": "qualified", "reason": "Builds developer tools.",
                      "evidence_urls": ["https://" + host + "/"]},
        "markets": {market: {"status": "qualified", "reason": "Verified operational headquarters.",
                             "evidence_urls": ["https://" + host + "/about"]}},
        "careers": {"status": "found", "url": careers},
        "evidence": [{"source_url": "https://" + host + "/about", "first_seen_at": OLD,
                      "event_type": "headquarters", "event_date": "2026-10"}],
    }


def make_profile(root, sources=None, companies=None):
    root = Path(root)
    (root / "data").mkdir(parents=True)
    (root / "data/job_search.yaml").write_text("positions: [Software Engineer]\nexclude_companies: []\n", encoding="utf-8")
    (root / "data/basics.yaml").write_text("country: Brazil\n", encoding="utf-8")
    sources = sources or [("uk", SOURCE, 5)]
    markets, observations = {}, {}
    for index, (market, source, count) in enumerate(sources):
        spec = markets.setdefault(market, {"enabled": True, "scope": "Companies headquartered in " + market,
                                           "sources": {}})
        spec["sources"]["source-" + str(index)] = {"url": source, "strategy": "portfolio"}
        urls = [source + "/company-" + str(n) for n in range(count)]
        observations[source] = {"first_seen_at": OLD, "last_checked_at": OLD,
                                "last_successful_check_at": OLD, "seen_urls": urls[:], "pending_urls": urls[:]}
    document = {"packs": [
        {"id": "manual", "surface": "open-web", "entry": "https://manual.example/jobs", "enabled": False},
        {"id": "ashby-boards", "surface": "open-web", "entry": "https://jobs.ashbyhq.com", "route_required": True,
         "route": {"kind": "board", "ats": "ashby", "url": "https://api.ashbyhq.com/posting-api/job-board/{slug}",
                   "items": "jobs", "posting_url": "jobUrl", "title": "title"}},
    ], "discovery": {"markets": markets, "observations": observations, "companies": companies or {}}}
    write_document(root, document)
    path = root / "data/search_packs.yaml"
    path.write_text("# operator header\n" + path.read_text(encoding="utf-8").replace(
        "entry: https://manual.example/jobs", "entry: https://manual.example/jobs # keep this comment"), encoding="utf-8")
    return root


def item_result(url=None, companies=None):
    return {"kind": "item", "url": url or SOURCE + "/company-0", "markets": ["uk"],
            "origins": [{"market": "uk", "source_url": SOURCE}],
            "outcome": "complete", "checked_at": STAMP,
            "companies": {"acme.example": company()} if companies is None else companies,
            "boards": []}


class DeckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = make_profile(self.temp.name)

    def test_context_is_bounded_for_thousands_of_pending_urls(self):
        with tempfile.TemporaryDirectory() as folder:
            root = make_profile(folder, [("uk", SOURCE, 2500)])
            context = deck.read_context(root, ["uk"], [])
            import json
            output = json.dumps(context, default=str)
            self.assertLess(len(output), 10000)
            self.assertNotIn("company-2499", output)
            self.assertIn("uk", output)

    def test_publish_removes_only_completed_item_and_is_idempotent(self):
        result = item_result()
        deck.publish_result(self.root, result)
        first = (self.root / "data/search_packs.yaml").read_bytes()
        deck.publish_result(self.root, result)
        self.assertEqual((self.root / "data/search_packs.yaml").read_bytes(), first)
        document = load_profile(self.root)
        discovery = document["discovery"]
        self.assertEqual(len(discovery["companies"]), 1)
        self.assertNotIn(result["url"], discovery["observations"][SOURCE]["pending_urls"])
        self.assertEqual(len(discovery["observations"][SOURCE]["pending_urls"]), 4)
        self.assertEqual(discovery["observations"][SOURCE]["last_successful_check_at"], OLD)
        boards = document["packs"][1]["boards"]
        self.assertEqual(len(boards), 1)
        self.assertEqual(boards[0]["url"], "https://jobs.ashbyhq.com/acme")

    def test_unowned_pack_bytes_and_comments_survive(self):
        path = self.root / "data/search_packs.yaml"
        before = path.read_bytes()
        manual_before = before.split(b"  - id: manual", 1)[1].split(b"  - id: ashby-boards", 1)[0]
        deck.publish_result(self.root, item_result())
        after = path.read_bytes()
        manual_after = after.split(b"  - id: manual", 1)[1].split(b"  - id: ashby-boards", 1)[0]
        self.assertEqual(manual_before, manual_after)
        self.assertEqual(after.splitlines(keepends=True)[0], before.splitlines(keepends=True)[0])

    def test_disabled_discovery_board_is_reused_without_enabling(self):
        deck.publish_result(self.root, item_result())
        document = load_profile(self.root)
        document["packs"][1]["boards"][0]["enabled"] = False
        write_document(self.root, document)
        deck.publish_result(self.root, item_result(SOURCE + "/company-1"))
        rows = load_profile(self.root)["packs"][1]["boards"]
        self.assertEqual(len(rows), 1)
        self.assertIs(rows[0]["enabled"], False)

    def test_operator_owned_board_is_never_disabled_by_research(self):
        deck.publish_result(self.root, item_result())
        document = load_profile(self.root)
        board = document["packs"][1]["boards"][0]
        del board["managed_by"]
        board["enabled"] = True
        write_document(self.root, document)
        rejected = company()
        rejected["relevance"]["status"] = "rejected"
        rejected["relevance"]["reason"] = "Confirmed outside the profile scope."
        deck.publish_result(self.root, item_result(companies={"acme.example": rejected}))
        self.assertIs(load_profile(self.root)["packs"][1]["boards"][0]["enabled"], True)

    def test_failure_preserves_prior_verified_company_and_pending_url(self):
        document = load_profile(self.root)
        document["discovery"]["companies"]["acme.example"] = company()
        write_document(self.root, document)
        failed = item_result(companies={})
        failed.update(outcome="failed", error="temporary network failure")
        deck.publish_result(self.root, failed)
        after = load_profile(self.root)["discovery"]
        self.assertEqual(after["companies"]["acme.example"]["relevance"]["status"], "qualified")
        self.assertIn(failed["url"], after["observations"][SOURCE]["pending_urls"])
        self.assertEqual(after["observations"][SOURCE]["last_successful_check_at"], OLD)

    def test_retry_never_removes_pending_url(self):
        retry = item_result(companies={})
        retry.update(outcome="retry", error="official identity unresolved")
        deck.publish_result(self.root, retry)
        self.assertIn(retry["url"], load_profile(self.root)["discovery"]["observations"][SOURCE]["pending_urls"])

    def test_incomplete_research_does_not_downgrade_verified_facts(self):
        document = load_profile(self.root)
        previous = company()
        document["discovery"]["companies"]["acme.example"] = previous
        write_document(self.root, document)
        incomplete = company()
        incomplete["relevance"] = {"status": "pending", "reason": "New check unavailable", "evidence_urls": []}
        incomplete["markets"]["uk"] = {"status": "pending", "reason": "Cannot verify now", "evidence_urls": []}
        incomplete["careers"] = {"status": "unknown"}
        incomplete["last_successful_check_at"] = None
        result = item_result(companies={"acme.example": incomplete})
        result["outcome"] = "retry"
        deck.publish_result(self.root, result)
        saved = load_profile(self.root)["discovery"]["companies"]["acme.example"]
        self.assertEqual(saved["relevance"], previous["relevance"])
        self.assertEqual(saved["markets"]["uk"], previous["markets"]["uk"])
        self.assertEqual(saved["careers"], previous["careers"])
        self.assertEqual(saved["last_successful_check_at"], previous["last_successful_check_at"])

    def test_company_name_alone_does_not_merge_distinct_hosts(self):
        document = load_profile(self.root)
        document["discovery"]["companies"]["first.example"] = company("first.example")
        write_document(self.root, document)
        deck.publish_result(self.root, item_result(companies={"second.example": company("second.example")}))
        self.assertEqual(set(load_profile(self.root)["discovery"]["companies"]), {"first.example", "second.example"})

    def test_excluded_company_does_not_add_a_board(self):
        (self.root / "data/job_search.yaml").write_text("positions: [Software Engineer]\nexclude_companies: [Acme]\n", encoding="utf-8")
        deck.publish_result(self.root, item_result())
        document = load_profile(self.root)
        self.assertFalse(document["packs"][1].get("boards"))
        self.assertFalse(any(p.get("company_id") == "acme.example" for p in document["packs"]))

    def test_individual_job_url_is_not_accepted_as_a_board(self):
        path = self.root / "data/search_packs.yaml"
        before = path.read_bytes()
        result = item_result()
        result["boards"] = [{"company_id": "acme.example", "url": "https://jobs.ashbyhq.com/acme/job-123"}]
        with self.assertRaises(ValueError):
            deck.publish_result(self.root, result)
        self.assertEqual(path.read_bytes(), before)

    def test_external_edit_during_staging_is_not_overwritten(self):
        path = self.root / "data/search_packs.yaml"
        original_validate = deck.validate_deck
        changed = []
        def validate_and_edit(document):
            answer = original_validate(document)
            if list(path.parent.glob("search_packs.yaml.*.tmp")) and not changed:
                path.write_bytes(path.read_bytes() + b"\n# concurrent operator edit\n")
                changed.append(True)
            return answer
        with patch.object(deck, "validate_deck", side_effect=validate_and_edit):
            with self.assertRaises(ValueError):
                deck.publish_result(self.root, item_result())
        self.assertTrue(changed)
        self.assertTrue(path.read_bytes().endswith(b"# concurrent operator edit\n"))
        self.assertEqual(list(path.parent.glob("search_packs.yaml.*.tmp")), [])

    def test_verified_rebrand_updates_owned_references_and_preserves_first_seen(self):
        old = company("old.example")
        document = load_profile(self.root)
        document["discovery"]["companies"]["old.example"] = old
        document["packs"][1]["boards"] = [{"company_id": "old.example", "name": "Acme",
            "url": "https://jobs.ashbyhq.com/acme", "managed_by": "job-company-scout", "enabled": False}]
        write_document(self.root, document)
        renamed = company("new.example")
        renamed["aliases"] = ["old.example"]
        renamed["first_seen_at"] = STAMP
        deck.publish_result(self.root, item_result(companies={"new.example": renamed}))
        result = load_profile(self.root)
        companies = result["discovery"]["companies"]
        self.assertNotIn("old.example", companies)
        self.assertEqual(companies["new.example"]["first_seen_at"], OLD)
        self.assertEqual(result["packs"][1]["boards"][0]["company_id"], "new.example")
        self.assertIs(result["packs"][1]["boards"][0]["enabled"], False)

    def test_custom_careers_pack_has_no_invented_api_and_reuses_disabled_pack(self):
        custom = company(careers="https://acme.example/careers")
        result = item_result(companies={"acme.example": custom})
        deck.publish_result(self.root, result)
        document = load_profile(self.root)
        pack = next(p for p in document["packs"] if p.get("company_id") == "acme.example")
        self.assertEqual(pack["route"], {"kind": "careers"})
        self.assertEqual(pack["location"], "keep-only")
        pack["enabled"] = False
        write_document(self.root, document)
        deck.publish_result(self.root, result)
        matching = [p for p in load_profile(self.root)["packs"] if p.get("company_id") == "acme.example"]
        self.assertEqual(len(matching), 1)
        self.assertIs(matching[0]["enabled"], False)

    def test_invalid_existing_route_stops_before_replacement(self):
        document = load_profile(self.root)
        del document["packs"][1]["route"]["title"]
        write_document(self.root, document)
        path = self.root / "data/search_packs.yaml"
        before = path.read_bytes()
        with self.assertRaises(ValueError):
            deck.publish_result(self.root, item_result())
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(path.parent.glob("search_packs.yaml.*.tmp")), [])

    def test_replace_failure_leaves_original_and_cleans_stage(self):
        path = self.root / "data/search_packs.yaml"
        before = path.read_bytes()
        with patch.object(deck.os, "replace", side_effect=OSError("simulated replace failure")):
            with self.assertRaises(OSError):
                deck.publish_result(self.root, item_result())
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(list(path.parent.glob("search_packs.yaml.*.tmp")), [])

    def test_unsupported_company_identity_does_not_mutate_input(self):
        document = load_profile(self.root)
        before = copy.deepcopy(document)
        invalid = company()
        invalid["website"] = "https://different.example/"
        with self.assertRaises(ValueError):
            deck.merge_result(document, item_result(companies={"acme.example": invalid}))
        self.assertEqual(document, before)

    def test_unselected_market_decision_is_not_published(self):
        result = item_result()
        result["companies"]["acme.example"]["markets"]["us"] = {
            "status": "qualified", "reason": "Not requested in this task", "evidence_urls": ["https://acme.example/about"]}
        deck.publish_result(self.root, result)
        self.assertNotIn("us", load_profile(self.root)["discovery"]["companies"]["acme.example"]["markets"])

    def test_source_configuration_is_not_reserialized(self):
        path = self.root / "data/search_packs.yaml"
        raw = path.read_bytes().replace(b"scope: Companies headquartered in uk", b"scope: 'Companies headquartered in uk' # manual style")
        path.write_bytes(raw)
        before = raw.split(b"  markets:", 1)[1].split(b"  observations:", 1)[0]
        deck.publish_result(self.root, item_result())
        after = path.read_bytes().split(b"  markets:", 1)[1].split(b"  observations:", 1)[0]
        self.assertEqual(after, before)

    def test_resolved_decisions_require_their_own_supporting_urls(self):
        result = item_result()
        result["companies"]["acme.example"]["relevance"]["evidence_urls"] = []
        result["companies"]["acme.example"]["markets"]["uk"]["evidence_urls"] = []
        before = (self.root / "data/search_packs.yaml").read_bytes()
        with self.assertRaises(ValueError):
            deck.publish_result(self.root, result)
        self.assertEqual((self.root / "data/search_packs.yaml").read_bytes(), before)

    def test_rebrand_collision_preserves_both_existing_records(self):
        document = load_profile(self.root)
        document["discovery"]["companies"] = {"old.example": company("old.example"),
            "new.example": company("new.example", "us")}
        write_document(self.root, document)
        incoming = company("new.example")
        incoming["aliases"] = ["old.example"]
        before = (self.root / "data/search_packs.yaml").read_bytes()
        with self.assertRaises(ValueError):
            deck.publish_result(self.root, item_result(companies={"new.example": incoming}))
        self.assertEqual((self.root / "data/search_packs.yaml").read_bytes(), before)

    def test_company_context_is_a_bounded_preview_without_truncating_storage(self):
        import json
        document = load_profile(self.root)
        record = company()
        record["evidence"] = [{"source_url": "https://news.example/article-" + str(n),
            "event_type": "news", "event_date": None, "first_seen_at": STAMP} for n in range(300)]
        record["relevance"]["evidence_urls"] = [e["source_url"] for e in record["evidence"]]
        document["discovery"]["companies"]["acme.example"] = record
        write_document(self.root, document)
        before = (self.root / "data/search_packs.yaml").read_bytes()
        context = deck.read_context(self.root, ["uk"], ["acme.example"])
        self.assertLess(len(json.dumps(context, default=str)), 10000)
        self.assertLess(len(context["companies"]["acme.example"]["evidence"]), 300)
        self.assertEqual((self.root / "data/search_packs.yaml").read_bytes(), before)

    def test_copied_skill_finds_the_sibling_profile_template(self):
        import shutil
        installed = self.root / "installed/builtin"
        template = installed / "job-profile/templates/data/search_packs.yaml"
        template.parent.mkdir(parents=True)
        source = Path(deck.__file__).resolve().parents[2] / "job-profile/templates/data/search_packs.yaml"
        shutil.copyfile(source, template)
        document = load_profile(self.root)
        del document["discovery"]
        write_document(self.root, document)
        with patch.object(deck, "__file__", str(installed / "job-company-scout/scripts/deck.py")):
            context = deck.read_context(self.root, ["uk"], [])
        self.assertEqual(context["markets"][0]["id"], "uk")


if __name__ == "__main__":
    unittest.main()

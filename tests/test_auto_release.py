"""Test release orchestration with real temporary Git history and fake GitHub I/O."""

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import auto_release  # noqa: E402


def workflow_run(number, conclusion="success", status="completed", event="pull_request_target"):
    return dict(run_number=number, conclusion=conclusion, status=status,
                event=event, html_url=f"https://github.test/runs/{number}")


def tags_for(values):
    return tuple(auto_release.Tag(name, version, auto_release.CommitSha(commit))
                 for name, commit in values.items()
                 for version in (auto_release.parse_version(name),) if version is not None)


class VersionAndOrderTests(unittest.TestCase):
    def test_bootstrap_and_numeric_bumps(self):
        commit = auto_release.CommitSha("a" * 40)
        for bump in ("patch", "minor", "major"):
            self.assertEqual(auto_release.choose_version((), commit, bump), auto_release.Version(1, 0, 0))
        tags = tags_for({"v1.9.9": "old", "v1.10.0": "old", "v99.0.0-rc.1": "old", "other": "old"})
        for bump, expected in (("patch", "v1.10.1"), ("minor", "v1.11.0"), ("major", "v2.0.0")):
            self.assertEqual(auto_release.format_version(auto_release.choose_version(tags, commit, bump)), expected)

    def test_existing_commit_reuses_reserved_version(self):
        tags = tags_for({"v1.0.0": "target", "v1.0.1": "target", "v2.0.0": "other"})
        self.assertEqual(auto_release.choose_version(tags, auto_release.CommitSha("target"), "major"),
                         auto_release.Version(1, 0, 1))
        with self.assertRaises(ValueError):
            auto_release.decode_bump("unexpected")

    def test_failures_and_pending_predecessors_block(self):
        states = [("failure", "completed"), ("cancelled", "completed"),
                  ("timed_out", "completed"), ("action_required", "completed"),
                  (None, "queued"), (None, "in_progress")]
        for conclusion, status in states:
            with self.subTest(conclusion=conclusion, status=status):
                runs = (auto_release.decode_run(workflow_run(2, conclusion, status)),)
                decision = auto_release.decide_admission(runs, auto_release.RunNumber(3), auto_release.RunNumber(0))
                self.assertIsInstance(decision, auto_release.Blocked)
                self.assertIn("runs/2", decision.reason)
                self.assertIn("RELEASE_SKIP_THROUGH_RUN to 2", decision.reason)

    def test_success_skip_and_manual_skip_boundaries(self):
        runs = tuple(map(auto_release.decode_run, [workflow_run(1, "failure", event="push"), workflow_run(2),
                         workflow_run(3, "skipped"), workflow_run(5, "failure")]))
        for current, skip, expected in ((4, 0, auto_release.Proceed()), (6, 5, auto_release.Proceed()),
                                       (5, 5, auto_release.Skipped(auto_release.RunNumber(5))),
                                       (4, 5, auto_release.Skipped(auto_release.RunNumber(5)))):
            self.assertEqual(auto_release.decide_admission(runs, auto_release.RunNumber(current),
                                                           auto_release.RunNumber(skip)), expected)


class PublicationPolicyTests(unittest.TestCase):
    def setUp(self):
        self.sha = auto_release.CommitSha("a" * 40)
        self.config = auto_release.PublishConfig(auto_release.Repository("fixture/job-kit"),
                                                self.sha, "patch", Path("dist"))

    def decide(self, tags=(), releases=(), ancestor=None, head=None):
        snapshot = auto_release.PublicationSnapshot(head or self.sha, tags, releases, ancestor)
        return auto_release.decide_publication(self.config, snapshot)

    def test_create_resume_and_published_decisions(self):
        target = auto_release.ReleaseTarget("v1.0.0", True)
        self.assertEqual(self.decide(), auto_release.CreateRelease(target))
        tags = tags_for({"v1.0.0": self.sha})
        target = auto_release.ReleaseTarget("v1.0.0", False)
        self.assertEqual(self.decide(tags), auto_release.CreateRelease(target))
        draft = auto_release.Release(auto_release.ReleaseId(7), "v1.0.0", True, False)
        self.assertEqual(self.decide(tags, (draft,)), auto_release.ResumeDraft(target, draft.identifier))
        published = auto_release.Release(draft.identifier, draft.tag, False, False)
        self.assertEqual(self.decide(tags, (published,)), auto_release.AlreadyPublished("v1.0.0"))

    def test_wrong_head_and_older_reserved_version_are_blocked(self):
        self.assertIsInstance(self.decide(head=auto_release.CommitSha("b" * 40)), auto_release.Blocked)
        tags = tags_for({"v1.0.0": self.sha, "v2.0.0": "b" * 40})
        latest = auto_release.Release(auto_release.ReleaseId(1), "v2.0.0", False, False)
        for ancestry, reason in ((False, "older or divergent"), (None, "older or divergent"),
                                 (True, "reserved version")):
            decision = self.decide(tags, (latest,), ancestry)
            self.assertIsInstance(decision, auto_release.Blocked)
            self.assertIn(reason, decision.reason)

    def test_existing_tag_spelling_is_preserved(self):
        decision = self.decide(tags_for({"v01.2.3": self.sha}))
        self.assertEqual(decision, auto_release.CreateRelease(auto_release.ReleaseTarget("v01.2.3", False)))


class BoundaryTests(unittest.TestCase):
    def test_release_fields_are_validated(self):
        valid = dict(id=1, tag_name="v1.0.0", draft=True, prerelease=False)
        for key, value in (("id", True), ("id", -1), ("draft", "false"),
                           ("prerelease", 0), ("tag_name", None)):
            with self.subTest(key=key), self.assertRaises(ValueError):
                auto_release.decode_release(dict(valid, **{key: value}))
        with self.assertRaises(KeyError):
            auto_release.decode_release({})

    def test_workflow_fields_are_validated(self):
        for key, value in (("run_number", True), ("status", None), ("conclusion", [])):
            data = workflow_run(1)
            data[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                auto_release.decode_run(data)

    def test_json_containers_and_commit_sha_are_validated(self):
        for decoder, value in ((auto_release.fields, []), (auto_release.fields, {1: "x"}),
                               (auto_release.sequence, {}), (auto_release.decode_sha, "HEAD"),
                               (auto_release.decode_sha, None)):
            with self.subTest(decoder=decoder.__name__), self.assertRaises(ValueError):
                decoder(value)


class AutomationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.work = self.root / "checkout"
        self.origin = self.root / "origin.git"
        self.work.mkdir()
        self.real_run = subprocess.run
        self.git("init", "--bare", str(self.origin))
        self.git("init")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Release Fixture")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "tag.gpgsign", "false")
        self.git("remote", "add", "origin", str(self.origin))
        self.sha = self.commit("initial")
        self.git("push", "origin", "HEAD:refs/heads/main")
        self.env = {
            "GITHUB_REPOSITORY": "fixture/job-kit", "GITHUB_RUN_ID": "900",
            "GITHUB_EVENT_NAME": "pull_request_target",
            "GITHUB_EVENT_PATH": str(self.root / "event.json"),
            "GITHUB_OUTPUT": str(self.root / "outputs"),
            "RELEASE_SHA": self.sha, "RELEASE_BUMP": "patch",
            "RELEASE_SKIP_THROUGH_RUN": "0",
        }
        self.event = {
            "action": "closed", "pull_request": {
                "merged": True, "merge_commit_sha": self.sha, "labels": [],
                "base": {"ref": "main", "repo": {"full_name": "fixture/job-kit"}},
            },
        }
        self.current_number = 3
        self.runs = [workflow_run(1), workflow_run(2), workflow_run(3, None, "in_progress")]
        self.releases = []
        self.calls = []
        self.fail_endpoint = None
        self.fail_upload = False
        self.publish_before_upload = False
        self.adapters = auto_release.ReleaseAdapters(self.runner, self.build)

    def runner(self, args):
        result = self.fake_run(list(args), cwd=self.work, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr or result.stdout)
        return result.stdout

    def build(self, version, output):
        with patch.object(auto_release.package_release, "REPO", self.work):
            auto_release.package_release.build_release(version, output)

    def publish(self):
        config = auto_release.publish_config(self.env, self.root / "dist")
        return auto_release.publish(config, self.adapters)

    def git(self, *args, cwd=None):
        result = self.real_run(["git", *args], cwd=cwd or self.work,
                               capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def commit(self, text):
        (self.work / "LICENSE").write_text(text, encoding="utf-8")
        self.git("add", "LICENSE")
        self.git("commit", "-m", text)
        return self.git("rev-parse", "HEAD")

    def tag(self, name, sha=None, annotated=False):
        args = ["tag"] + (["-a", "-m", "release fixture"] if annotated else [])
        self.git(*args, name, sha or self.sha)
        self.git("push", "origin", f"refs/tags/{name}")

    def release(self, version="v1.0.0", draft=False):
        item = dict(id=len(self.releases) + 1, tag_name=version, draft=draft, prerelease=False)
        self.releases.append(item)
        return item

    def fake_run(self, args, **kwargs):
        if args[0] != "gh":
            return self.real_run(args, **kwargs)
        self.calls.append(list(args))
        if args[1:3] == ["release", "upload"]:
            if self.fail_upload:
                return subprocess.CompletedProcess(args, 1, "", "fixture upload interrupted")
            files = args[args.index("--clobber") + 1:]
            self.assertEqual(len(files), 4)
            self.assertTrue(all(Path(path).is_file() for path in files))
            self.assertEqual(Path(files[2]).read_text(), args[3] + "\n")
            return subprocess.CompletedProcess(args, 0, "", "")
        self.assertEqual(args[1], "api", "unexpected GitHub command")
        endpoint = args[2]
        if self.fail_endpoint and self.fail_endpoint in endpoint:
            return subprocess.CompletedProcess(args, 1, "", "fixture API failure (HTTP 403)")
        method = args[args.index("--method") + 1]
        fields = {}
        for index, arg in enumerate(args):
            if arg in {"-f", "-F"}:
                name, value = args[index + 1].split("=", 1)
                fields[name] = json.loads(value) if arg == "-F" else value
        if endpoint.endswith("/actions/runs/900"):
            result = dict(workflow_id=7, run_number=self.current_number)
        elif "/actions/workflows/7/runs?" in endpoint:
            page = int(endpoint.rsplit("page=", 1)[1])
            result = {"workflow_runs": self.runs[(page - 1) * 100:page * 100]}
        elif "/releases?" in endpoint:
            page = int(endpoint.rsplit("page=", 1)[1])
            result = self.releases[(page - 1) * 100:page * 100]
        elif endpoint.endswith("/git/refs") and method == "POST":
            # A real bare remote makes retries observe the reserved tag.
            self.git("update-ref", fields["ref"], fields["sha"], "0" * 40, cwd=self.origin)
            result = {"ref": fields["ref"]}
        elif endpoint.endswith("/releases") and method == "POST":
            result = self.release(fields["tag_name"], fields["draft"])
        elif "/releases/" in endpoint:
            item = next(item for item in self.releases if str(item["id"]) == endpoint.rsplit("/", 1)[1])
            if method == "PATCH":
                item.update(fields)
            elif self.publish_before_upload:
                item["draft"] = False
            result = item
        else:
            self.fail(f"unexpected GitHub endpoint: {method} {endpoint}")
        return subprocess.CompletedProcess(args, 0, json.dumps(result), "")

    def admit(self):
        Path(self.env["GITHUB_EVENT_PATH"]).write_text(json.dumps(self.event), encoding="utf-8")
        auto_release.admit(auto_release.admit_config(self.env), self.runner)
        return Path(self.env["GITHUB_OUTPUT"]).read_text()

    def writes(self):
        return [args for args in self.calls if args[1:3] == ["release", "upload"]
                or ("--method" in args and args[args.index("--method") + 1] != "GET")]

    def test_admission_uses_merge_sha_and_label_precedence(self):
        for labels, bump in (([], "patch"), (["release:minor"], "minor"),
                             (["release:major", "release:minor"], "major")):
            self.event["pull_request"]["labels"] = [{"name": name} for name in labels]
            Path(self.env["GITHUB_OUTPUT"]).unlink(missing_ok=True)
            self.assertEqual(self.admit(), f"proceed=true\nmerge_sha={self.sha}\nbump={bump}\n")
        self.assertEqual(self.writes(), [])

    def test_invalid_events_and_checkout_are_rejected(self):
        for key, value in (("merged", False), ("merge_commit_sha", "f" * 40),
                           ("merge_commit_sha", None)):
            with self.subTest(key=key, value=value):
                with patch.dict(self.event["pull_request"], {key: value}):
                    with self.assertRaises(ValueError):
                        self.admit()
        with patch.dict(self.event["pull_request"]["base"], {"ref": "develop"}):
            with self.assertRaises(ValueError):
                self.admit()
        with patch.dict(self.env, {"GITHUB_EVENT_NAME": "push"}):
            with self.assertRaises(ValueError):
                self.admit()
        self.assertEqual(self.calls, [])

    def test_admission_paginates_and_blocks_ci_failure_before_tagging(self):
        self.current_number = 103
        self.runs = [workflow_run(n) for n in range(1, 103)]
        self.runs[100] = workflow_run(101, "failure")
        with self.assertRaisesRegex(RuntimeError, "runs/101"):
            self.admit()
        self.assertTrue(any("page=2" in args[2] for args in self.calls))
        self.assertEqual(self.writes(), [])
        with patch.dict(self.env, {"RELEASE_SKIP_THROUGH_RUN": "101"}):
            self.assertIn("proceed=true", self.admit())
        with patch.dict(self.env, {"RELEASE_SKIP_THROUGH_RUN": "103"}):
            self.assertIn("proceed=false", self.admit())

    def test_invalid_skip_values_fail_without_api_calls(self):
        for value in ("-1", "1.5", "all", "", " 2"):
            with self.subTest(value=value), patch.dict(self.env, {"RELEASE_SKIP_THROUGH_RUN": value}):
                with self.assertRaises(ValueError):
                    self.admit()
        self.assertEqual(self.calls, [])

    def test_admission_api_error_is_not_empty_history(self):
        self.fail_endpoint = "/actions/workflows/"
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            self.admit()
        self.assertEqual(self.writes(), [])

    def test_publish_bootstrap_orders_build_tag_draft_upload_and_publication(self):
        self.publish()
        writes = self.writes()
        self.assertTrue(writes[0][2].endswith("/git/refs"))
        self.assertTrue(writes[1][2].endswith("/releases"))
        self.assertEqual(writes[2][1:3], ["release", "upload"])
        self.assertIn("PATCH", writes[3])
        self.assertIn("make_latest=true", writes[3])
        self.assertEqual(self.git("rev-parse", "refs/tags/v1.0.0", cwd=self.origin), self.sha)
        self.assertFalse(self.releases[0]["draft"])

    def test_annotated_tag_retry_published_commit_makes_no_writes(self):
        self.tag("v1.0.0", annotated=True)
        self.release()
        self.publish()
        self.assertEqual(self.writes(), [])
        self.assertFalse((self.root / "dist").exists())

    def test_failed_upload_leaves_draft_and_retry_reuses_tag(self):
        self.fail_upload = True
        with self.assertRaisesRegex(RuntimeError, "upload interrupted"):
            self.publish()
        self.assertTrue(self.releases[0]["draft"])
        self.fail_upload = False
        self.calls.clear()
        self.publish()
        self.assertEqual(len(self.releases), 1)
        self.assertEqual(self.git("tag", cwd=self.origin), "v1.0.0")
        self.assertEqual(len(self.writes()), 2)  # Upload and publication only.
        self.calls.clear()
        self.publish()
        self.assertEqual(self.writes(), [])

    def test_reserved_tag_without_release_is_resumed(self):
        self.tag("v1.2.3")
        self.publish()
        self.assertEqual(self.releases[0]["tag_name"], "v1.2.3")
        self.assertFalse(any(args[2].endswith("/git/refs") for args in self.writes()))

    def test_new_commit_increments_and_never_moves_existing_tag(self):
        self.tag("v1.0.0", annotated=True)
        self.release()
        old_tag = self.git("rev-parse", "refs/tags/v1.0.0")
        new_sha = self.commit("next")
        self.git("push", "origin", "HEAD:refs/heads/main")
        with patch.dict(self.env, {"RELEASE_SHA": new_sha, "RELEASE_BUMP": "minor"}):
            self.publish()
        self.assertEqual(self.releases[-1]["tag_name"], "v1.1.0")
        self.assertEqual(self.git("rev-parse", "refs/tags/v1.0.0", cwd=self.origin), old_tag)

    def test_pagination_finds_published_release_without_duplicate_writes(self):
        self.tag("v1.0.0")
        for n in range(100):
            self.release(f"unrelated-{n}")
        self.release()
        self.publish()
        self.assertTrue(any("page=2" in args[2] for args in self.calls))
        self.assertEqual(self.writes(), [])

    def test_wrong_checkout_and_api_errors_abort_without_release_writes(self):
        with patch.dict(self.env, {"RELEASE_SHA": "f" * 40}):
            with self.assertRaisesRegex(ValueError, "checkout"):
                self.publish()
        self.fail_endpoint = "/releases?"
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            self.publish()
        self.assertEqual(self.writes(), [])

    def test_build_failure_does_not_reserve_tag(self):
        with patch.object(auto_release.package_release, "build_release", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.publish()
        self.assertEqual(self.writes(), [])

    def test_older_commit_cannot_replace_published_descendant(self):
        newer = self.commit("newer released code")
        self.tag("v1.0.0", newer)
        self.release()
        self.git("checkout", "--detach", self.sha)
        with self.assertRaisesRegex(ValueError, "older or divergent"):
            self.publish()
        self.assertEqual(self.writes(), [])

    def test_published_assets_cannot_be_clobbered(self):
        self.tag("v1.0.0")
        self.release(draft=True)
        self.publish_before_upload = True
        with self.assertRaisesRegex(ValueError, "expected draft"):
            self.publish()
        self.assertEqual(self.writes(), [])


if __name__ == "__main__":
    unittest.main()

import json
import os
import subprocess
import sys
import tempfile
import unittest
from typing import Dict, List, Optional

from slice_store import slice_payload

MARKER = "<!-- scout never writes below this line -->"
SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "slice_store.py")


def dossier(
    name: str,
    status: str = "new",
    log: Optional[List[str]] = None,
    facts: Optional[Dict[str, str]] = None,
    role: bool = True,
    score: str = "8",
) -> str:
    rows = {"status": "live", "location": "Portugal", "work_model": "Remote", "salary": "—"}
    rows.update(facts or {})
    table = "\n".join("| {0} | {1} |".format(k, v) for k, v in rows.items())
    body = (
        "---\n"
        'company: "{n}"\n'
        'title: "Engineer {n}"\n'
        'url: "https://example.com/jobs/{n}"\n'
        "status: {s}\n"
        "first_seen: 2026-09-01\n"
        "last_seen: 2026-09-01\n"
        "score: {sc}\n"
        "bucket: direct\n"
        "channel: ats\n"
        "---\n\n"
        "# {n} — Engineer\n\n"
        "## Verdict\n\nscore **{sc}** · direct · live\n\n"
        "## Posting facts\n\n| key | value |\n| --- | --- |\n{t}\n\n"
    ).format(n=name, s=status, sc=score, t=table)
    if role:
        body += (
            "## The role\n\n**Snapshot** — Build things.\n\n"
            "**What you'd do**\n\n- Ship code\n- Review PRs\n\n"
            "**Must have**\n\n- TypeScript\n\n"
        )
    body += "## Provenance\n\nsource x · channel ats\n\n" + MARKER + "\n\n"
    body += "\n".join(log or ["- 2026-09-01 · found by scout — job-scout"]) + "\n"
    return body


class SliceStore(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = os.path.realpath(self._tmp.name)
        self.jobs = os.path.join(self.root, "scout", "jobs")
        os.makedirs(self.jobs)
        self._out = tempfile.TemporaryDirectory()
        self.addCleanup(self._out.cleanup)
        self.outside = os.path.realpath(self._out.name)

    def write(self, name: str, text: str) -> None:
        with open(os.path.join(self.jobs, name), "w", encoding="utf-8") as handle:
            handle.write(text)

    def run_slice(self, **payload: object) -> Dict[str, object]:
        payload["root"] = self.root
        code, result = slice_payload(payload)
        self.assertEqual(code, 0, result)
        return result

    def files(self, result: Dict[str, object]) -> List[str]:
        return [row["file"] for row in result["filter"]]  # type: ignore

    def seed(self) -> None:
        self.write("a-new.md", dossier("A"))
        self.write("b-applied.md", dossier("B", status="applied"))
        self.write("c-dropped.md", dossier("C", status="dropped"))
        self.write(
            "d-dead.md",
            dossier("D", log=["- 2026-09-02 · posting dead: gone — job-scout"]),
        )

    def test_new_selects_only_live_new(self) -> None:
        self.seed()
        result = self.run_slice(select="new")
        self.assertEqual(self.files(result), ["a-new.md"])
        self.assertEqual(result["count"], 1)
        self.assertEqual(result["gaps"], [])

    def test_all_drops_dropped_and_dead(self) -> None:
        self.seed()
        result = self.run_slice(select="all")
        self.assertEqual(self.files(result), ["a-new.md", "b-applied.md"])

    def test_file_selection_ignores_status_and_dead(self) -> None:
        self.seed()
        for name in ("c-dropped.md", "d-dead.md"):
            result = self.run_slice(select=name)
            self.assertEqual(self.files(result), [name])

    def test_unknown_file_is_error(self) -> None:
        code, result = slice_payload({"root": self.root, "select": "nope.md"})
        self.assertEqual(code, 1)
        self.assertIn("slice_error", result)

    def test_live_again_revives(self) -> None:
        self.write(
            "e.md",
            dossier(
                "E",
                log=[
                    "- 2026-09-02 · posting dead: gone — job-scout",
                    "- 2026-09-03 · posting live again — job-scout",
                    "- 2026-09-04 · applied via ats — job-apply",
                ],
            ),
        )
        self.assertEqual(self.files(self.run_slice(select="new")), ["e.md"])

    def test_closure_after_reopen_kills(self) -> None:
        self.write(
            "f.md",
            dossier(
                "F",
                log=[
                    "- 2026-09-03 · posting live again — job-scout",
                    "- 2026-09-04 · posting dead: gone — job-prep",
                ],
            ),
        )
        self.assertEqual(self.files(self.run_slice(select="new")), [])

    def test_operator_reopen_is_not_posting_state(self) -> None:
        self.write(
            "g.md",
            dossier(
                "G",
                log=[
                    "- 2026-09-02 · posting dead: gone — job-scout",
                    "- 2026-09-03 · posting live again — operator",
                ],
            ),
        )
        self.assertEqual(self.files(self.run_slice(select="new")), [])

    def test_outreach_lines_are_not_posting_state(self) -> None:
        self.write(
            "h.md",
            dossier(
                "H",
                status="applied",
                log=[
                    "- 2026-09-02 · posting dead: gone — job-scout",
                    "- 2026-09-03 · outreach sent: first · account:a@x.com · thread:t1 — job-outreach",
                    "- 2026-09-10 · outreach stopped: reply in thread · account:a@x.com · thread:t1 — job-outreach",
                ],
            ),
        )
        self.write(
            "i.md",
            dossier(
                "I",
                status="applied",
                log=[
                    "- 2026-09-03 · outreach sent: first · account:a@x.com · thread:t2 — job-outreach",
                    "- 2026-09-04 · outreach unconfirmed: follow-up-1 — job-outreach",
                ],
            ),
        )
        self.assertEqual(self.files(self.run_slice(select="all")), ["i.md"])

    def test_exclude(self) -> None:
        self.seed()
        result = self.run_slice(select="all", exclude=["applied"])
        self.assertEqual(self.files(result), ["a-new.md"])
        result = self.run_slice(select="new", exclude=["new"])
        self.assertEqual(self.files(result), [])

    def test_skip_and_batches(self) -> None:
        for name in ("a", "b", "c", "d", "e"):
            self.write("{0}.md".format(name), dossier(name.upper()))
        out = os.path.join(self.outside, "run")
        result = self.run_slice(select="new", skip=["b.md"], out=out, batch=2)
        self.assertEqual(result["count"], 4)
        expected = [os.path.join(out, "extract-01.json"), os.path.join(out, "extract-02.json")]
        self.assertEqual(result["batches"], expected)
        self.assertEqual(sorted(os.listdir(out)), ["extract-01.json", "extract-02.json"])
        with open(expected[0], encoding="utf-8") as handle:
            first = json.load(handle)["excerpts"]
        with open(expected[1], encoding="utf-8") as handle:
            second = json.load(handle)["excerpts"]
        self.assertEqual([e["file"] for e in first], ["a.md", "c.md"])
        self.assertEqual([e["file"] for e in second], ["d.md", "e.md"])
        one = first[0]
        self.assertEqual(one["url"], "https://example.com/jobs/A")
        self.assertEqual(one["score"], 8)
        self.assertEqual(one["status"], "new")
        self.assertEqual(one["facts"]["location"], "Portugal")
        self.assertEqual(
            one["role"],
            {"snapshot": "Build things.", "do": ["Ship code", "Review PRs"], "must": ["TypeScript"]},
        )

    def test_default_batch_is_ten(self) -> None:
        for index in range(11):
            self.write("j{0:02d}.md".format(index), dossier("J{0}".format(index)))
        out = os.path.join(self.outside, "run")
        result = self.run_slice(select="new", out=out)
        self.assertEqual(len(result["batches"]), 2)  # type: ignore

    def test_filter_fields_and_unescape(self) -> None:
        self.write(
            "p.md",
            dossier(
                "P",
                facts={
                    "work_auth": "EU \\| UK",
                    "eligibility": "confirmed",
                    "eligibility_evidence": "Remote, anywhere in the UK",
                },
            ),
        )
        row = self.run_slice(select="new")["filter"][0]  # type: ignore
        self.assertEqual(row["work_auth"], "EU | UK")
        self.assertEqual(row["eligibility"], "confirmed")
        self.assertEqual(row["eligibility_evidence"], "Remote, anywhere in the UK")
        self.assertEqual(row["salary"], "—")
        self.assertEqual(row["hiring_route"], "—")
        self.assertEqual(row["company"], "P")

    def test_missing_role_sections(self) -> None:
        self.write("q.md", dossier("Q", role=False, score="—"))
        out = os.path.join(self.outside, "run")
        result = self.run_slice(select="new", out=out)
        with open(result["batches"][0], encoding="utf-8") as handle:  # type: ignore
            item = json.load(handle)["excerpts"][0]
        self.assertEqual(item["role"], {"snapshot": None, "do": [], "must": []})
        self.assertIsNone(item["score"])

    def test_partial_role(self) -> None:
        text = dossier("R", role=False).replace(
            "## Provenance", "## The role\n\n**Must have**\n\n- Go\n\n## Provenance"
        )
        self.write("r.md", text)
        out = os.path.join(self.outside, "run")
        result = self.run_slice(select="new", out=out)
        with open(result["batches"][0], encoding="utf-8") as handle:  # type: ignore
            item = json.load(handle)["excerpts"][0]
        self.assertEqual(item["role"], {"snapshot": None, "do": [], "must": ["Go"]})

    def test_unparseable_goes_to_gaps(self) -> None:
        self.write("a-new.md", dossier("A"))
        self.write("junk.md", "not a dossier\n")
        os.makedirs(os.path.join(self.jobs, "x.md.lock"))
        result = self.run_slice(select="new")
        self.assertEqual(self.files(result), ["a-new.md"])
        self.assertEqual([g["path"] for g in result["gaps"]], [os.path.join(self.jobs, "junk.md")])  # type: ignore
        self.assertTrue(result["gaps"][0]["reason"])  # type: ignore

    def test_missing_store_is_empty(self) -> None:
        code, result = slice_payload({"root": os.path.join(self.root, "elsewhere"), "select": "new"})
        self.assertEqual((code, result["count"]), (0, 0))

    def test_bad_payloads(self) -> None:
        bad: List[object] = [
            [],
            {"select": "new"},
            {"root": "relative", "select": "new"},
            {"root": self.root},
            {"root": self.root, "select": "../x.md"},
            {"root": self.root, "select": "sideways"},
            {"root": self.root, "select": "new", "exclude": ["dead"]},
            {"root": self.root, "select": "new", "skip": "a.md"},
            {"root": self.root, "select": "new", "out": "rel"},
            {"root": self.root, "select": "new", "out": self.root},
            {"root": self.root, "select": "new", "out": os.path.join(self.root, "run")},
            {"root": self.root, "select": "new", "batch": 0},
            {"root": self.root, "select": "new", "batch": True},
        ]
        for payload in bad:
            code, result = slice_payload(payload)
            self.assertEqual(code, 1, payload)
            self.assertEqual(list(result), ["slice_error"], payload)
        self.assertEqual(
            slice_payload({"select": "new"}),
            (1, {"slice_error": "root must be an absolute path"}),
        )

    def test_cli(self) -> None:
        self.write("a-new.md", dossier("A"))
        proc = subprocess.run(
            [sys.executable, SCRIPT],
            input=json.dumps({"root": self.root, "select": "new"}).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=os.path.dirname(SCRIPT),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["count"], 1)
        proc = subprocess.run(
            [sys.executable, SCRIPT], input=b"{", stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        self.assertEqual(proc.returncode, 1)
        self.assertIn("slice_error", json.loads(proc.stdout))


if __name__ == "__main__":
    unittest.main()

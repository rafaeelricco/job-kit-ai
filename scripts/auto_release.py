#!/usr/bin/env python3
"""Pure release policies with validated data and explicit Git/GitHub adapters."""

import argparse
import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal, Mapping, NewType, Optional, Union, cast

import package_release


CommitSha = NewType("CommitSha", str)
Repository = NewType("Repository", str)
RunNumber = NewType("RunNumber", int)
RunId = NewType("RunId", int)
WorkflowId = NewType("WorkflowId", int)
ReleaseId = NewType("ReleaseId", int)
Bump = Literal["patch", "minor", "major"]
Method = Literal["GET", "POST", "PATCH"]
CommandRunner = Callable[[tuple[str, ...]], str]
JsonFields = tuple[tuple[str, Union[str, bool]], ...]


@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int


@dataclass(frozen=True)
class Tag:
    name: str
    version: Version
    commit: CommitSha


@dataclass(frozen=True)
class WorkflowRun:
    number: RunNumber
    event: str
    status: str
    conclusion: Optional[str]
    url: str


@dataclass(frozen=True)
class CurrentRun:
    workflow: WorkflowId
    number: RunNumber


@dataclass(frozen=True)
class Release:
    identifier: ReleaseId
    tag: str
    draft: bool
    prerelease: bool


@dataclass(frozen=True)
class AdmitConfig:
    repository: Repository
    run_id: RunId
    event_name: str
    event_path: Path
    output_path: Path
    skip_through: RunNumber


@dataclass(frozen=True)
class MergeContext:
    commit: CommitSha
    bump: Bump


@dataclass(frozen=True)
class PublishConfig:
    repository: Repository
    commit: CommitSha
    bump: Bump
    output: Path


@dataclass(frozen=True)
class PublicationSnapshot:
    head: CommitSha
    tags: tuple[Tag, ...]
    releases: tuple[Release, ...]
    latest_is_ancestor: Optional[bool]


@dataclass(frozen=True)
class Proceed:
    pass


@dataclass(frozen=True)
class Skipped:
    through: RunNumber


@dataclass(frozen=True)
class Blocked:
    reason: str


@dataclass(frozen=True)
class AlreadyPublished:
    tag: str


@dataclass(frozen=True)
class ReleaseTarget:
    tag: str
    create_tag: bool


@dataclass(frozen=True)
class CreateRelease:
    target: ReleaseTarget


@dataclass(frozen=True)
class ResumeDraft:
    target: ReleaseTarget
    identifier: ReleaseId


AdmissionDecision = Union[Proceed, Skipped, Blocked]
PublicationDecision = Union[AlreadyPublished, CreateRelease, ResumeDraft, Blocked]


@dataclass(frozen=True)
class ReleaseAdapters:
    run: CommandRunner
    build: Callable[[str, Path], None]


# Boundary decoders validate external values before they become domain records.
def fields(value: object) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    # Only erase unknown key/value types after checking the container; each key
    # and each consumed field is validated separately below.
    entries = cast("dict[object, object]", value)
    return {text(key): item for key, item in entries.items()}


def sequence(value: object) -> tuple[object, ...]:
    if not isinstance(value, list):
        raise ValueError("expected a JSON array")
    return tuple(cast("list[object]", value))


def text(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("expected a string")
    return value


def boolean(value: object) -> bool:
    if not isinstance(value, bool):
        raise ValueError("expected a boolean")
    return value


def natural(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("expected a nonnegative integer")
    return value


def decimal(value: str, name: str) -> int:
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError(f"{name} must be a nonnegative integer")
    return int(value)


def decode_sha(value: object) -> CommitSha:
    candidate = text(value)
    if not re.fullmatch(r"[0-9a-f]{40}", candidate):
        raise ValueError("expected a valid commit SHA")
    return CommitSha(candidate)


def decode_repository(value: str) -> Repository:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value):
        raise ValueError("GITHUB_REPOSITORY must be owner/repository")
    return Repository(value)


def decode_bump(value: str) -> Bump:
    if value not in {"patch", "minor", "major"}:
        raise ValueError("release bump must be patch, minor, or major")
    if value == "major":
        return "major"
    return "minor" if value == "minor" else "patch"


def parse_version(value: str) -> Optional[Version]:
    match = re.fullmatch(r"v([0-9]+)\.([0-9]+)\.([0-9]+)", value)
    return Version(int(match[1]), int(match[2]), int(match[3])) if match else None


def format_version(version: Version) -> str:
    return f"v{version.major}.{version.minor}.{version.patch}"


def decode_run(value: object) -> WorkflowRun:
    item = fields(value)
    conclusion = item["conclusion"]
    return WorkflowRun(RunNumber(natural(item["run_number"])), text(item["event"]),
                       text(item["status"]), None if conclusion is None else text(conclusion),
                       text(item["html_url"]))


def decode_release(value: object) -> Release:
    item = fields(value)
    return Release(ReleaseId(natural(item["id"])), text(item["tag_name"]),
                   boolean(item["draft"]), boolean(item["prerelease"]))


def admit_config(env: Mapping[str, str]) -> AdmitConfig:
    return AdmitConfig(decode_repository(env["GITHUB_REPOSITORY"]),
                       RunId(decimal(env["GITHUB_RUN_ID"], "GITHUB_RUN_ID")),
                       env["GITHUB_EVENT_NAME"], Path(env["GITHUB_EVENT_PATH"]),
                       Path(env["GITHUB_OUTPUT"]), RunNumber(decimal(
                           env.get("RELEASE_SKIP_THROUGH_RUN", "0"), "RELEASE_SKIP_THROUGH_RUN")))


def publish_config(env: Mapping[str, str], output: Path) -> PublishConfig:
    return PublishConfig(decode_repository(env["GITHUB_REPOSITORY"]),
                         decode_sha(env["RELEASE_SHA"]), decode_bump(env["RELEASE_BUMP"]), output)


def decode_merge(value: object, config: AdmitConfig) -> MergeContext:
    event = fields(value)
    pr = fields(event["pull_request"])
    base = fields(pr["base"])
    if (config.event_name != "pull_request_target" or text(event["action"]) != "closed"
            or not boolean(pr["merged"]) or text(base["ref"]) != "main"
            or text(fields(base["repo"])["full_name"]) != config.repository):
        raise ValueError("release admission requires a PR merged into this repository's main")
    labels = frozenset(text(fields(label)["name"]) for label in sequence(pr["labels"]))
    bump: Bump = "major" if "release:major" in labels else (
        "minor" if "release:minor" in labels else "patch")
    return MergeContext(decode_sha(pr["merge_commit_sha"]), bump)


# Pure policy: decisions depend only on immutable, validated inputs.
def increment(version: Version, bump: Bump) -> Version:
    if bump == "major":
        return Version(version.major + 1, 0, 0)
    if bump == "minor":
        return Version(version.major, version.minor + 1, 0)
    return Version(version.major, version.minor, version.patch + 1)


def choose_version(tags: tuple[Tag, ...], commit: CommitSha, bump: Bump) -> Version:
    existing = tuple(tag.version for tag in tags if tag.commit == commit)
    if existing:
        return max(existing)
    return increment(max(tag.version for tag in tags), bump) if tags else Version(1, 0, 0)


def decide_admission(runs: tuple[WorkflowRun, ...], current: RunNumber,
                     skip_through: RunNumber) -> AdmissionDecision:
    if current <= skip_through:
        return Skipped(skip_through)
    blockers = tuple(run for run in runs if run.event == "pull_request_target"
                     and skip_through < run.number < current
                     and (run.status != "completed" or run.conclusion not in {"success", "skipped"}))
    if blockers:
        earliest = min(blockers, key=lambda run: run.number)
        return Blocked("Repair and rerun the earlier release, or set RELEASE_SKIP_THROUGH_RUN to "
                       f"{earliest.number} if it cannot be rerun: {earliest.url}")
    return Proceed()


def latest_published(releases: tuple[Release, ...]) -> Optional[Release]:
    candidates = tuple((version, release) for release in releases
                       if not release.draft and not release.prerelease
                       for version in (parse_version(release.tag),) if version is not None)
    return max(candidates, key=lambda pair: pair[0])[1] if candidates else None


def published_for_commit(snapshot: PublicationSnapshot, commit: CommitSha) -> Optional[Release]:
    names = frozenset(tag.name for tag in snapshot.tags if tag.commit == commit)
    return next((release for release in snapshot.releases if release.tag in names
                 and not release.draft and not release.prerelease), None)


def decide_publication(config: PublishConfig, snapshot: PublicationSnapshot) -> PublicationDecision:
    if snapshot.head != config.commit:
        return Blocked("publication checkout does not match the verified RELEASE_SHA")
    published = published_for_commit(snapshot, config.commit)
    if published is not None:
        return AlreadyPublished(published.tag)
    version = choose_version(snapshot.tags, config.commit, config.bump)
    latest = latest_published(snapshot.releases)
    if latest is not None:
        if snapshot.latest_is_ancestor is not True:
            return Blocked("refusing to replace newer released code with an older or divergent commit")
        latest_version = parse_version(latest.tag)
        if latest_version is not None and version <= latest_version:
            return Blocked("reserved version is older than the latest release; abandon this run explicitly")
    # Preserve the spelling of an existing tag, including leading zeroes.
    existing = next((tag for tag in snapshot.tags
                     if tag.commit == config.commit and tag.version == version), None)
    name = existing.name if existing is not None else format_version(version)
    target = ReleaseTarget(name, existing is None)
    release = next((release for release in snapshot.releases if release.tag == name), None)
    if release is None:
        return CreateRelease(target)
    if not release.draft:
        return Blocked("release is no longer the expected draft; refusing to replace assets")
    return ResumeDraft(target, release.identifier)


# Effects: subprocesses, pagination, files and writes stay in these adapters.
def command(root: Path, args: tuple[str, ...]) -> str:
    result = subprocess.run(args, cwd=root, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{' '.join(args[:3])} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


def gh_json(run: CommandRunner, endpoint: str, method: Method = "GET",
            values: JsonFields = ()) -> object:
    arguments = tuple(part for name, value in values for part in (
        "-F" if isinstance(value, bool) else "-f",
        f"{name}={str(value).lower() if isinstance(value, bool) else value}"))
    value: object = json.loads(run(("gh", "api", endpoint, "--method", method) + arguments))
    return value


def gh_pages(run: CommandRunner, endpoint: str, key: Optional[str] = None) -> tuple[object, ...]:
    items: list[object] = []
    page = 1
    while True:
        response = gh_json(run, f"{endpoint}?per_page=100&page={page}")
        batch = sequence(fields(response)[key] if key else response)
        items.extend(batch)
        if len(batch) < 100:
            return tuple(items)
        page += 1


def fetch_workflow_runs(run: CommandRunner, repository: Repository,
                        workflow: WorkflowId) -> tuple[WorkflowRun, ...]:
    return tuple(decode_run(item) for item in gh_pages(
        run, f"repos/{repository}/actions/workflows/{workflow}/runs", "workflow_runs"))


def fetch_releases(run: CommandRunner, repository: Repository) -> tuple[Release, ...]:
    return tuple(decode_release(item) for item in gh_pages(run, f"repos/{repository}/releases"))


def read_tags(run: CommandRunner) -> tuple[Tag, ...]:
    run(("git", "fetch", "--tags", "origin"))
    names = run(("git", "for-each-ref", "--format=%(refname:strip=2)", "refs/tags"))
    return tuple(Tag(name, version, decode_sha(run((
        "git", "rev-parse", "--verify", f"refs/tags/{name}^{{commit}}" )).strip()))
        for name in names.splitlines()
        for version in (parse_version(name),) if version is not None)


def admit(config: AdmitConfig, run: CommandRunner) -> str:
    raw: object = json.loads(config.event_path.read_text(encoding="utf-8"))
    context = decode_merge(raw, config)
    if decode_sha(run(("git", "rev-parse", "HEAD")).strip()) != context.commit:
        raise ValueError("admission checkout does not match merge_commit_sha")
    data = fields(gh_json(run, f"repos/{config.repository}/actions/runs/{config.run_id}"))
    current = CurrentRun(WorkflowId(natural(data["workflow_id"])), RunNumber(natural(data["run_number"])))
    # Fetch unfiltered pages: filtered workflow searches have a result limit.
    runs = fetch_workflow_runs(run, config.repository, current.workflow)
    decision = decide_admission(runs, current.number, config.skip_through)
    if isinstance(decision, Blocked):
        raise RuntimeError(decision.reason)
    proceed = isinstance(decision, Proceed)
    with config.output_path.open("a", encoding="utf-8") as output:
        output.write(f"proceed={str(proceed).lower()}\nmerge_sha={context.commit}\nbump={context.bump}\n")
    return "" if proceed else f"Release run {current.number} explicitly skipped through {config.skip_through}"


def load_publication_snapshot(config: PublishConfig, run: CommandRunner) -> PublicationSnapshot:
    head = decode_sha(run(("git", "rev-parse", "HEAD")).strip())
    if head != config.commit:
        return PublicationSnapshot(head, (), (), None)
    tags = read_tags(run)
    releases = fetch_releases(run, config.repository)
    snapshot = PublicationSnapshot(head, tags, releases, None)
    latest = latest_published(releases)
    if latest is None or published_for_commit(snapshot, config.commit) is not None:
        return snapshot
    previous = next((tag.commit for tag in tags if tag.name == latest.tag), None)
    if previous is None:
        return snapshot
    ancestor = decode_sha(run(("git", "merge-base", previous, config.commit)).strip())
    return PublicationSnapshot(head, tags, releases, ancestor == previous)


def execute_publication(decision: PublicationDecision, config: PublishConfig,
                        adapters: ReleaseAdapters) -> str:
    if isinstance(decision, Blocked):
        raise ValueError(decision.reason)
    if isinstance(decision, AlreadyPublished):
        return f"Already published {decision.tag} for {config.commit}; nothing changed"
    target = decision.target
    output = config.output.resolve()
    adapters.build(target.tag, output)
    endpoint = f"repos/{config.repository}"
    if target.create_tag:
        gh_json(adapters.run, f"{endpoint}/git/refs", "POST",
                (("ref", f"refs/tags/{target.tag}"), ("sha", config.commit)))
    if isinstance(decision, CreateRelease):
        created = decode_release(gh_json(adapters.run, f"{endpoint}/releases", "POST", (
            ("tag_name", target.tag), ("target_commitish", config.commit),
            ("name", target.tag), ("draft", True), ("generate_release_notes", True))))
        identifier = created.identifier
    else:
        identifier = decision.identifier
    # A prior pure decision never authorizes clobbering a now-published release.
    release = decode_release(gh_json(adapters.run, f"{endpoint}/releases/{identifier}"))
    if release.tag != target.tag or not release.draft:
        raise ValueError("release is no longer the expected draft; refusing to replace assets")
    assets = (f"job-kit-{target.tag}.tar.gz", f"job-kit-{target.tag}.zip", "VERSION", "SHA256SUMS")
    adapters.run(("gh", "release", "upload", target.tag, "--repo", config.repository, "--clobber")
                 + tuple(str(output / name) for name in assets))
    gh_json(adapters.run, f"{endpoint}/releases/{identifier}", "PATCH",
            (("draft", False), ("make_latest", "true")))
    return f"Published {target.tag} for {config.commit}"


def publish(config: PublishConfig, adapters: ReleaseAdapters) -> str:
    snapshot = load_publication_snapshot(config, adapters.run)
    decision = decide_publication(config, snapshot)
    return execute_publication(decision, config, adapters)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="operation", required=True)
    subparsers.add_parser("admit")
    publication = subparsers.add_parser("publish")
    publication.add_argument("--output", required=True)
    args = fields(vars(parser.parse_args()))
    root = Path(__file__).resolve().parents[1]

    def run(arguments: tuple[str, ...]) -> str:
        return command(root, arguments)

    try:
        if text(args["operation"]) == "admit":
            message = admit(admit_config(os.environ), run)
        else:
            config = publish_config(os.environ, Path(text(args["output"])))
            message = publish(config, ReleaseAdapters(run, package_release.build_release))
        if message:
            print(message)
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        parser.exit(1, f"auto_release.py: {error}\n")


if __name__ == "__main__":
    main()

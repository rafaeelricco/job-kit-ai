# VPS CI setup

GitHub Actions schedules these jobs; the dedicated `VPS-CI-job-kit-ai` runner executes them on `r1cco.com`. GitHub artifact storage and external deployment or package services remain separate.

The runner uses the unprivileged `ci-job-kit-ai` account and private home `/srv/r1cco-ci/job-kit-ai`. Register it with `--no-default-labels --labels r1cco-ci`; do not add this label to a production deployment runner. The custom-only label keeps generic `self-hosted` deployment jobs on their existing runners. The account has no sudo or production Docker access.

Each account has its own workspace and tool cache. Docker-dependent repositories use a dedicated rootless daemon and service-level `DOCKER_HOST`; verify `docker info` reports rootless operation. Published container ports default to 127.0.0.1. Rootless Docker must retain systemd's canonical `user-UID.slice` hierarchy. That slice bounds the runner and its Docker processes together to 250% CPU and 4 GiB memory.

A root-owned job hook serializes CI across these runners and Nod, holding the slot until Runner.Worker exits after cleanup. Admission requires 6 GiB free disk. The per-repository memory limits and serialization are not a hard aggregate cap; monitor idle services, caches, and production headroom. Inspect and remove abandoned containers only through the relevant CI account's rootless socket.

For public repositories, require workflow approval for all external contributors and do not approve fork runs on this VPS. Workflow conditions reject fork PR code; trusted comment automation may inspect PR metadata before refusing an external head. Repository administrators must preserve these controls when changing workflows.

## Repository prerequisites and coverage

- macOS and Windows installer verification is disabled under the VPS-only policy. Linux verification and the Python-version matrix remain.
- Claude review needs administrator-provisioned bwrap, socat, and working unprivileged user namespaces; do not give workflow jobs sudo.

## Verification and activation

Run applicable non-publishing checks on the migration branch, confirm `VPS-CI-job-kit-ai` in GitHub job details, and inspect completed results before merging this PR. Native macOS/Windows coverage and unsupported npm trusted publishing remain disabled where documented above. Release and production deployment jobs require deliberate activation; do not execute them merely to test runner registration.

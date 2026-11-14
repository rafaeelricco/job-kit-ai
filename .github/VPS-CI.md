# VPS CI setup

GitHub Actions schedules these jobs; the `r1cco-ci` runner executes them on the VPS. GitHub artifact storage and external deployment or package services remain separate.

Before enabling this routing, register a runner for this repository under its own unprivileged Linux account and home directory. Use `--no-default-labels --labels r1cco-ci`; do not add `r1cco-ci` to an existing production deployment runner. The custom-only label keeps generic `self-hosted` deployment jobs on their existing runners.

Give the account a writable tool cache and only its own workspace. Do not add it to the host Docker or sudo groups. For Docker jobs, provision an isolated rootless daemon and its socket for that account. Set `DOCKER_HOST` in the runner service environment and verify `docker info` reports rootless operation from that service account; job containers and services start before workflow steps, so a shell-only Docker context is insufficient. Bound aggregate CI CPU, memory, concurrency, and disk usage before enabling additional repository runners on the shared VPS.

For public repositories, require workflow approval for all external contributors and do not approve fork runs on this VPS. Workflow conditions reject fork PR code; trusted comment automation may inspect PR metadata before refusing an external head. Repository administrators must preserve these controls when changing workflows.

## Repository prerequisites and coverage

- macOS and Windows installer verification is disabled under the VPS-only policy. Linux verification and the Python-version matrix remain.
- Claude review needs administrator-provisioned bwrap, socat, and working unprivileged user namespaces; do not give workflow jobs sudo.

## Activation verification

Keep the migration PR in draft until the dedicated runner is registered, online, and its prerequisites are installed. Run the applicable non-publishing checks on a trusted branch, confirm the runner name in GitHub job details, and inspect the final logs. Release and production deployment jobs require a separate deliberate activation; do not run them merely to test runner registration.

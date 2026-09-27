# Web-only product platform

Status: accepted · Updated: 2026-09-21 · Implementation: not implemented
Supersedes: [Decision 0001: Personal companion execution](0001-personal-companion.md)

## Context

The initial product proposal depended on a local companion for user-selected AI runtimes and authenticated browsers. The current product target instead retains the existing React/Vite application in `packages/frontend/` and provides a focused web workflow for the first useful scout and match result. Requiring device enrollment or a local process would add installation and availability dependencies to this journey.

## Decision

Job Kit is web-only in the current and selected future design. Keep the existing `packages/frontend/` routes, settings, and design system. V1 covers Login, Onboarding, AI profile, First scout, and checking matches in the existing dossiers UI before opening a posting. Server-side services execute bounded work and persist durable progress.

Do not select or require a companion, desktop app, enrollment, local executor, browser extension, or device wait. Keep the current local skill distribution unchanged. Preserve profile and dossier import/export compatibility while migrating data access to authorized API commands and queries.

Application mechanisms, including a copy-apply-prompt flow and integrated application preparation or submission, remain undecided post-V1 work. Gmail and recurring automation are also post-V1. The proposed Applications and Communications domain invariants remain useful examples, but they do not select an execution mechanism.

## Alternatives considered

- Web app plus enrolled companion for local subscription and authenticated-browser work; this was the earlier proposal in [Decision 0001](0001-personal-companion.md).
- Desktop-first product with a local service.
- Browser extension-assisted work in existing tabs.

## Consequences and open work

The web product depends on server availability and supported provider authorization. Profile AI and browser AI use encrypted server-side provider adapters; an unavailable provider requires explicit reconnect or user-directed switching. Public browser work runs on the selected VPS runtime in [Decision 0008](0008-self-hosted-platform.md) and [Decision 0006](0006-self-hosted-discovery-browser.md). No user-device installation is part of onboarding.

## Supersedes and design owner

This decision supersedes [personal companion execution](0001-personal-companion.md). The [platform overview](../architecture/overview.md) and [execution design](../architecture/execution.md) own the current design. Acceptance selects direction only; implementation and provider compatibility remain unproven.

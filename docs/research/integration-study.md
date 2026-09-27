# Job Kit: hosted platform and personal companion

> **Historical research, not current implementation guidance (updated 2026-09-21).** Preserve the dated evidence and validation limits below. Recommendations for companions, local executors, managed workflow/browser services, Supabase, or platform-selected AI routes are superseded. Current decisions are web-only, self-hosted on the owner's VPS, and user-funded AI connections for OpenAI, Gemini, Anthropic, and xAI; hosted compatibility and authorization remain unproven gates. TypeSafe matching remains platform-funded. If user AI is unavailable, work waits for reconnect or an explicit manual account switch. See the current [decision index](../decisions/README.md) and [platform architecture](../architecture/overview.md).

This document retains dated integration research. Explicit notes say which recommendations later [domain decisions](../domain/README.md) have revised. See the [documentation index](../README.md) for the reading order.

Research date: 2026-09-19. This proposal builds on the accepted audience, individual job seekers with private workspaces. It also builds on the user's preference for existing AI subscriptions and a local companion. Three parallel researchers covered browsers/discovery, Gmail/authentication, and schedulers/agent runtimes in successive workstreams. The main review examined the local `commit-tools` implementation and provider documentation, then reconciled the findings.

**Recommendation recorded on 2026-09-19:** the product should keep the React app and add a TypeScript API and PostgreSQL domain model. It should use Trigger.dev Cloud for scheduling and orchestration, and add a personal TypeScript companion for official agent runtimes and local browsers. Supabase can supply authentication, PostgreSQL, and private object storage. The launch should start with Codex as the first subscription-runtime proof, three public ATS discovery adapters, and one carefully tested application adapter.

This revises the earlier Temporal-first and cloud-browser-first suggestions. Event sourcing remains valuable, but neither an event store nor a workflow engine supplies provider authorization, browser login, or exactly-once external submission. All vendor capabilities below were researched from source code or official documentation; no live login, mailbox read, paid generation, or application submission was tested.

## Study disposition

Current proposals now live in the [architecture overview](../architecture/overview.md), [repository layout](../architecture/repository.md), and [delivery roadmap](../delivery/roadmap.md). The following findings retain their research date and validation limits; they are not fresh provider verification.

## 1. Google OAuth sign-in

The product should use Supabase Auth with Google as the only sign-in provider. It should keep an internal user ID and one private workspace ID; emails and provider identities are not tenant identifiers. It should provision the workspace idempotently and enforce ownership in every query, command, artifact, and executor request. [Google integration](https://supabase.com/docs/guides/auth/social-login/auth-google)

The auth service should own identity linking; application code should not merge records based on an email comparison. Supabase has automatic verified-identity linking behavior; manually linking different-email identities is documented as beta. The team should choose Better Auth instead if explicit-only linking and owned server sessions become primary requirements. Clerk is the alternative when prebuilt account-management UI outweighs having another vendor. [Linking behavior](https://supabase.com/docs/guides/auth/auth-identity-linking)

The product should use PKCE and validate the application's token at the API. The team should choose browser-readable Supabase sessions deliberately; an HttpOnly-only approach requires a backend-for-frontend design. The full comparison and account lifecycle are in [platform-auth.md](platform-auth.md).

## 2. Gmail is a separate resource connection

The product should offer **Connect Gmail** when the user enables reply tracking. A user who signs in with Google can connect a different Gmail address. Existing Codex/ChatGPT connector grants are not credentials the platform can inherit. A product connector needs its own authorized connection and lifecycle.

The integration should start with the direct Gmail API behind a small adapter. The current `job-inbox` needs full bodies and thread context, so `gmail.readonly` is the narrowest fitting scope; it is Restricted. For a public server-side product, the team should plan for Google's restricted-scope verification and required security-assessment process. Nango can later manage multiple integrations' credentials; neither Nango nor Composio removes all of the product's downstream responsibilities. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

Daily synchronization needs a history cursor, durable pending observations, bounded initial backfill, and recovery when a cursor expires. Newly tracked applications trigger targeted historical backfill. Push notifications are optional later. The product should distinguish `lastMailboxSyncAt`, `lastClassificationAt`, and outstanding coverage. While the companion sleeps, the UI should show that mail was checked and that classification is waiting. [Synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)

The product should keep mailbox content in deletable evidence storage, never in permanent event payloads. Before sending an excerpt to the selected model connection, it should check that connection's execution mode, training/retention controls, data class, and recorded authorization. A consumer subscription is not automatically eligible for Gmail-derived content. If the data contract is unresolved, classification stays pending; public-job matching can still proceed. [Workspace data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)

The product should store app identity, Gmail identity, agent-runtime identity, and browser-site identity independently. Disconnecting a resource and signing out of the web UI have different meanings. Google revocation can affect multiple OAuth clients in one project, so the team should test the actual grant boundary. Details and acceptance criteria: [gmail-connectors.md](gmail-connectors.md).

## 3. Use Trigger.dev Cloud, with business reliability in PostgreSQL

Trigger.dev is the first recommendation for this version's ease-of-use requirement. `schemaTask`, dynamic schedules, queues, and wait tokens fit daily discovery/mail sync and companion-result waits. Temporal remains preferable if long-lived process coordination becomes the dominant engineering challenge; pg-boss is attractive for a deliberately self-hosted, simpler task system; Inngest fits teams wanting durable functions on their own compute. [Schema tasks](https://trigger.dev/docs/tasks/schemaTask), [schedules](https://trigger.dev/docs/tasks/scheduled)

In one database transaction, the product should append the business event, create a workflow request, and insert its outbox row. It should dispatch using a stable request ID. Each external effect gets a permanent operation ID and input fingerprint. Scheduler deduplication expires, and retries can repeat effects; the application's operation record remains authoritative. Rebuilding projections must never dispatch workflows. [Trigger idempotency](https://trigger.dev/docs/idempotency), [replay semantics](https://trigger.dev/docs/replaying)

The cloud task dispatches a companion request and waits for a committed result; it does not run the user's provider login itself. The product should persist waits and user decisions in the application, then notify Trigger through the outbox. It should explicitly configure deadlines. A disconnected companion enters `waiting_for_device`; exhausted subscription capacity enters `waiting_for_provider`. Neither should spin through retries or automatically spend API credit.

Task input types are not enough: the product should validate all runtime boundaries, including agent outputs and completion callbacks. It should not place secrets in scheduler payloads. Trigger Cloud's checkpoint features are not currently reproduced by its self-hosted edition. Full comparisons and failure experiments: [schedulers.md](schedulers.md).

## 4. Reuse skills through official agent runtimes

The product should treat a skill as versioned instructions plus tools, input/output schemas, deterministic checks, and evaluation cases. It should preserve the Markdown references and existing Python scoring code, and keep portable domain content separate from local paths, connector names, shell assumptions, and UI handoff behavior. It should load the selected bundle for a task, not all skills into every prompt.

The product should provide typed platform tools for reading a profile snapshot and fetching posting evidence. It should also provide tools to validate a match, build a package, and propose an outcome. Models propose; domain commands validate. The inbox classifier has no browser or submission tools. The application agent cannot bypass the submission boundary through unrestricted shell or browser commands. Unsupported forms go to assisted completion until an adapter can constrain them.

The product should keep `job-match`'s 0–100 fit score distinct from `job-scout`'s 0–10 coverage score, and it should never turn unknown evidence into a confirmed candidate fact. It should store the skill digest, model/runtime version, and input revisions, along with output references and provenance. Agent conversation resume is useful execution context; the authoritative result is the validated record committed to PostgreSQL.

The team should use the official Codex TypeScript SDK over its CLI for the first bounded-task executor. The SDK wraps local CLI execution, and noninteractive execution can reuse saved CLI authentication. The integration should start the official login flow locally, and it should not collect the token into Job Kit. It should supply an explicit environment so an API-key variable cannot silently change the selected billing mode, and it should pin the SDK and CLI together. [Official SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md), [automation authentication](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation)

Codex App Server is the richer later option for embedded login, conversation control, approvals and account-limit events. Current documentation and installed CLI label it experimental, so its compatibility and support status need a separate launch decision. The team should prefer a local stdio child to an exposed WebSocket server. Claude Agent SDK provides a programmable harness and skills, but its subscription product-integration question remains unresolved below. API-based runtimes can also load skills; they do not convert subscription logins into API access. [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)

Skill discovery, permission configuration, and native tools vary by runtime version. An allowlist that preapproves tools is not necessarily a restriction on available tools. The team should test the effective tool set and sandbox, and keep platform invariants enforced outside the prompt. Full capability mapping and runtime comparisons: [agent-runtime.md](agent-runtime.md).

## 5. Adapt commit-tools' provider architecture, not every login implementation

The product should keep its provider configuration and model/effort selection. It should also keep the connection diagnosis, refresh lifecycle, and common output metadata. Its local source uses provider-specific SDKs and several CLI-specific subscription paths. That demonstrates an implementation pattern, not a universal third-party SaaS entitlement. The source review and proposed adapter contract are in [provider-connections.md](provider-connections.md).

For **ChatGPT**, the team should prototype the official Codex SDK/CLI runtime on the companion with its managed user login, and keep App Server's richer account/limit interface behind a separate adapter. Sign in with ChatGPT for external websites is separately documented as identity federation; it does not itself grant inference. [Managed authentication](https://learn.chatgpt.com/docs/auth), [external identity sign-in](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)

For **Claude**, current help says subscription-backed Agent SDK usage continues, while the developer guide requires prior approval before third-party products offer Claude login or rate limits. A built-in commercial subscription connector needs provider confirmation. The product should keep that adapter behind a capability gate; distributing skills/MCP tools for users to invoke inside their existing host is a separate integration path to evaluate. A local companion does not remove the product requirement. [Subscription help](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [developer restriction](https://code.claude.com/docs/en/agent-sdk/overview)

Gemini and Grok are later official-runtime candidates. The product should not extract cached OAuth tokens and replay them against provider backends. Gemini expressly restricts third-party direct access to its CLI services. Neither reviewed source establishes universal hosted subscription inference access. [Gemini terms](https://geminicli.com/docs/resources/tos-privacy/), [Grok CLI](https://docs.x.ai/build/cli/reference)

## 6. Applications need two browser modes and a durable attempt

**Autonomous local mode:** the companion launches a dedicated Playwright profile. The user logs into the relevant site once, and reconnects when the session expires. The profile does not inherit the normal browser's login. This mode should run only when the device is awake and connected. **Assisted mode:** an extension operates a user-selected existing tab and supports direct takeover. Minimal `activeTab` permissions require a gesture and expire across origins; that mode is not arbitrary background browser access. [Persistent profiles](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [extension access](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

For optional cloud execution, Browserbase is the preferred first benchmark candidate because it separates persistent contexts from interactive login and browser control. Browser Use Cloud V4 and Browserless are credible alternatives. Cloud sessions do not automatically reuse local authentication, and some device-bound logins may never migrate reliably. Browser infrastructure and AI browser-agent calls have separate costs from the user's chat subscription. [Browserbase contexts](https://docs.browserbase.com/platform/browser/core-features/contexts), [interactive sessions](https://docs.browserbase.com/platform/browser/observability/session-live-view)

The submission sequence is:

```text
prepare immutable package
→ verify current profile/posting/package revisions
→ claim browser account and inspect signed-in identity
→ fill and verify fields and uploaded bytes
→ validate current user policy and online execution authority
→ reserve durable submission attempt
→ submit
→ persist evidence locally and synchronize
→ confirm, or mark outcome_unknown and reconcile
```

The product should preserve authorized auto-submit as a policy. Human input is necessary for actual missing answers, login, MFA, or challenges; it need not become a mandatory confirmation for every application. The product should keep package authority tied to specific artifacts and answers.

The product should use a short-lived device lease, fencing generation, and connection/authorization version. Before submission, it should check current authority online. A lost heartbeat, expired lease, or revoked device cannot prove that an already-issued click failed. The product should never transfer an uncertain submission to another runner and click again; instead, it should reconcile through the ATS and uniquely matched evidence. No scheduler supplies exactly-once semantics for an arbitrary website.

The launch should cover one supported ATS path, not a promise to apply everywhere. Browser/tool compatibility, site access permission, and successful outcome confirmation are separate requirements. See [browser-applications.md](browser-applications.md).

## 7. Discovery should mostly avoid browsers

The product should build public HTTP adapters for Greenhouse, Lever, and Ashby. Search helps find companies and board URLs; authoritative posting reads establish facts. Public read access does not provide employer-only application submission keys. Browser extraction remains useful for permitted sources without a suitable API. [Greenhouse](https://docs.greenhouse.io/job-board.html), [Lever](https://github.com/lever/postings-api), [Ashby](https://developers.ashbyhq.com/docs/public-job-posting-api)

The product should begin with workspace-scoped posting identity and observations. Shared public collection is deferred. Private sources, unlisted/referral links, and queries should stay workspace-scoped, and so should candidate facts, matches, and application state. Ashby's `isListed=false` must not become shared discovery. A sleeping companion delays private matching, not public ingestion.

The product should use provider/region/board/posting identity plus URL aliases. It should preserve source publication and source modification separately from first seen, last checked, and content revision. A partial/failed/throttled crawl cannot establish that a job closed. Workday's commonly used anonymous CXS routes were not verified as a supported public API, so the team should keep that path experimental. Full source strategy: [job-discovery.md](job-discovery.md).

## What was examined

The review covered the application source, configuration, UI primitives, and design system. It also covered all 103 text files in `skill/`, which include its 13 skills plus references, templates, Python helpers, and tests. The review covered relevant root documentation too. Two parallel agents inspected a reference event-sourced application's event infrastructure and asynchronous execution. The review also checked current official documentation for the proposed workflow and supporting technologies. Dependencies, generated bundles and image assets were not treated as application logic. No runtime tests or production validation were performed.

## The current application

The application is a React 19 / TypeScript / Vite SPA using React Router, Tailwind, and Base UI wrappers. It also uses Recharts and browser filesystem access. It has five pages: Home, Dossiers, Resumes, Recommendations, and Answers, plus profile/search settings. There is no backend, authentication service or hosted job runner in this application.

`useStore` reads the selected folder, parses every dossier and builds an in-memory snapshot. Filtering, pagination and analytics run against that snapshot. Profile edits preserve YAML structure and check modification timestamps. Application actions create clipboard prompts for an external agent. The application counts application records in dossiers but does not parse their full contents into a preparation/submission interface. Sources: [store loading](../../packages/frontend/src/module/scout/helpers/use-store.ts#L54), [profile persistence](../../packages/frontend/src/module/profile/helpers/write-profile.ts#L56), [apply handoff](../../packages/frontend/src/module/scout/components/dossier.tsx#L264), [dossier view](../../packages/frontend/src/module/scout/components/dossier.tsx#L722).

The UI can be retained. Its controlled table and existing cards, sheets, forms and status components provide useful seams for API data. The team should replace filesystem hooks with query/command adapters, and keep the folder integration as an import/export option. The browser-only shell provides no compelling reason to adopt SSR for the authenticated console.

## What the reference application contributes

The reference application separates commands and aggregate reconstruction from events, queries, projections, and reactions. Commands append PostgreSQL events; Ambar delivers them to consumers; MongoDB holds projections. Its best reusable patterns are state validation against aggregates, durable command idempotency, projection updates committed with consumer receipts, and explicit authorization scope.

There are three qualifications to copying it:

1. The general scheduler appears as a documented design. The implemented demo-data supervisor polls inside each backend process and explicitly lacks a proper distributed lease. Some legacy imports use detached promises. It is not a production workflow engine to lift into Job Kit.
2. Normal event-store transactions currently use `RepeatableRead`, although several comments and local documents say Serializable. Unique stream versions protect concurrent writes to the same stream; arbitrary cross-stream invariants need additional coordination.
3. A consumer receipt does not make an external action atomic. A reaction can send an email and crash before committing its receipt. The same problem is more consequential for a submitted job application.

The product should retain the architectural separation without requiring MongoDB, the reference application's custom functional framework, or multiple manually synchronized consumer registries. If Ambar is already available as an operated service, it can provide event delivery. The product should give each workflow start one authoritative delivery path; it should not let Ambar reactions and an independent outbox both initiate the same work without shared deduplication.

## Workflow engine choice

| Choice                              | Fit for this product                                                                             | Main tradeoff                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Trigger.dev Cloud                   | Recommended for initial TypeScript tasks, managed execution, schedules and external-result waits | Application owns permanent idempotency; self-hosted features differ from Cloud                            |
| Temporal Cloud + TypeScript workers | Stronger choice when complex long-lived coordination becomes the dominant problem                | Requires learning deterministic workflow code and deployment/versioning rules; workers still need hosting |
| Inngest                             | Durable event functions while keeping compute on owned HTTP handlers or workers                  | Step/hosting limits and finite deduplication retention still require business state                       |
| pg-boss + PostgreSQL                | Best when the initial scope is scheduled discovery and short independent jobs                    | Application code must still implement durable process state, human waits and reconciliation               |

Temporal exposes [Signals and wait conditions](https://docs.temporal.io/develop/typescript/workflows/message-passing) and [Schedules](https://docs.temporal.io/develop/typescript/workflows/schedules). Trigger.dev supports [waitpoint tokens](https://trigger.dev/docs/wait-for-token); its [self-hosted feature matrix](https://trigger.dev/docs/self-hosting/overview) currently excludes Cloud checkpoints, so cloud and self-hosted behavior need separate evaluation. pg-boss supports jobs inserted within an existing database transaction and scheduling in its [official documentation](https://github.com/timgit/pg-boss).

The product should choose one workflow owner. Scheduler execution history is not the application's permanent business event store. Retry and heartbeat records belong to execution; the business event stream records what the user requested and what actually happened. See the [scheduler research](schedulers.md) for Trigger-specific retry, replay, wait and quota boundaries.

The product should give recurring discovery and inbox sync explicit timezone, overlap, missed-run and catch-up policies. It should apply per-workspace, per-account and provider limits. It should bound LLM usage and browser time per run, and expose exhausted budgets as a visible state. It should use separate worker queues for model work, document generation and browsers so slow browser sessions cannot occupy all execution capacity.

## Concrete stack

The product should keep React, Vite, React Router, Tailwind and the existing components. It should add TanStack Query for [server-state fetching and caching](https://tanstack.com/query/latest/docs/framework/react/overview), with workspace-scoped cache keys. It should use HTTP commands/queries and SSE or polling for run progress.

The product should use Node.js/TypeScript with Fastify, shared runtime schemas and an OpenAPI contract. Fastify supports [schema-based request validation and response serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/). The product should use PostgreSQL with Drizzle for routine schema/query work and explicit SQL where event append, locks or constraints need it; Drizzle provides [transaction primitives](https://orm.drizzle.team/docs/transactions).

For a small-team managed setup, Supabase is a reasonable starting point for PostgreSQL, [authentication](https://supabase.com/docs/guides/auth) and private [storage access policies](https://supabase.com/docs/guides/storage/security/access-control). The product should keep domain mutations behind the API/command layer. API credentials and user mail/ATS connections are separate concerns. It should not expose server service credentials to the browser.

The product should enforce workspace scope in keys, repositories, and artifacts, as well as in workflow IDs, caches, and worker messages. It should use PostgreSQL RLS as another isolation layer, not as a substitute for scoped commands; database owners and bypass roles need particular care. [RLS semantics](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

The product should host the SPA as static assets, run the API as a persistent service, and use Trigger.dev Cloud for tasks. The companion hosts personal agent/browser processes; cloud document rendering has an isolated toolchain. The product should keep the existing LaTeX/PDF path while adding friendlier document import later, and start in one region with managed PostgreSQL and private storage. Neither Kubernetes nor a second database is necessary for the initial design.

The product should use OpenTelemetry for [traces, metrics and logs](https://opentelemetry.io/docs/what-is-opentelemetry/), with redaction and bounded retention. Product operations should show run progress, queue age, and projection lag, as well as retries, external confirmation rate, and cost per successful preparation/application. Business success is more useful than raw task count.

## Original design rationale

The original platform review mapped capabilities into six modules inside a modular monolith, not thirteen independently deployed skill services. Posting identity, candidate opportunity, and submission attempt are separate concepts: posting closure does not erase an active interview. Stable internal IDs and workspace-scoped URL aliases preserve import identity without freezing a normalization algorithm into aggregate identity. Company/title similarity remains a possible-duplicate signal.

The earlier prepare-and-submit sketch strengthened the existing skill contract by freezing profile, posting, and answers, along with artifact digests and authority. The current prep contract already binds CV bytes with SHA-256; the old apply flow may resolve fields and author prose at submission time. Exact-package authorization therefore changes that behavior deliberately. See the [existing binding](../../skill/job-prep/references/schemas/schema-plan.md#L53) and the current [Applications design](../domain/applications.md). Bounded live changes remain an open extension.

The original repository sketch used broad integrations and skill-runtime packages. The follow-up study separated agent runtime, browser runtime, connectors, and versioned skill bundles. The consolidated [repository proposal](../architecture/repository.md) adopts those clearer adapter boundaries and retains a shared workflows package. This note preserves the earlier alternative without maintaining another target tree.

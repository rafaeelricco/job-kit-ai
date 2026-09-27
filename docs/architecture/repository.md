# Repository organization

Status: proposed · Updated: 2026-09-27 · Implementation: partial (packages/ workspace)

The deployment target is a web app plus VPS-hosted services. The existing React application lives in `packages/frontend/`, one package of the root pnpm workspace; do not require a UI rewrite. The current routes, settings, design system, and local skill distribution remain the starting point. The existing `.github/workflows/deploy-app.yml` continues to deploy the app to the VPS.

```text
packages/frontend/           Existing React/Vite UI, routes, settings, design system
packages/lib/           Shared Maybe/Result/Future, JSON schemas, time
packages/backend/
  api/                  Fastify TypeScript commands, queries, and auth callbacks
  workers/              TypeScript profile, evaluation, and document workers
  browser-worker/       Python Browser Use worker; dedicated VPS Chrome lifecycle
packages/
  contracts/            Versioned request, operation, and result schemas
  domain/               Workspace, candidate, discovery, evaluation, and dossiers
  application/          Commands, policies, use cases, and authorized ports
  persistence/           PostgreSQL/Drizzle repositories, events, receipts, intent
  providers/             Google OIDC and encrypted AI provider adapters
  sources/               Supported public job-source HTTP adapters
skill/                  Existing skill authoring and distribution source
```

This is a target map, not a claim that these directories exist today. Compose and deployment configuration should run the API and workers on private service networks. Only intended static app assets and authorized API routes are reachable from nginx. Private persistent volumes mount only into the services that require them.

Keep domain packages independent of Fastify, Drizzle, `pg-boss`, auth vendors, browsers, and model SDKs. API handlers and workers call application use cases through versioned contracts. The Python browser worker consumes JSON claim/result contracts; it does not import TypeScript packages or attach to Hermes's personal browser. Use the existing Python scoring and validation helpers until a separately justified migration.

## Existing application migration

The existing React/Vite app remains in `packages/frontend/`. Migrate its filesystem-backed data access journey by journey to workspace-scoped API queries and commands. Preserve the route structure, settings, design system, folder imports, editable profile export, and dossier export compatibility. API progress may use polling or SSE; the console does not require an SSR migration. Retain the current VPS deployment workflow for app delivery while adding service deployment deliberately.

Use shared runtime schemas and an OpenAPI boundary where they help keep the TypeScript API and UI aligned. Preserve profile and dossier import conflict review, provenance, and deduplication. Keep the current local skill distribution unchanged; platform work can call the skills through an adapter without repackaging or installing a companion.

## Skill capability mapping

| Existing skill      | Platform responsibility                                   | Treatment                                                                                                                                              |
| ------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `job-profile`       | Candidate facts, preferences, and search configuration    | Versioned confirmed snapshots; proposed facts and unknown gaps remain explicit                                                                         |
| `job-profile-root`  | Locating the current user's data                          | Resolve workspace from authentication; preserve path behavior only in the local skill adapter                                                          |
| `job-store`         | Posting identity, persistence, ownership, and eligibility | Domain rules, durable repositories, and dossier projection                                                                                             |
| `job-scout`         | Search, extraction, gating, and ranking                   | Persist source evidence first; hand off independent evaluation                                                                                         |
| `job-match`         | Evidence-backed fit evaluation                            | TypeSafe default, selected user AI fallback, and existing deterministic scorer                                                                         |
| `job-list`          | Lists, filters, details, and exports                      | Query API and existing dossiers UI                                                                                                                     |
| `job-prep`          | Form mapping and application package preparation          | Post-V1 domain capability; execution mechanism undecided                                                                                               |
| `job-apply`         | Submission, confirmation, and follow-up                   | Post-V1 domain capability; no selected submission mechanism                                                                                            |
| `job-resume-refine` | Tailored CV generation and checks                         | Post-V1; execution mechanism remains undecided                                                                                                         |
| `job-humanize`      | Wording refinement without changing claims                | Authoring capability with versioned prompts                                                                                                            |
| `job-inbox`         | Read and correlate messages                               | Post-V1; Gmail authorization and recurring automation remain deferred                                                                                  |
| `job-stories`       | Interview evidence and scripts                            | V1 retains existing story viewing and optional story-name intake; generated scripts and authoring are later work with an undecided execution mechanism |
| `captcha-solver`    | Existing local challenge-handling instructions            | Not a server discovery mechanism; public-site challenges are blocked in V1                                                                             |

These are capabilities inside domain modules, not separately deployed services. The platform uses selected V1 journeys of login, onboarding, AI profile, first scout, and checking matches in the existing dossiers UI before opening a posting. Application mechanisms, integrated preparation/submission, Gmail, and recurring automation are outside that selected V1 path.

Two scores remain distinct: scout's 0–10 required-skill coverage and match's weighted 0–100 fit score. Match confidence reflects scored evidence coverage; an unscored factor is unknown, not zero. Preserve the existing score semantics in the UI and API. Sources: [scout rank](../../skill/job-scout/references/flows/flow-rank.md#L3), [match scoring](../../skill/job-match/scripts/score.py#L200).

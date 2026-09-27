---
name: job-kit-dev
description: Use for any work in the job-kit-ai repo's server or web app. Backend: endpoints, commands, queries, aggregates, events, projections, reactions, auth guards, sessions and sign-in, env vars and integrations, `api.ts` registry wiring, and client endpoint consumption (`packages/backend/src`, `packages/frontend/src/api`). Frontend: pages, components, forms, tables, styling, assets, Tailwind/design tokens, and design-system work (`packages/frontend/src`). Trigger for: add an endpoint, create a command/query/event/projection/reaction, wire an API call, extend auth, build or review a page/component/form, tweak styling/layout, or update design tokens. The server has runtime-only gotchas and shared `.api.ts` types the app imports, so prefer this skill over guessing.
disable-model-invocation: false
---

# Job Kit Dev

Route to the matching domain index; it routes to the exact leaf.

## Route

- **Backend / API** (`packages/backend/src/`) → `references/back-end/index.md`
- **Web UI** (`packages/frontend/src/`) → `references/front-end/index.md`
- **Both** (a client change needs an API change) → read both; do the backend `.api.ts`
  change first so client imports compile against the real schema. If the command/query already
  exists and you're only consuming it, skip the back-end index → go straight to
  `references/front-end/index.md` (forms.md / `../back-end/client-usage.md`).
- **Timestamps / durations** (store an instant or length of time as a field, constant, or schema) → `references/time.md`

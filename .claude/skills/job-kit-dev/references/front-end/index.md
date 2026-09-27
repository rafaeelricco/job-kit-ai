# job-kit-ai web app — router

React + Vite at `packages/frontend/src/`. Worked code lives in each leaf. Reviewer rules live in `packages/frontend/CLAUDE.md`; rationale in
`packages/frontend/CONVENTIONS.md`.

## Routing table

| Task / signal                                                                                                | Read                                 |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| Design tokens, visual language, component specs, shared primitives, card visual spec, navigation             | `design-system.md`                   |
| Tailwind utilities, token files, on-demand class lookup                                                      | `tailwind.md`                        |
| Reusable `className` variants (`cva()`) or the `cn()` class-merge helper                                     | code — see Code locations            |
| Forms + typed API writes (`useForm`, `FormInput`, `call` / `Future` / `RemoteData`)                          | `forms.md`                           |
| Session/auth: `Session` union, `localStorage` cache, code + Google sign-in, root lifecycle, protected routes | `session.md`                         |
| `DataTable`: columns, rows, sorting, pagination, row actions                                                 | `tables.md`                          |
| Page skeleton: gate → presentational surface; `RemoteData` cell + composed `Future` reads                    | `pages.md`                           |
| Fonts, mascot, logo and other brand assets                                                                   | `assets/fonts.md`, `assets/brand.md` |
| Static preview catalog / visual reference                                                                    | `index.html`                         |
| Consuming backend endpoints (endpoint shape, registry wiring)                                                | `../back-end/client-usage.md`        |
| Timestamp or duration field / constant / helper (prefer `POSIX` / `Duration`)                                | `../time.md`                         |

Card visual shell / spec → `design-system.md`. Reusable `className` variants via
`cva()` / `cn()` → `components/ui` (Code locations).

## Workflow

1. `design-system.md` for visual constraints.
2. Leaf for the touched behavior: `forms.md`, `tables.md`, `pages.md`, `tailwind.md`, or `session.md`.
3. When an Audit trigger below applies, run that leaf's `## Audit` before editing.
4. Compose existing primitives before introducing new component shapes.
5. Backend calls: typed endpoint exports + `call`; `../back-end/client-usage.md` when endpoint shape or registry wiring is involved.
6. Verify with the app's own scripts (see Verification).

## Audit triggers

Run the named leaf's `## Audit` before editing when the work touches:

- **Forms & API → `forms.md`** — `useForm`, `FormInput`, `call` / `Future` / `RemoteData`, submit.
- **Tables → `tables.md`** — `DataTable`, `ColumnsConfig` / `columnOrder` / `rows`, sorting, pagination.
- **Pages → `pages.md`** — a page under `packages/frontend/src/pages/`, a gate, or a read that fills a `RemoteData` cell.
- **Session → `session.md`** — `module/session/session.ts`, `app.tsx`, `ProtectedRoute`, sign-in page, session cache.

## Stop and ask

- **Review-only** request: do not edit. Return findings, risks, and prioritized suggestions.
- **Plan-only / plan mode**: do not edit. Return a concrete implementation plan.
- **Design drift**: a prototype using undocumented color / radius / type size / spacing is not an automatic winner —
  stop and ask before adopting it. Design values must come from `packages/frontend/src/index.css`, as described in `design-system.md`.
- **Shared contracts** (tokens, primitives, routes, API shape, data models): flag the conflict and ask before
  normalizing. For isolated local style, follow the nearest local pattern with a scoped diff.

## Verification

- Run `pnpm typecheck`, `pnpm lint` and `pnpm build` from `packages/frontend/`. If a script is missing, say so — don't invent one.
- Colors resolve to documented tokens; type / weight / line-height / spacing / radius / motion match `design-system.md`;
  icons are Hugeicons (`@hugeicons/react`), not emoji or unicode glyphs.
- Forms use `@ui/forms`. API calls use the typed `api` map from `@api/endpoints` + `call` from `@api/request`.
- A token edit in `packages/frontend/src/index.css` updates `design-system.md` in the same diff. The preview catalog reads
  `index.css` directly and needs no resync; a new token gets a swatch in its `preview/colors-*.html` shard.

## Code locations

- Tokens: `packages/frontend/src/index.css` (authoritative). `preview/preview.css` imports it; there is no mirror,
  `tokens.json`, Style Dictionary or Figma pipeline.
- Primitives: `packages/frontend/src/components/ui/`; app shell: `packages/frontend/src/components/ui/app-layout.tsx` and `app-sidebar.tsx`;
  routes: `packages/frontend/src/app.tsx`; pages: `packages/frontend/src/pages/`; feature code: `packages/frontend/src/module/<feature>/`.
- `cn()`: `packages/frontend/src/components/utils.ts`. `cva()`: size variants → `components/ui/button.tsx`;
  boolean/enum variants → `components/ui/badge.tsx`.
- Session: `packages/frontend/src/module/session/session.ts` (API + `localStorage` cache + listeners), state in
  `packages/frontend/src/app.tsx`, guard in `packages/frontend/src/module/session/components/protected-route.tsx`.

Open `index.html` for the preview catalog (`preview/*`); `design-system.md` has the serve command.

## Scope

In: tokens, type, spacing, motion, chrome, shadcn primitives, app composites, Hugeicons, Inter, preview cards,
pages and feature modules under `packages/frontend/src/`.

Out: backend logic, auth domain logic, API modeling, data modeling, infra, illustrations, stock photography.
Backend changes → `../back-end/index.md`.

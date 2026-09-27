# app

Rules a reviewer can check on a diff. Rationale and examples for most live in `CONVENTIONS.md` and the design system at `.claude/skills/job-kit-dev/references/front-end/design-system.md`.

## Types and state

- No `any`, no parameter properties (`erasableSyntaxOnly`). Entity IDs use `Id<Tag>`, not `string & { __brand }`.
- Fallible operations return `Result`. `throw` only for programmer errors and platform boundaries (`JSON.parse`, File System Access, `fetch`).
- Async UI state is `RemoteData`; related state is one union, not loose `isLoading`/`isError` flags.
- Dossier strings read from `scout/jobs/` (`FRONTMATTER_KEYS`, `REQUIRED_SECTIONS`, `OWNERSHIP_MARKER` in `src/module/scout/parse-dossier.ts`) stay verbatim, snake case included.
- Cross-folder imports use the `@api`, `@components`, `@hooks`, `@lib`, `@module`, `@pages`, `@ui` aliases, not `../../` paths.
- Server endpoints are reached through `api` from `@api/endpoints` and `call` from `@api/request`, never imported from `@be/domain/*` directly.

## UI

- Scrollable regions use `ScrollArea` from `@ui/scroll-area`, not raw `overflow-auto` containers.
- Radius is 0 except sidebar rows (6px), identifier chips (4px), and pill elements (avatars, switch tracks, status dots, small clear buttons).
- Components use semantic color tokens, never the primitive ramps.
- A token added or changed in `src/index.css` is documented in the design system in the same diff.
- Machine-readable values (ids, paths, URLs, ISO dates, enums, hashes) render in `font-mono`. Prose never does.
- Table counts render with `toLocaleString()` only and right-align with `align: "right"` on the `ColumnDef` plus `tabular-nums`. Composite and interactive cells (a status dropdown, a badge beside a label) keep default alignment.

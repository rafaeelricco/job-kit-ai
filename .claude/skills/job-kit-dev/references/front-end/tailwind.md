# Tailwind

Tailwind v4, configured in CSS: `packages/frontend/src/index.css` holds the tokens, and its `@theme inline` block maps them to
utilities. There is no `tailwind.config.*`. Class merging goes through `cn()` in `packages/frontend/src/components/utils.ts`; primitives
live in `packages/frontend/src/components/ui/*`. See also `index.md` (routing) and `design-system.md` (visual spec).

- Use the semantic utilities the theme defines (`bg-surface`, `text-ink-muted`, `border-divider`), never the
  primitive ramps or raw hex.
- Look a class up on demand in `packages/frontend/src/index.css` rather than guessing; a utility with no token behind it is a bug.
- A token added or changed in `index.css` is documented in `design-system.md` in the same diff (`packages/frontend/CLAUDE.md`).

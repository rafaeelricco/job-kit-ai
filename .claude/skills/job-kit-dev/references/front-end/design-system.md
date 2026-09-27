# Design System

## Overview

Flat editorial console: square corners, hairline rules, alpha-composited ink, one neutral action color. Canvas `{colors.canvas}`, content `{colors.surface}`, rail `{colors.sidebar}` — three distinct layers in both themes. Built by following good references — mature developer-console interfaces whose density and restraint this product wants — and the token names are kept verbatim from those references so a future parity check stays a one-to-one lookup.

**Key Characteristics:**

- **Radius is 0.** `{rounded.base}` is `0px` and the whole Tailwind scale (`xs` through `4xl`) is aliased to it. Three deliberate exceptions only: sidebar rows (6px), identifier chips (4px), avatars (pill).
- **Borders replace shadows.** Structure comes from a 1px hairline at 8% ink. Only the floating layer (dropdown, select, popover, floating bar) casts a shadow.
- **Ink is one hue at five opacities**, not a grey ramp: `#171717` at 100/80/65/50/35% in light, mapping to warm off-whites in dark.
- Three families, each with one job: **Inter** for all UI, **Space Mono** for every identifier, **Space Grotesk** for the wordmark alone.
- Neutral near-black is the action color. Semantic hues are muted and earthy; charts use a Tokyo-Night ramp.
- Dark mode is **true black canvas** with lifted `#1d1d1d` content — not a grey wash. Hairlines jump from 8% to 25% opacity to survive the darker ground.
- Density is deliberate: 36px controls, 12px table headers, 53px rows, 14px body.

Tokens live in `packages/frontend/src/index.css` — `@theme inline` maps them to Tailwind utilities, `:root` holds light, `.dark` holds the dark overrides. Theme is a `light`/`dark` class on `<html>` (`packages/frontend/src/components/ui/theme-provider.tsx`). Reviewer-checkable rules are in `packages/frontend/CLAUDE.md` (UI).

`tests/test_design_system.py` pins every color table below to `packages/frontend/src/index.css`. When this file and the CSS disagree, `index.css` wins on a value and this file wins on intent; fix the loser in the same change.

`index.html` next to this file renders the system in light and dark. Serve the repo root (`python3 -m http.server -d <repo>`) and open `/.claude/skills/job-kit-dev/references/front-end/index.html`. Chrome also renders it from `file://`; browsers with a strict file-origin policy (Firefox) may fall back to system fonts there.

## Colors

### Ink (text)

One base hue at five opacities. Use the ink scale for text, never the grey ramp directly.

| Token                 | Light           | Dark      | Use                                          |
| --------------------- | --------------- | --------- | -------------------------------------------- |
| `{colors.ink-strong}` | `#171717`       | `#f8f8f2` | Titles, active nav, emphasis, primary values |
| `{colors.ink-body}`   | `#171717` @ 80% | `#ecece5` | Default body text, table cells               |
| `{colors.ink-soft}`   | `#171717` @ 65% | `#d8d8d0` | Secondary copy, ghost button labels          |
| `{colors.ink-muted}`  | `#171717` @ 50% | `#babab4` | Table headers, helper text, idle nav, labels |
| `{colors.ink-faint}`  | `#171717` @ 35% | `#7c7c77` | Disabled text, chart gridlines, placeholders |

`{colors.foreground}` aliases `ink-body` and is what `<body>` inherits.

### Surface

Three layers, distinct in both themes. The content pane must be lighter than the canvas — collapsing them is the single most visible way to break this system.

| Token                   | Light           | Dark            | Use                                        |
| ----------------------- | --------------- | --------------- | ------------------------------------------ |
| `{colors.canvas}`       | `#fafafa`       | `#000000`       | Page ground, behind everything             |
| `{colors.background}`   | `#fafafa`       | `#000000`       | Alias of canvas; dialog frames             |
| `{colors.surface}`      | `#ffffff`       | `#1d1d1d`       | **Content pane**, lifted one step          |
| `{colors.card}`         | `#ffffff`       | `#1d1d1d`       | Cards, panels — same value, card semantics |
| `{colors.popover}`      | `#ffffff`       | `#1d1d1d`       | Floating menus, dialogs, tooltips content  |
| `{colors.sidebar}`      | `#fafafa`       | `#141414`       | Navigation rail, flush with canvas         |
| `{colors.inset}`        | `#fafafa`       | `#141414`       | Recessed wells, identifier chip background |
| `{colors.muted}`        | `#f3f3ed`       | `#1d1d1d`       | Quiet fills, progress tracks               |
| `{colors.accent}`       | `#fafafa`       | `#141414`       | Active row fill in nav and settings rail   |
| `{colors.surface-soft}` | `#ecece5` @ 33% | `#ffffff` @ 16% | Softened panel over a busy ground          |

### Hairlines & Borders

The 1px rule carries all structure. Dark mode needs ~3× the opacity to read at the same weight.

| Token                       | Light           | Dark            | Use                                             |
| --------------------------- | --------------- | --------------- | ----------------------------------------------- |
| `{colors.divider-subtle}`   | `#171717` @ 5%  | `#ffffff` @ 15% | Nested rows where the default is loud           |
| `{colors.divider}`          | `#171717` @ 8%  | `#ffffff` @ 25% | **The system rule.** Cards, tables, panels      |
| `{colors.border}`           | `#171717` @ 8%  | `#ffffff` @ 25% | Alias of divider; global `*` border             |
| `{colors.divider-emphasis}` | `#171717` @ 33% | `#ffffff` @ 50% | Stronger separation, segmented groups           |
| `{colors.input}`            | `#171717` @ 33% | `#ffffff` @ 50% | Form controls — deliberately darker than panels |
| `{colors.ring}`             | `#171717`       | `#f8f8f2`       | Focus ring, 3px at 20% alpha                    |

Input borders are 33%, not 8%: a field must read as editable against a panel drawn with the same hairline.

### Action

Neutral near-black is the action color. **There is no brand hue** in the UI — `#7da75b` appears in the identity artwork only, never as an action or semantic color.

| Token                           | Light                 | Dark                  | Use                        |
| ------------------------------- | --------------------- | --------------------- | -------------------------- |
| `{colors.primary}`              | `#171717`             | `#f8f8f2`             | Primary button fill, focus |
| `{colors.primary-foreground}`   | `#ffffff`             | `#171717`             | Text on primary            |
| `{colors.primary-hover}`        | `#171717` + 15% white | `#f8f8f2` + 15% black | Primary hover              |
| `{colors.secondary}`            | `#e9e9e4`             | `#ffffff` @ 20%       | Secondary fill             |
| `{colors.secondary-foreground}` | `#171717`             | `#f8f8f2`             | Text on secondary          |
| `{colors.destructive}`          | `#c95c5c`             | `#c95c5c`             | Destructive action, error  |
| `{colors.link}`                 | `#2563eb`             | `#60a5fa`             | Inline text links          |

### Semantic

Muted and earthy — never saturated. Each has a 10% `-surface` tint and a 33% `-outline`, identical in both themes.

| Token              | Hex       | Surface (10%)                | Outline (33%)   | Use                         |
| ------------------ | --------- | ---------------------------- | --------------- | --------------------------- |
| `{colors.success}` | `#7da75b` | `#9ece6a` @ 10%              | `#9ece6a` @ 33% | Positive, held, applied     |
| `{colors.danger}`  | `#c95c5c` | `#f7768e` @ 10%              | `#f7768e` @ 33% | Error, dead, blocker        |
| `{colors.warning}` | `#e4c64c` | `#e3a241` 10% over `#f9f7dd` | `#e3a241` @ 33% | Attention, stale            |
| `{colors.info}`    | `#7aa2f7` | `#7aa2f7` @ 10%              | `#7aa2f7` @ 33% | Informational, neutral note |

### Charts

Tokyo-Night ramp. Five hues, identical in both themes, assigned by series index — never by meaning.

| Token              | Hex       |
| ------------------ | --------- |
| `{colors.chart-1}` | `#7aa2f7` |
| `{colors.chart-2}` | `#9ece6a` |
| `{colors.chart-3}` | `#bb9af7` |
| `{colors.chart-4}` | `#e3a241` |
| `{colors.chart-5}` | `#f7768e` |

`packages/frontend/src/components/ui/chart.tsx` carries no palette of its own; callers pass colors through `ChartConfig`, which emits them as `--color-<key>`.

### Primitive Palette

Raw ramps behind the semantic tokens. **Do not reference these in components** — reach for a semantic token, and add one if none fits.

`--white-100/200/300/400` · `--black-700/800/900` · `--grey-300/400/500/600/700` · `--blue-100/300/500/700` · `--green-100/300/500/700/900` · `--red-300/500/700` · `--yellow-300/500/700` · `--orange-300/500/700` · `--purple-300/500/700` · `--pink-300/500/700` · `--cyan-300/500/700` · `--vivid-blue/green/purple/amber/rose`

### Overlays

| Token                           | Light          | Dark            | Use                 |
| ------------------------------- | -------------- | --------------- | ------------------- |
| `{colors.hover-overlay}`        | `#171717` @ 4% | `#ffffff` @ 8%  | Row hover           |
| `{colors.hover-overlay-strong}` | `#171717` @ 8% | `#ffffff` @ 12% | Pressed, active row |

Modal scrim is `ink-strong` at 20% with a `backdrop-blur-xs`.

## Typography

### Font Family

Three families, each with exactly one job. Hierarchy comes from size and weight, never from swapping family.

| Token               | Stack                                                    | Use                                                         |
| ------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| `{typography.sans}` | `"Inter Variable", ui-sans-serif, system-ui, sans-serif` | All UI text, headings, body, controls                       |
| `{typography.mono}` | `"Space Mono", ui-monospace, SFMono-Regular, monospace`  | **Every identifier** — IDs, paths, URLs, dates, enums, code |
| `{typography.logo}` | `"Space Grotesk Variable", ui-sans-serif, system-ui`     | Wordmark only — one site in the app                         |

`--font-heading`, `--font-display` and `--font-view-title` all alias `--font-sans`. They exist as seams, not as distinct faces.

**The monospace rule is the signature move.** Any machine-readable value — a search-pack id, a file path, an ISO date, a URL, a lifecycle enum, a hash — renders in Space Mono at 12px (11px where table density demands it). Prose never does. `font-logo` appears at exactly one site, the wordmark.

### Hierarchy

| Token                        | Size | Weight | Use                                                  |
| ---------------------------- | ---: | -----: | ---------------------------------------------------- |
| `{typography.title-lg}`      | 24px |    600 | Page titles, large metrics (`text-2xl`)              |
| `{typography.title-md}`      | 20px |    600 | Section titles (`text-xl`)                           |
| `{typography.title-sm}`      | 16px |    600 | Dialog titles, card titles (`text-base`)             |
| `{typography.body}`          | 16px |    400 | Reading copy (`text-base`)                           |
| `{typography.body-sm}`       | 14px |    400 | **Default UI text**, table cells, inputs (`text-sm`) |
| `{typography.label}`         | 14px |    500 | Button labels, active nav, form labels               |
| `{typography.caption}`       | 12px |    500 | Table headers, badges, helper text (`text-xs`)       |
| `{typography.identifier}`    | 12px |    400 | Monospace IDs, paths, dates (`font-mono text-xs`)    |
| `{typography.identifier-sm}` | 11px |    400 | Dense monospace in tables (`text-[11px]`)            |
| `{typography.overline}`      | 12px |    500 | Uppercase section labels, `tracking-[0.6px]`         |

The practical scale is narrow: **14px and 12px carry the product**, with 16px for reading copy and dialog titles, and 20/24px reserved for page orientation. Global tracking is `-0.011em` on `<body>`. Weight is binary in practice — 400 for content, 500 for labels and emphasis; 600 appears only on the few large titles. Tabular nums for counts, money, durations and scores.

## Layout

### Spacing System

- **Base unit:** 4px (`--spacing`).
- **Core rhythm:** 8px, 12px, 16px, 24px, 32px.
- **Page padding:** 24px.
- **Card padding:** 16px, from `[--card-spacing:--spacing(4)]` set inline on the card; 12px at `data-size=sm`.
- **Table cell padding:** 8px vertical, 12px horizontal.
- **Rail padding:** 12px.

| Token           | Value | Use                                        |
| --------------- | ----: | ------------------------------------------ |
| `{spacing.xxs}` |   4px | Icon/label micro gaps                      |
| `{spacing.xs}`  |   8px | Control gaps, dense rows, nav item padding |
| `{spacing.sm}`  |  12px | Table cells, rail padding, control padding |
| `{spacing.md}`  |  16px | Card padding, standard internal rhythm     |
| `{spacing.lg}`  |  24px | Page padding, section separation           |
| `{spacing.xl}`  |  32px | Dialog panel padding, large separation     |

Prefer parent-owned `gap` over child margins.

### Shell

| Region        | Size            | Surface            | Notes                                      |
| ------------- | --------------- | ------------------ | ------------------------------------------ |
| Sidebar rail  | 256px (`16rem`) | `{colors.sidebar}` | 48px collapsed; 16rem as a mobile sheet    |
| Content pane  | fluid           | `{colors.surface}` | 1px left divider; **must** be `bg-surface` |
| Settings rail | 192px           | transparent        | Inside the dialog, 1px right divider       |

Sidebar width is set as `--sidebar-width` on `SidebarProvider` (`packages/frontend/src/components/ui/app-layout.tsx`) and again as `SIDEBAR_WIDTH` / `SIDEBAR_WIDTH_MOBILE` in `packages/frontend/src/components/ui/sidebar.tsx`. All three are `16rem` and must stay in agreement.

## Elevation & Depth

| Level        | Treatment                                                      | Use                                                 |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------- |
| Flat         | No shadow, no border                                           | Canvas, transparent rows, text-only sections        |
| Hairline     | 1px `{colors.divider}`                                         | **Default.** Cards, tables, panels, inputs, dialogs |
| Surface step | `{colors.surface}` on `{colors.canvas}`                        | Content pane — contrast, not elevation              |
| Floating     | `0 4px 6px -1px rgb(0 0 0 / 0.1)` (`shadow-md`) + 1px hairline | Dropdown, select, popover, floating action bar      |

Dialogs and sheets are **flat**: no shadow, no ring — they separate by sitting on a dimmed scrim. The floating layer is the only shadow in the system. No gradients, glow, glass, or decorative blur; the modal scrim's `backdrop-blur-xs` is the sole exception.

## Shapes

### Border Radius Scale

`--radius` is `0px` and every named step aliases it, so `rounded-sm` through `rounded-4xl` all render square. Removing a `rounded-*` class is preferred over setting it to a smaller step.

| Token            |  Value | Use                                                                                |
| ---------------- | -----: | ---------------------------------------------------------------------------------- |
| `{rounded.base}` |    0px | **Everything by default** — buttons, inputs, cards, dialogs, tables, badges, menus |
| `{rounded.chip}` |    4px | Inline identifier chips (`<code>`) only                                            |
| `{rounded.nav}`  |    6px | Sidebar rows and account button only                                               |
| `{rounded.full}` | 9999px | Avatars, switch tracks, status dots, small clear buttons                           |

`rounded-full` is **not** derived from `--radius` and survives independently — that is why avatars and switches stay round. It belongs only on avatars, switch tracks, status and legend dots, the scroll-area thumb, and the filter-bar clear button. There are no other radii; an in-between value is a bug.

### Geometry

- Wordmark renders in Space Grotesk, uppercase, `tracking-wide` — the sole `font-logo` site.
- Icons are 16px in controls and nav, 20px in page titles, stroke width 2.
- Logo assets are vector, in `packages/frontend/public/brand/`; `mascot-mark.svg` is the sidebar mark
  and `mascot-mark-dark.svg` its dark-theme twin. Ink `#1d1d1d` is 1.00:1 on the
  dark card, so every ink-on-dark asset needs its variant. The mascot is illegible
  below 32px — use the head-only crop, never the full lockup, in small slots.
  Rasters under `packages/frontend/public/` are generated by `scripts/brand/render.py`; edit the SVG,
  never the PNG. `icon-512-maskable.png` is the one plated, inset raster: maskable
  launchers crop to a 40%-radius circle, and the edge-to-edge mark loses its mouth.

## Components

### Navigation

Sidebar rows are the one rounded element. Active state is a fill plus solid ink — no weight bump, no indicator bar.

| State  | Background                         | Text                  | Weight |
| ------ | ---------------------------------- | --------------------- | ------ |
| Active | `{colors.sidebar-accent}` (8% ink) | `{colors.ink-strong}` | 400    |
| Idle   | transparent                        | `{colors.ink-body}`   | 400    |
| Hover  | `{colors.hover-overlay}`           | `{colors.ink-strong}` | 400    |

Rows are 240×32px, 8px padding, 8px gap, 6px radius, 14px label.

### Buttons

Default height is **36px** — the system's control height, shared with inputs and selects.

**`button-default`** — `{colors.primary}` fill, `{colors.primary-foreground}` text, square, `h-9`, `px-4`, 14px/500. The primary action.

**`button-outline`** — transparent fill, 1px `{colors.border}`, `{colors.ink-soft}` text. Same metrics.

**`button-secondary`** — `{colors.secondary}` fill, `{colors.secondary-foreground}` text.

**`button-ghost`** — transparent, no border. Table actions, toolbar icons, quiet dismissal, Reset beside Save.

**`button-destructive`** — `{colors.destructive}` at 10% fill with `{colors.destructive}` text. A soft tint, not a solid red block.

**`button-link`** — text-only `{colors.primary}`, underline on hover.

Sizes: `xs` 24px · `sm` 28px · `default`/`lg` 36px · `icon` 32px square · `icon-lg` 36px square.

### Cards & Containers

**`card`** — `{colors.card}` surface, square, 1px `{colors.divider}` ring, no shadow, 16px padding. Footers take a `border-t` and a `{colors.muted}` fill.

**`dialog`** — `{colors.popover}` (or `{colors.background}` for full-shell dialogs), square, **no shadow, no ring**, on a 20% scrim with `backdrop-blur-xs`. The settings dialog is 896×720 with a 192px rail.

**`dropdown` / `select` / `popover`** — `{colors.popover}`, square, 1px `{colors.divider}`, `shadow-md`, 4px padding. The only shadowed surfaces.

**`sheet`** — flat side drawer, no shadow, 1px edge divider.

### Tables

Density is the point: a scannable header over tall, readable rows.

| Part        | Height | Padding    | Size | Weight | Ink                  |
| ----------- | -----: | ---------- | ---: | -----: | -------------------- |
| Header cell |   36px | `0 12px`   | 12px |    500 | `{colors.ink-muted}` |
| Body cell   |   53px | `8px 12px` | 14px |    400 | `{colors.ink-body}`  |

Header has **no background fill** — it separates by the bottom hairline alone. Rows carry a 1px bottom divider; hover is `{colors.muted}` at 50%. The frame is a 1px border with no radius.

### Inputs & Forms

**`input`** — `{colors.input-surface}` fill, 1px `{colors.input}` (33% — darker than panel hairlines), square, `h-9`, `px-3`, 14px. Focus swaps the border to a solid `{colors.ring}` and adds a 3px ring at 50%.

**`textarea`** — same treatment, height driven by `rows`.

**`label`** — 14px/500 above the control. Helper text is 12px `{colors.ink-muted}` below it.

**`checkbox`** — 16px square, square corners, 1px `{colors.input}`.

**`switch`** — pill track, one of the three intentional round elements.

**Form actions** — a `{colors.primary}` Save beside a ghost Reset, both disabled until the form is dirty.

Validation uses `{colors.destructive}` text and border via `aria-invalid`. Do not invent a second error palette.

### Badges & Status

Badges are **square**, 20px tall, `2px 8px`, 12px/500. A tinted `-surface` background with solid semantic text.

| Variant       | Background                   | Text                            | Use                   |
| ------------- | ---------------------------- | ------------------------------- | --------------------- |
| `default`     | `{colors.primary}`           | `{colors.primary-foreground}`   | High-emphasis status  |
| `secondary`   | `{colors.secondary}`         | `{colors.secondary-foreground}` | Neutral status, enums |
| `outline`     | transparent + 1px border     | `{colors.foreground}`           | Low-emphasis label    |
| `destructive` | `{colors.destructive}` @ 10% | `{colors.destructive}`          | Dead, blocked, error  |

Status text renders the raw enum (`applied`, `restricted-geo`) — no title-casing. This is a deliberate divergence from the reference, whose status chip is a pill.

### Identifiers

The system's most distinctive treatment. Any machine-readable value gets Space Mono at 11px in `{colors.ink-soft}`:

- Search-pack and source ids · file paths (`data/basics.yaml`) · ISO dates · URLs · user/org ids · lifecycle and bucket enums · skill tokens

Inline `<code>` additionally takes a chip: `{colors.inset}` fill, `2px 6px`, 4px radius — the only 4px in the system. Styled globally in `packages/frontend/src/index.css`, so `<code>` needs no classes.

### Motion

| Property | Value                                  | Use                              |
| -------- | -------------------------------------- | -------------------------------- |
| Overlay  | `duration-100`                         | Dialog, dropdown, popover, sheet |
| State    | `duration-150`                         | Color and state transitions      |
| Layout   | `duration-200`                         | Sidebar collapse, width changes  |
| Easing   | Tailwind default (`ease-out` on enter) | Everything                       |

Fast and flat. There are no custom duration or easing tokens — motion uses Tailwind's scale directly, and `transition-colors` is the common case. No bounce, no spring, no attention-seeking movement.

## Responsive Behavior

### Breakpoints

Tailwind defaults: `sm` 640px · `md` 768px · `lg` 1024px · `xl` 1280px · `2xl` 1536px.

| Name    |       Width | Key Changes                                              |
| ------- | ----------: | -------------------------------------------------------- |
| Mobile  |     < 768px | Sidebar becomes a sheet; a 48px header holds its trigger |
| Tablet  |  768-1024px | Sidebar docks; card grids go two-column                  |
| Desktop | 1024-1440px | Full tables, three-column grids, dialogs at size         |
| Wide    |    > 1440px | Content caps; gutters absorb the extra width             |

### Collapsing Strategy

- The sidebar collapses to a 48px icon rail before becoming a sheet.
- Reduce grid columns before shrinking content past readability.
- Dialogs cap at `calc(100dvh - 4rem)` and scroll internally; the rail stays fixed while the panel scrolls.
- Dense tables scroll horizontally rather than dropping columns.

---

**Adding to this system:** reach for an existing semantic token first; add a new one only when none fits, and define it in both themes. Never reference a primitive ramp from a component. Never add a radius that is not 0, 4px, 6px, or full. Never add a shadow outside the floating layer. When in doubt, go back to the reference interface — measure it rather than guessing.

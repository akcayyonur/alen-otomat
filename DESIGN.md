---
name: CNC Telemetri Platformu
description: Real-time CNC fleet telemetry and shop-floor production planning for a brass-fittings machine shop
colors:
  paper: "#F6F6FB"
  surface: "#FFFFFF"
  surface-2: "#F0F0F8"
  ink: "#1B1B29"
  ink-soft: "#5B5B72"
  ink-faint: "#9292A6"
  line: "#E7E7F1"
  line-strong: "#D3D3E6"
  accent: "#6C53E8"
  accent-soft: "#EFEBFD"
  series: "#6C53E8"
  st-run: "#0ca30c"
  st-idle: "#fab219"
  st-alarm: "#d03b3b"
  st-off: "#8A949B"
  st-nodata: "#8A949B"
  st-none: "#B9C2C5"
typography:
  title:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif"
    fontSize: "1.3rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.3
  body:
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'IBM Plex Sans Condensed', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.1em"
  mono:
    fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  sm: "10px"
  md: "14px"
  lg: "16px"
  xl: "20px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
    rounded: "{rounded.sm}"
    padding: "5px 11px"
  button-primary-hover:
    backgroundColor: "{colors.accent}"
    textColor: "#FFFFFF"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "5px 11px"
  button-secondary-hover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.accent}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "13px 14px 11px"
  chip:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
---

# Design System: CNC Telemetri Platformu

## Overview

**Creative North Star: "Modern Web Uygulaması" — the category's own best practice, done with care**

This reads as a contemporary, confident SaaS dashboard: soft-cornered cards floating on layered shadow, one vivid indigo-violet accent, generous breathing room, a geometric humanist sans carrying nearly everything. It replaced an earlier "near-monochrome instrument panel" register deliberately — the factory floor and office both found that register too austere for 2026 — but kept every operational fact the old system encoded: the same two usage modes (office desk + shop-floor touchscreen), the same fixed five-state status palette, the same paper-replica printed forms, the same zero-dependency, no-build-step, vanilla JS/CSS architecture.

The redesign is a shell change, not a product change. Navigation, information architecture, the KPI-strip-then-grid-then-table reading order, the operator's large touch targets, and above all the status-color invariants are untouched. What changed is how current and trustworthy the surface feels at a glance: rounder, softer, warmer-feeling in both themes, with one confident accent instead of a restrained desaturated blue.

**Key Characteristics:**
- Off-white/lavender paper ground with white cards on soft layered shadow (not flat hairlines) — cards read as objects floating above the page, not panels flush with it
- One vivid accent, Signal Violet (`#6C53E8` light / `#A892FF` dark), used generously on interactive and selected elements — more present than the old system's "sparingly" rule, but still the only hue besides status
- A fixed five-state status palette (run/idle/alarm/off/no-data) that never changes with theme, never relies on color alone, and did NOT change in this redesign — it is a product invariant, not a style choice
- Status and category chips are soft filled pills with no border — color and a label carry the state, not an outline
- A confident geometric sans (Plus Jakarta Sans) for nearly everything; a condensed utility face survives for dense table-header labels only; a contemporary mono (JetBrains Mono) for codes, IDs, and tabular figures
- A wider radius scale (9/13/17px, up from 6/9/11px) and richer, more visible shadows than the old single flat ambient shadow
- Full, parallel light/dark themes via CSS custom properties — unchanged mechanism, new palette
- Printed/paper-replica surfaces that deliberately opt out of the app's theme entirely (always white/black, Arial) — untouched by this redesign, exactly as before
- Shop-floor (operator) surfaces that enlarge targets and reduce steps without becoming a different design system — untouched

## Colors

An off-white/lavender neutral scale carries structure; one vivid indigo-violet accent marks interactivity, selection, and the series color for single-line charts; a fixed five-color status set is the only other place meaning is color-coded, and it is always paired with an icon or label.

### Primary
- **Signal Violet** (`accent`, `#6C53E8` light / `#A892FF` dark): the one accent. Marks active navigation, focus rings, links, selected rows/tabs/checkboxes, primary buttons, and single-series chart lines. More visible than the old Harbor Blue — this direction's whole point is a surface that reads as current and considered, not merely restrained.

### Neutral
- **Paper** (`paper`, `#F6F6FB` light / `#15131F` dark): page background, lavender-tinted rather than true gray, one step away from every card.
- **Surface** (`surface`, `#FFFFFF` light / `#1E1C2B` dark): card, panel, table-header, and modal background — the primary content plane.
- **Surface 2** (`surface-2`, `#F0F0F8` light / `#252233` dark): secondary surface — hover rows, nested panels, disabled-ish fills, the "sunken" layer inside a surface.
- **Ink** (`ink`, `#1B1B29` light / `#ECEAF6` dark): primary text.
- **Ink Soft** (`ink-soft`, `#5B5B72` light / `#B3AFC9` dark): secondary text, field labels, table sub-text.
- **Ink Faint** (`ink-faint`, `#9292A6` light / `#79748F` dark): tertiary text, timestamps, and — doing double duty — the color for a deliberately **unknown/null** value, so "we don't know" never looks like "zero."
- **Line** (`line`, `#E7E7F1` light / `#312D43` dark): default hairline border, table row dividers.
- **Line Strong** (`line-strong`, `#D3D3E6` light / `#423C58` dark): input borders, segmented-control borders, anything that needs to read as a control edge rather than a divider.
- **Accent Soft** (`accent-soft`, `#EFEBFD` light / `#2A2444` dark): wash background for the active nav item, active tab, selected table row, and info-level notices.

### Status (fixed — does not change with theme, and did not change in this redesign)
- **Run / Good** (`st-run`, `#0ca30c`): machine running, a check passed, fişi girildi.
- **Idle / Caution** (`st-idle`, `#fab219`): machine idle, a pending/attention state, "over target" warnings.
- **Alarm / Critical** (`st-alarm`, `#d03b3b`): machine alarm, a blocking validation failure, destructive actions (`btn-danger`).
- **Off** (`st-off`, `#8A949B`): machine powered off.
- **No Data** (`st-nodata`, `#8A949B` — same base as Off): telemetry gap. Never shares Off's solid fill: always rendered with a diagonal hatch pattern so the two are distinguishable without reading the label.
- **None / Unknown** (`st-none`, `#B9C2C5`): no status has been established yet (e.g. a machine never seen).

### Named Rules
**The Color-Plus Rule.** No status, state, or result is ever conveyed by color alone. Every status dot, chip, or badge carries an icon or text label in the same breath; color is the accelerant, never the message.

**The No-Zero-Lie Rule.** A value the system genuinely does not know renders in Ink Faint with an em-dash, never as `0`. Zero is a real, confirmed measurement; "no data" is a different fact and must look different.

**The Hatch-Not-Hue Rule.** "No data" and "Off" share a base gray because they're both "nothing is reporting" to a glance — but No Data always gets a diagonal stripe pattern, because conflating "the machine is off" with "we lost the signal" produces wrong downtime reports.

**The Status-Is-Frozen Rule.** The five status hex values are a product invariant carried across every visual redesign, this one included. A future direction change may restyle the chip that wears them (shape, fill, border) but never the six hex values themselves.

## Typography

**Body/Display Font:** Plus Jakarta Sans (with system-ui, -apple-system fallback)
**Label/Condensed Font:** IBM Plex Sans Condensed (with system-ui fallback) — kept from the prior system as a pure utility face
**Mono Font:** JetBrains Mono (with SFMono-Regular, Consolas fallback)

**Character:** A warm geometric humanist sans carries titles, headings, and body alike — rounder and friendlier than the prior engineered grotesk, while staying disciplined enough for dense data screens. The condensed face survives only where real estate is tight (table-column headers, KPI eyebrows); it is a density tool, not a personality choice, which is why it did not change with the rest of the system. The mono face is load-bearing: anywhere a number must be compared down a column or an identifier must be unambiguous, it switches to mono.

### Hierarchy
- **Title** (700, 1.3rem, 1.2 line-height, −0.01em tracking): page/detail-view headings (`.dt-head h2`). One per screen.
- **Heading** (650, 1rem, 1.3 line-height): card and block headings (`.card-top h3`, `.dt-block h3`). The workhorse section label.
- **Body** (400, 15px, 1.55 line-height): running text, field values, table text at default size.
- **Label** (600, uppercase, IBM Plex Sans Condensed): the "eyebrow" treatment — KPI labels, field labels, table column headers, sidebar section labels. Size and tracking flex slightly by context (10.5–11.5px, 0.06–0.11em letter-spacing) rather than one fixed pair; always uppercase, always this weight, never used for anything a user needs to read quickly (it trades legibility for density on purpose).
- **Mono** (400, 12.5px): machine IDs, program codes, stock/hammadde codes, document numbers, timestamps, and any numeric series that benefits from fixed-width digits.

### Named Rules
**The Tabular-Numerals Rule.** Any number that appears in a column, a KPI tile, or a running counter sets `font-variant-numeric: tabular-nums`, so digits never shift the layout as they update live.

**The One Title Rule.** `Title` size appears once per screen (the detail header). Everything else that looks like a heading is `Heading` or `Label` — the hierarchy stays flat on purpose because these are data screens, not editorial pages.

## Layout

Unchanged from the prior system. Single-column app shell (`.app`, max-width 1560px, centered) with a two-column grid below the top bar on wide viewports: a sticky 252px machine-selector sidebar plus a fluid content column (`.layout`, `grid-template-columns: 252px minmax(0,1fr)`), collapsing to one column under 900px. The sidebar is capped to the viewport height and scrolls independently so a long machine list never pushes the page to scroll.

Content is built from a shallow, repeatable grammar: KPI strips (`auto-fit` grid, 150–282px minimum tile width depending on context), card grids (`auto-fill`, ~280–310px minimum), and stacked "blocks" (`.dt-block`, `.pl-prog`, `.fg`) — bordered, radius-17 surfaces that hold one coherent chunk of data each, laid out in a simple vertical flow (`.detail`, `gap:14px`) rather than a dense dashboard collage. Tables live inside a scroll-contained wrapper (`.table-wrap`) with a sticky header row, so long lists never carry the page header out of view.

Density is high by design (13–15px type, 8–16px gaps, minimal whitespace padding) everywhere **except** the operator (Tezgah başı) surfaces, which widen targets (`min-height:44px` repeatedly) and simplify step counts for touch use without changing the grid logic underneath. Responsive behavior is a small number of hard breakpoints (640px, 760px, 900px) that simplify grids to one or two columns and widen modals to near-full-width, not a fluid fully-responsive system.

## Elevation & Depth

This redesign's clearest departure from the prior system: cards now read as objects floating above the page, not panels flush with it. One shared `--shadow` token is still applied uniformly to every resting card, block, sidebar, and KPI tile alike, but it is now a richer, two-layer shadow (`0 1px 2px rgba(27,27,41,.05), 0 10px 24px -12px rgba(27,27,41,.16)` light / a darker equivalent in dark mode) rather than the old barely-there hairline-adjacent shadow. Modals and the auth card use a separate, stronger `--shadow-modal` token (`0 20px 56px rgba(27,27,41,.22)` light), marking them as a genuinely separate plane above the page.

### Shadow Vocabulary
- **Ambient (`--shadow`)**: the only resting-state shadow in the system. Applied identically to cards, blocks, KPI tiles, the sidebar, and tooltips. Visibly present now, not merely implied.
- **Modal (`--shadow-modal`)**: reserved for `dialog.modal` and the auth card. Signals "this is above the page," not "this is important" — don't reach for it to make an in-page element feel elevated.

### Named Rules
**The One Shadow Rule.** Resting surfaces still share a single shadow value, now richer than before. If something needs to look more important, give it a border-color change or an accent border before reaching for the modal shadow — that one is reserved exclusively for true overlays.

## Shapes

Radii widen across the whole system relative to the prior one, in roughly three bands measured straight from the stylesheet: ~10px for small interactive controls (buttons, standard inputs, table-edit fields, tooltips), 12px for a few touch-leaning controls (sidebar nav items, the segmented control, operator-surface inputs like `.ms-in`/`.pack-qty`); 14px is the single most common container radius (KPI tiles, notices, driver cards) with 16px for the larger panels (fleet cards, detail blocks, the sidebar, shop cards); and a distinct 18–20px step reserved for elevated overlays and feature tiles (`dialog.modal`, the auth card, app-selection tiles) that sits outside the 14/16px container band. A full pill (999px) covers status chips, badges, and the segmented-control's active state. The `--radius-sm/md/lg/pill` custom properties declared in `:root` (10/14/16/999, approximately) describe this scale in the abstract, but no rule in the stylesheet currently consumes them via `var()` — every component hardcodes its own literal px value, so the band grouping above is an observed pattern, not an enforced one. Borders are 1px hairlines (`line`) by default, stepping up to `line-strong` for anything that needs to read as an editable control boundary rather than a passive divider; a left or top 3–4px accent-colored border is still the system's way of tagging a card or KPI tile with its status without touching its fill. Printed/paper surfaces (forms, cards, packing sheets) deliberately break this language exactly as before: sharp corners, heavier 1–2px black rules, because they reproduce a physical paper document — this redesign did not touch them.

## Components

### Buttons
- **Shape:** 10px radius, consistent across all variants and sizes (`.icon-btn`) — up from 6px. Hardcoded per-rule, not drawn from the `--radius-sm` custom property (see Shapes).
- **Default (`icon-btn`):** bordered, surface-colored, `line-strong` border; hover shifts border and text to accent — a quiet, secondary-feeling default.
- **Primary (`btn-primary`):** solid accent fill, white text; hover brightens rather than darkens.
- **Danger (`btn-danger`):** solid `st-alarm` fill, white text — reserved for irreversible actions (library delete, tornadan silme).
- **Small (`icon-btn-sm`):** same shape, tighter padding (2px 8px) and 11.5px type, used inline in table rows.
- **Shop/touch (`shop-btn`):** same visual language, 44px minimum height and larger type — the only variant that changes dimensions for a different input mode, not a different look.
- **Disabled:** 0.5 opacity, `not-allowed` cursor, no other treatment.

### Chips & Badges
- **Style:** pill-radius (999px), **no border** (changed in this redesign — was a 1px colored border), soft tinted fill, small bold label, optional leading icon glyph. `chip` and `badge` remain near-duplicate implementations of the same idea and should be treated as one component going forward.
- **State:** `ok` (green), `warn`/`idle` (amber), `bad`/`alarm` (red), `info` (accent), `none` (neutral/ink-faint, no color fill) — always icon or label alongside the color per the Color-Plus Rule.

### Cards / Containers
- **Corner Style:** 16px (`.card`, `.dt-block`, `.dt-head`, `.fg`, the sidebar, shop cards) — up from 11px, the single most visible shape change in this redesign. Small panels (KPI tiles, notices, driver cards) sit one step down at 14px.
- **Background:** `surface`, with a `surface-2` used for a nested/sunken sub-panel inside a card.
- **Shadow Strategy:** the single ambient shadow (see Elevation) — now visibly present, not barely-there.
- **Border:** 1px `line`; status-bearing cards (fleet cards, KPI tiles, shop cards) add a 3–4px accent-colored border on one edge (top for cards, left for KPI tiles) instead of changing the fill.
- **Internal Padding:** roughly 12–14px horizontal, 11–16px vertical; tighter (7–10px) for small KPI tiles. Unchanged from the prior system — only the corner radius and shadow moved.

### Inputs / Fields
- **Style:** 10px radius, `line-strong` border, `surface` background, 13px type; label sits above in the `Label` style via the `.fld` wrapper.
- **Focus:** border shifts to `accent` (`:focus-visible`); no glow/ring beyond the 2px `outline` the system uses globally for keyboard focus.
- **Touch variant:** operator-surface inputs (`.ms-in`, `.pack-qty`) grow to 44px min-height and 15–16px type, same border/radius language.

### Tables
- **Style:** flat, hairline row dividers (`line`), sticky `Label`-style header (uppercase, ink-faint, surface background), numeric columns right-aligned with tabular numerals, row hover tints `surface-2`, selected row tints `accent-soft`. Unchanged by this redesign apart from inheriting the new palette.
- **Variants:** an inline-editable mode (`tbl-edit`) swaps static cells for bordered inputs/selects with the same field styling; a few domain tables (`tbl-prod`, `heat-tbl`) add sticky left columns, grouped sub-header rows, or a per-cell intensity wash (`heat`, using `color-mix` against the accent) for heatmap-style reading.

### Navigation (Sidebar)
- **Style:** flat list items (`.mi`) with rounded hover/active states; the active item gets an `accent-soft` fill and `accent` border rather than a bold weight change. A machine-status dot (with the no-data hatch pattern) sits to the left of each entry. Condensed-label section headers break the list into groups.

### Printed Forms (signature component — untouched by this redesign)
A dedicated, theme-independent visual register for every document this system prints (iş emri formu, ürün tanıtım kartı, paketleme formu, ölçü föyü, GKK/ilk-onay listeleri): always white background, black (`#111`) ink and rule lines, Arial — because these are faithful digital reproductions of real paper forms the shop fills out by hand, not screens, and must look right next to the paper original regardless of which theme the viewer has chosen, or which visual redesign the app itself has gone through. Field labels are small, bold, uppercase gray-black; values are large and bold so they read from a short distance off a printed card taped to a crate. This register has now survived two visual directions unchanged — it is Shapes' one deliberate, permanent exception, not a bug.

## Do's and Don'ts

### Do:
- **Do** pair every status color with an icon and a label — color never carries meaning alone (Color-Plus Rule).
- **Do** render a genuinely unknown value as an Ink Faint em-dash, never `0` (No-Zero-Lie Rule).
- **Do** use `font-variant-numeric: tabular-nums` on any number that updates live or sits in a column.
- **Do** keep the printed-form components (`.pl-form`, `.pl-card`, `.pl-pk`, `.pl-ms`, `.pl-lf`) locked to white/black/Arial regardless of the active theme or visual direction.
- **Do** grow touch targets to 44px minimum on operator/Tezgah başı surfaces without changing their color, radius, or type family.
- **Do** reach for the 3–4px accent-colored edge border when a card or tile needs to carry a status; don't reach for a second shadow or a filled background instead.
- **Do** write every user-facing string in Turkish; code identifiers stay English.

### Don't:
- **Don't** introduce a second accent color. One violet, used generously now rather than sparingly, is still the entire "brand color" vocabulary.
- **Don't** add a new shadow depth beyond the two already defined (`--shadow`, `--shadow-modal`).
- **Don't** give "No Data" a solid fill matching "Off." The diagonal hatch is the only thing distinguishing a lost signal from a powered-down machine.
- **Don't** change the six status hex values for a future visual direction — they are a product invariant, not a style choice (Status-Is-Frozen Rule).
- **Don't** add a border back to `.chip`/`.badge` — the filled-pill-no-border treatment is this direction's deliberate signature, not an oversight.
- **Don't** add a build step, framework, or bundler dependency to ship a visual change. The dashboard is vanilla JS/CSS served as-is; `npm install` must stay unnecessary.
- **Don't** let a non-admin-looking affordance appear for a role that can't use it (operator/viewer). If a button wouldn't do anything for this session's role, it isn't rendered, not just disabled.

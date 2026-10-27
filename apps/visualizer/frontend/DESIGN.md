---
name: Fixer Visualizer
description: A photographer's matte board for tagging, scoring, and posting from a Lightroom Classic catalog.
colors:
  background: "#ffffff"
  background-dark: "#191919"
  surface: "#f6f5f4"
  surface-dark: "#31302e"
  surface-hover: "#f1f0ed"
  surface-hover-dark: "#3d3b38"
  text-primary: "#000000F2"
  text-primary-dark: "#f7f6f5"
  text-secondary: "#4a4642"
  text-secondary-dark: "#b8b7b4"
  text-tertiary: "#847f7a"
  text-tertiary-dark: "#8a8985"
  border: "#0000001F"
  border-dark: "#FFFFFF1F"
  border-strong: "#00000033"
  border-strong-dark: "#FFFFFF40"
  accent: "#0075de"
  accent-dark: "#4A9EFF"
  accent-hover: "#005bab"
  accent-hover-dark: "#7AB8FF"
  accent-light: "#f2f9ff"
  accent-light-dark: "#4A9EFF26"
  success: "#1aae39"
  success-dark: "#3db39a"
  warning: "#dd5b00"
  warning-dark: "#ff8c42"
  error: "#e03e3e"
  error-dark: "#ff6b6b"
typography:
  display:
    fontFamily: "Inter, -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "64px"
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: "-2.125px"
  headline:
    fontFamily: "Inter, -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "48px"
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: "-1.5px"
  title:
    fontFamily: "Inter, -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.23
    letterSpacing: "-0.625px"
  subtitle:
    fontFamily: "Inter, -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.27
    letterSpacing: "-0.25px"
  body:
    fontFamily: "Inter, -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Inter, -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: "-0.224px"
rounded:
  base: "8px"
  card: "12px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.background}"
    rounded: "{rounded.base}"
    padding: "8px 16px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.background}"
    rounded: "{rounded.base}"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.base}"
    padding: "8px 16px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.base}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.base}"
    padding: "8px 16px"
  button-danger:
    backgroundColor: "{colors.error}"
    textColor: "{colors.background}"
    rounded: "{rounded.base}"
    padding: "8px 16px"
  card:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.card}"
    padding: "16px"
  input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.base}"
    padding: "8px 12px"
  badge-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  badge-accent:
    backgroundColor: "{colors.accent-light}"
    textColor: "{colors.accent}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  tab-nav-active:
    backgroundColor: "transparent"
    textColor: "{colors.accent}"
    padding: "8px 16px"
  tab-nav-inactive:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    padding: "8px 16px"
---

# Design System: Fixer Visualizer

## 1. Overview

**Creative North Star: "The Matte Board"**

This surface is the matte board around a printed photograph — warm-paper cream, deliberate restraint, a frame whose only job is to make the print readable. A photographer arrives here from Lightroom Classic, already saturated with their own images, and the tool's job is to recede. The matte does not compete with the print.

That metaphor sets every choice. Color: warm neutrals (cream `#f6f5f4`, paper `#ffffff`, dark-mode-warm `#31302e`) with a single workbench blue accent that earns its rarity by appearing only on interactive elements. Borders: 1px hairlines (12% / 20% opacity) in the same key as the surface. Shadows: four-stop ambient halos that read as paper-on-paper depth, never as UI elevation. Typography: Inter at four standard weights with aggressive negative letter-spacing on display sizes — tight, modern, editorial, but unornamented.

The full dark mode is not a developer-tool dark mode. It inherits the same warm undertones and turns the room down rather than turning it cold. `#31302e` is a warm dark surface, not slate; `#4A9EFF` is the accent's softened night cousin, not a neon.

The system explicitly rejects: dark-first developer-tool aesthetics (Linear / Vercel / Supabase neon-on-charcoal), gradient-hero-metric SaaS landing pages, dense Bloomberg-terminal data grids, cards-everywhere Notion clones, and every tell of "AI tool from 2024-2025" — gradient text, glassmorphism, neon accent on dark, animated mesh backgrounds.

**Key Characteristics:**
- Light-first interface with full dark-mode parity in the same warm key
- One blue accent, used on ≤10% of any screen, exclusively for interaction
- Hairline 1px borders (12% / 20% opacity) instead of card chrome
- Four-stop ambient shadows with sub-0.05 max opacity — felt, not seen
- Inter 400 / 500 / 600 / 700 only, with tight negative tracking on display sizes
- 8px base grid; `rounded.base` 8px / `rounded.card` 12px / pill on chips
- Photos are always the loudest thing on screen; UI is the matte around them

### Named Rules

**The Matte Rule.** The UI is the matte board; the photo is the print. If a UI element has stronger visual presence than the photos it surrounds, the element is wrong. Strip the chrome before adding more accent.

## 2. Colors

The palette is canvas-and-ink with one anchor: warm paper neutrals carry the structure, a single workbench blue carries the action, and three semantic signals stay quiet until a state demands them. Frontmatter token keys mirror the project's CSS variables (`--color-background`, `--color-text-primary`, `--color-accent`, etc.) so the YAML and the runtime stylesheet stay 1:1; descriptive names below are how to talk about the colors.

### Primary

- **Workbench Blue** (`accent` / `accent-dark`: light `#0075de`, dark `#4A9EFF`): The single accent for everything interactive — primary buttons, active tab indicators, focus rings, nav-active state, links. No other accent exists. Hover deepens to `accent-hover` (light `#005bab`, dark `#7AB8FF`). The faint blue surface tint `accent-light` (light `#f2f9ff`, dark `#4A9EFF26`) backs accent badges and pull-quote panels.

### Neutral

- **Paper White** (`background` / `background-dark`: light `#ffffff`, dark `#191919`): Dominant background canvas. Pure white in light mode; warm near-black in dark mode that explicitly avoids `#000`.
- **Paper Cream** (`surface` / `surface-dark`: light `#f6f5f4`, dark `#31302e`): Surface tint for cards' resting state, secondary buttons, badge backgrounds. Hover deepens by one step (`surface-hover`, light `#f1f0ed` / dark `#3d3b38`).
- **Ink Deep** (`text-primary` / `text-primary-dark`: light `rgba(0,0,0,0.95)` / `#000000F2`, dark `#f7f6f5`): Primary body and heading text. Light mode uses 95% black so it stays slightly soft against cream; dark mode uses warm near-white.
- **Ink Mid** (`text-secondary` / `text-secondary-dark`: light `#4a4642`, dark `#b8b7b4`): Secondary text — labels, metadata, captions, inactive nav.
- **Ink Soft** (`text-tertiary` / `text-tertiary-dark`: light `#847f7a`, dark `#8a8985`): Tertiary text — placeholder, disabled, low-emphasis annotations.
- **Hairline** (`border` / `border-dark`: light `rgba(0,0,0,0.12)` / `#0000001F`, dark `rgba(255,255,255,0.12)` / `#FFFFFF1F`): Default 1px border on cards, inputs, tab strip. Always 1px.
- **Hairline Firm** (`border-strong` / `border-strong-dark`: light `rgba(0,0,0,0.20)` / `#00000033`, dark `rgba(255,255,255,0.25)` / `#FFFFFF40`): Hover-promoted border. Used on hoverable cards, focused inputs.

### Semantic Signals

Used sparingly. None earns the foreground unless the state genuinely warrants it.

- **Signal Leaf** (`success` / `success-dark`: light `#1aae39`, dark `#3db39a`): Success badges, completed-job pills.
- **Signal Amber** (`warning` / `warning-dark`: light `#dd5b00`, dark `#ff8c42`): Warning badges, stale or degraded states.
- **Signal Coral** (`error` / `error-dark`: light `#e03e3e`, dark `#ff6b6b`): Error text, destructive button, failure pills.

### Named Rules

**The One Voice Rule.** Workbench Blue (`accent`) is the only chromatic accent in the system. It appears on ≤10% of any screen. There is no second brand color, no purple/pink/teal flourish, no decorative gradient. Adding a second hue is a regression.

**The Paper Rule.** Pure `#000` and pure `#fff` are forbidden in dark mode. Both modes carry warm undertones; the dark surface is `#31302e`, not `#1f2937` Tailwind slate. If an element looks blue-cool in dark mode, the token is wrong.

**The Hairline Rule.** Every divider is 1px. Borders thicker than 1px are reserved for the active tab indicator (3px bottom-border) and primary/danger button outlines (2px, color-matched to background).

## 3. Typography

**Display & Body Font:** Inter (`-apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif` fallback chain). Loaded via Google Fonts CDN at weights 400 / 500 / 600 / 700 only.

**Character:** A single neutral grotesque doing all the work. The personality comes from aggressive negative letter-spacing on display sizes (down to −2.125px on hero) which gives headlines a tight, modern editorial cadence — and from the deliberate absence of secondary type. No serif, no monospace, no display script. Photos carry the visual interest; type stays out of the way.

### Hierarchy

- **Display** (Inter 700, 64px / 1.0 / −2.125px): Hero headline, dashboard / first-paint surface. Once per page maximum.
- **Headline** (Inter 700, 48px / 1.0 / −1.5px): Section openers on long-scroll pages (Insights, Identity, Analytics).
- **Title** (Inter 700, 26px / 1.23 / −0.625px): Subsection breaks within a page.
- **Subtitle** (Inter 700, 22px / 1.27 / −0.25px): Card titles, modal headers.
- **Body** (Inter 400 / 500, 16px / 1.5): Default running text. Use 500 (`body-medium`) when a body line carries metadata or needs slight weight contrast against neighboring 400 prose. Cap line length at 65–75ch.
- **Label** (Inter 500, 14px / 1.43 / −0.224px): Form labels, small metadata rows, tab text, default-size button text.
- **Tiny** (Inter 400, 12px / 1.33 / −0.12px): Pill badges, timestamps, low-emphasis annotations only.

### Named Rules

**The Negative Tracking Rule.** Display, Headline, Title, and Subtitle carry negative letter-spacing in proportion to size — never positive, never zero, never the browser default. Removing the tracking flattens the visual identity.

**The Weight Pair Rule.** Hierarchy is built from weight contrast (400 ↔ 700) and size, not from color shifts. Don't lighten the ink to soften emphasis when a weight drop will do it.

## 4. Elevation

The system is **ambient-layered, not flat**. Cards sit at rest with a four-stop micro-shadow whose total opacity tops out at 0.04 — closer to a paper-on-paper soft halo than a UI elevation. Hover lifts to a five-stop deep shadow that maxes at 0.05 opacity, paired with a divider promoted from `border` to `border-strong`. The transition reads as "the card stepped forward," not "the card popped up."

### Shadow Vocabulary

- **Card (rest)** (`box-shadow: rgba(0,0,0,0.04) 0px 4px 18px, rgba(0,0,0,0.027) 0px 2.025px 7.84688px, rgba(0,0,0,0.02) 0px 0.8px 2.925px, rgba(0,0,0,0.01) 0px 0.175px 1.04062px`): Default for every `Card` component, regardless of hoverability. Always paired with a 1px `border` hairline.
- **Deep (hover / featured)** (`box-shadow: rgba(0,0,0,0.01) 0px 1px 3px, rgba(0,0,0,0.02) 0px 3px 7px, rgba(0,0,0,0.02) 0px 7px 15px, rgba(0,0,0,0.04) 0px 14px 28px, rgba(0,0,0,0.05) 0px 23px 52px`): Hover state on hoverable cards; resting state on modals and featured surfaces.

### Named Rules

**The Sub-0.05 Rule.** No shadow stop in this system has opacity above 0.05. If a shadow needs to be louder to register, the answer is to promote the border, not deepen the shadow.

**The Always-Bordered Rule.** Cards carry both a hairline border AND a soft shadow. Borderless cards drift; shadowless cards flatten. The pair is the elevation grammar.

## 5. Components

### Buttons

- **Shape:** `rounded.base` (8px). Never pill on default buttons (pill is reserved for badges and chips).
- **Sizes:** `sm` (px-3 py-1.5, text-sm), `md` (px-4 py-2, text-base, default), `lg` (px-6 py-3, text-lg).
- **Primary:** `bg-accent` + `text-white` + 2px border matching background + shadow-sm + font 600. Hover deepens to `accent-hover`. Inline `style` carries `var(--color-accent)` to defeat Tailwind class-order issues — keep that pattern when copying primary button shape elsewhere.
- **Secondary:** `bg-surface` + `text-text` + 1px `border-border` + font 500. Default for non-primary actions.
- **Ghost:** transparent + `text-text` + transparent border. Hover fills to `bg-surface`. Use for low-emphasis inline actions (close, dismiss, "edit").
- **Danger:** `bg-error` + `text-white` + 2px `error` border + shadow-sm + font 600. Reserved for destructive actions only.
- **Focus:** `focus-visible:ring-2 ring-accent ring-offset-2`. All variants. Visible on keyboard focus, never on click.
- **Disabled:** opacity 0.5 + `cursor-not-allowed`. No color change; the dim-out is the signal.
- **Transition:** `all 150ms`.

### Chips & Badges

- **Filter Chip** (`FilterChip`): A `Badge variant="default"` wrapping the label with a ghost-button "×" affordance. Pill-shaped, 12px / 600. Removing is a single click on the ×; no confirm.
- **Badge variants:** `default` (cream + ink-mid), `success` (leaf + green-tinted bg), `warning` (amber + orange-tinted bg), `error` (coral + red-tinted bg), `accent` (accent-light + accent). All pill-shaped (`rounded-full`), `text-xs font-semibold`, `px-2.5 py-0.5`, with a 1px border that color-matches the variant.
- **Score Pill** (`ScorePill`): Numeric 1–10 score with optional prefix label. Threshold-based color band (green ≥ 7, yellow ≥ 5, red < 5) using tinted-semantic backgrounds. `tabular-nums` on the digit so columns line up.

### Cards / Containers

- **Corner Style:** `rounded.card` (12px) — softer than buttons, distinctly different so they read as containers rather than oversized buttons.
- **Background:** `bg-bg` / `bg-background` (NOT cream). Inline `style={{ backgroundColor: 'var(--color-background)' }}` is applied to defeat dark-mode override timing issues — keep that pattern.
- **Border:** 1px `border` hairline at rest. Hoverable cards promote to `border-strong` on hover.
- **Shadow Strategy:** `shadow-card` at rest, `shadow-deep` on hover (only when `hoverable` or `onClick` is set).
- **Internal Padding:** `none` / `sm` (12px) / `md` (16px, default) / `lg` (24px). Match to the density of contents — image grids use `none`, KPI rows use `md`, hero summaries use `lg`.

### Image Tile (signature component)

The `ImageTile` is the most visible component in the visualizer — it renders the photo grid that *is* the product. It's a card with a thumbnail, a filename / subtitle / metadata stack below, and overlay badges in the top-right corner. Variants drive aspect ratio and body density (catalog dense vs. featured wide vs. instagram square). Stack-representative badge is auto-derived from `image.stack_*` fields and centralized — never duplicate that logic in consumers.

- **Shape:** `rounded.card` (12px), `overflow-hidden`.
- **Surface:** `bg-bg` background, 1px `border-border` hairline, `shadow-card`.
- **Hover:** border promotes to `border-strong`, shadow lifts to `shadow-deep`.
- **Thumbnail:** `bg-surface` placeholder underneath, `object-cover` image, lazy loaded.
- **Overlay slot:** Top-right column for caller badges plus auto-derived stack badge.
- **Body:** filename (medium weight, ink-deep, truncate), subtitle (text-secondary, truncate), date (text-tertiary), metadata badge row.

### Job Card

A status-driven card surfacing a single background job. Built on the `Card` primitive — same hairline border, same ambient shadow, same hover treatment. Top row pairs the job type / id with a `StatusBadge` plus an optional severity pill on failure. Running jobs reveal a progress strip with `bg-border` track and `bg-accent` fill.

### Inputs / Fields

- **Style:** 1px `border` hairline, `bg-bg`, `text-text`, `placeholder-text-tertiary`, `rounded.base` (8px), `px-3 py-2`.
- **Hover:** border promotes to `border-strong`.
- **Focus:** 2px `ring-accent` + transparent border (the ring replaces the border).
- **Error:** border + ring switch to `error`. Below-field error text in `text-error`, 14px, `mt-1`.
- **Disabled:** opacity 0.5 + `cursor-not-allowed`.
- **Label:** 14px / 500 / `text-text-secondary`, `mb-1.5` above the field.

### Tab Navigation

- **Style:** Horizontal text tabs separated by a 1px `border` bottom strip.
- **Active:** 3px bottom border in `accent`, text in `accent`, font 600.
- **Inactive:** transparent border, `text-text` at 60% opacity.
- **Hover (inactive):** opacity 100%, border hints to `border-strong`.
- **Padding:** `px-4 py-2`, `text-sm font-semibold`.

### Top Navigation (Layout)

- **Position:** sticky-top, 64px tall, full-bleed.
- **Background:** `bg-bg` + `border-b border-border`. Never a colored bar.
- **Brand mark:** Inter 600, 18px, `text-text`. Text only — no logo image.
- **Nav items:** 14px / 500 pill links (`rounded.base`, `px-3 py-1.5`). Active: `bg-accent` + `text-white` + shadow-sm + font 600. Inactive: `text-text-secondary`, hover `bg-surface`.
- **Mobile (`<md`):** Brand stays in header; nav drops to a horizontal scroll strip below, separated by a 1px hairline.

### Page States (Empty / Loading / Error)

The three full-page states share one shape: centered text on `text-center py-12`, no card, no icon. Differentiation is by color and copy.

- **Loading** (`PageLoading`): single line in `text-text-secondary`.
- **Empty** (`EmptyState`): primary message in `text-text-secondary`; optional `hint` line in `text-text-tertiary` 14px below.
- **Error** (`PageError`): single line in `text-error` prefixed with the localized "Error:" string.

The shape is intentionally bare. Page states should not look like cards — they should look like a polite note in the gutter that nothing is here yet.

### Skeleton Grid

The pre-load placeholder for image grids: a card-shaped wrapper with `border` hairline + `bg-bg`, an aspect-square pulse block in `bg-border` for the thumbnail, and two short pulse bars below for the title and subtitle. Stays in the same elevation grammar as the real `ImageTile` so swapping skeleton → tile doesn't shift the layout.

### Modal / Dialog

The visualizer has two main modals: `JobDetailModal` and `ImageDetailModal`. Both share: full-screen scrim (`bg-black/40` or equivalent), centered content panel using the Card vocabulary at `rounded.card`, `shadow-deep`, and `border-strong` (modals at rest carry the *promoted* hairline). Padding `lg` (24px) on the body. Close affordance is a ghost-button "×" in the top-right of the panel header.

## 6. Do's and Don'ts

### Do:

- **Do** use the four CSS variable token families exclusively for color: `--color-{background|surface|surface-hover}`, `--color-text-{primary|secondary|tertiary}`, `--color-{border|border-strong}`, `--color-{accent|accent-hover|accent-light}` plus `--color-{success|warning|error}`. They flip cleanly between `:root` and `.dark`.
- **Do** carry inline `style={{ backgroundColor: 'var(--color-...)' }}` on the primary button and on `Card` backgrounds — Tailwind class-order has bitten this codebase before.
- **Do** lead with the lightest treatment that conveys the intent (ghost > secondary > primary). Primary buttons are scarce on this surface by design.
- **Do** keep accent at ≤10% of any screen. If a screen feels under-accented, the answer is more whitespace, not more blue.
- **Do** pair every card with a 1px `border` hairline AND `shadow-card`. Never one without the other.
- **Do** preserve negative letter-spacing on Display / Headline / Title / Subtitle. The tracking is the typographic identity.
- **Do** use Inter 400 / 500 / 600 / 700 — and only those four weights.
- **Do** make photos the loudest thing on screen. Strip chrome around image grids; let `TileGrid` and the photos themselves carry the layout.
- **Do** centralize derived UI on shared types (e.g. `image.stack_*` → `ImageTile`) so consumers stay clean.

### Don't:

- **Don't** introduce a second accent color. The system has one accent. Purple, teal, pink, and orange flourish-accents are forbidden — the existing palette already covers status (semantic) and emphasis (`accent`).
- **Don't** use pure `#000` or pure `#fff` outside the light-mode `background` token. Both modes carry warm undertones; cold neutrals break the room.
- **Don't** raise any shadow stop above 0.05 opacity. If the elevation isn't reading, promote the border to `border-strong` first.
- **Don't** apply gradient backgrounds, gradient text (`background-clip: text`), glassmorphism (`backdrop-filter: blur`), or animated mesh backgrounds. None of these belong here.
- **Don't** use `border-left` or `border-right` greater than 1px as a colored stripe accent. If a card needs emphasis, use the accent badge or a leading icon — never the side stripe.
- **Don't** stack cards inside cards. Nested `bg-bg` + `shadow-card` reads as a UI bug.
- **Don't** widen body line length past ~75ch. The 8-column `max-w-7xl` container plus generous gutters is the answer; don't fight the gutters with full-bleed text.
- **Don't** reach for raw Tailwind palette classes (`text-gray-500`, `bg-blue-600`, `text-red-600`) for the four primary surface roles — backgrounds, text, borders, accents. Use the semantic token classes (`bg-bg`, `text-text-secondary`, `border-border`, `bg-accent`). The narrow exception is **tinted semantic state surfaces** (a green-tinted background for a success badge, a red-tinted alert panel): the project currently uses raw Tailwind for those tints by convention because the CSS variables don't yet expose tinted semantic surfaces. New semantic-state components should follow the `Badge` pattern — raw tint background + semantic text + semantic border — rather than going fully raw.
- **Don't** invent a developer-tool dark mode. The dark theme is the same warm room with the lights down — not a charcoal-and-neon refactor.
- **Don't** add a positive letter-spacing tracking step to display type. The tracking goes more negative as size goes up, never the reverse.

# Design tokens — CubeLite (Tonal)

`design/tokens.json` is the single source of truth for the colours, type, shape, density and
motion of the desktop app. A generator turns it into the generated regions of
`apps/desktop/src/app.css`; a lint keeps the components on it; a test suite checks its contrast.

- Spec: `docs/superpowers/specs/2026-11-10-tonal-design-system-design.md`
- Design system (usage rules, components): https://claude.ai/artifact/NhxxZZksmWfXA5FyA2vr3d
- `design/design_handoff_cubelite_ui/` is the v2 handoff, kept for history only.

---

## Structure

```
design/
├── tokens.json          ← All tokens (v3, Tonal)
├── build-css.ts         ← Pure builders: tokens → the generated regions of app.css
├── build-css.test.ts    ← Generator tests, including "app.css is in sync"
├── type-style.ts        ← Parser for the compact typography syntax
├── type-style.test.ts   ← Parser tests
├── export-tokens.ts     ← CLI: reads tokens.json, rewrites app.css (`pnpm design:tokens`)
└── README.md            ← This file
```

---

## `tokens.json`

Top-level groups: `color`, `identity`, `spacing`, `radius`, `shadow`, `font`, `density`, `icon`,
`motion`. A key starting with `$` is metadata (`$description`, `$type`, …) and is never emitted.

### Colour roles (`color`)

Each role carries one OKLCH value per theme, `[lightness, chroma, hue]`:

```json
"surface-container": { "$dark": [0.215, 0.036, "tint"], "$light": [0.99, 0.005, "tint"] }
```

A hue of `"tint"` follows the active cluster: the generator writes `oklch(L C var(--cl-tint-h))`.
A number is a fixed hue (the state and data colours). Anything else (a typo such as `"Tint"`, a
missing value) stops the generator with the role's name.

| Group | Roles |
|---|---|
| Surfaces (tinted) | `surface-window`, `surface-sunken`, `surface-container`, `surface-container-high`, `surface-container-top`, `surface-overlay` |
| Lines (tinted) | `outline` (decorative hairlines), `outline-strong` (control borders, 3:1) |
| Text (tinted) | `text`, `text-muted`, `text-subtle` |
| Primary (tinted) | `primary` / `on-primary`, `primary-container` / `on-primary-container` |
| State (fixed hues) | `success`, `warning`, `error`, their `*-container` / `on-*-container` pairs, `error-solid` / `on-error-solid` |
| Data (fixed hues) | `data-1` … `data-5`: chart series, log sources, JSON values |

Every role becomes a Tailwind colour (`bg-surface-container`, `text-text-muted`,
`border-outline-strong`, `fill-success`, …) and the variable `var(--color-<role>)`.

**Write the full name.** Tailwind v4 emits a theme variable only if its full name appears
literally somewhere in the sources: `var(--color-data-${n})` or `` `text-${role}` `` built at run
time leaves the colour undefined and nothing is drawn. Keep a literal table instead
(`var(--color-data-1)`, …).

### Tint and identity (`identity`)

`identity.hues` maps each cluster identity to a hue: blue 240 (the `default`), magenta 345, teal
190, violet 310, indigo 275. They stay between 185 and 345: red, amber and green mean a state,
never a cluster (the contrast suite checks this).

A cluster shows its identity as a **tint**, never as a colour of its own:

- `--cl-tint-h` is set inline on `<html>` from the active cluster (`applyTint` in
  `apps/desktop/src/lib/appearance.ts`); the All Clusters dashboard and onboarding keep the
  default. Changing cluster cross-fades every tinted colour (`--cl-tint-h` is a registered
  `@property`).
- A subtree that belongs to another cluster (rail avatar, dashboard card, palette row, the log
  pop-out) carries `data-tint` and `style={tintStyle(color)}` (`--cl-tint-h: var(--cl-hue-teal)`):
  every role is declared again on `[data-tint]`, so `bg-primary` inside it is that cluster's
  primary.

### Typography (`font`)

`font.family`: `sans` = Inter (interface), `mono` = JetBrains Mono (values the cluster produced),
`display` = Space Grotesk (titles, status heroes, key numbers). The fonts are bundled with the
`@fontsource` packages imported at the top of `app.css` (offline, no network).

`font.style.*` uses a compact syntax, `"<weight> <size>px <sans|mono|display>[ · ls <em>em]"`, plus
an optional `$lineHeight` and `$color` (a colour role). The generator emits one
`@utility type-<name>` per style; a size under 10 px, an unknown flag (there is no `uppercase`:
labels are sentence case) or an unknown colour role stops it.

| Style | Value | Use |
|---|---|---|
| `display` | 600 34px display · ls −.02em | view title and its count |
| `stat` | 600 32px display | the numbers that explain a state |
| `headline` | 600 22px display · ls −.01em | status hero, dialog titles, empty states |
| `title` | 600 15px sans | card titles, primary button |
| `body` | 500 14px sans | navigation, buttons, chips, rows |
| `body-sm` | 400 13px sans | descriptions, helper text, toasts |
| `label` | 600 12px sans, `text-subtle` | column headers, section and field labels |
| `micro` | 500 11px sans | keyboard hints, counters |
| `data` | 500 13px mono | resource names, values |
| `data-sm` | 500 12px mono | numeric cells, counts, versions |
| `log` | 400 12px mono | log lines, YAML, terminal |

### Shape, space, density, motion

- `radius`: `xs` 6 · `sm` 10 · `md` 16 · `lg` 20 · `xl` 28 · `full` (pills).
- `spacing`: `1…8` on a 4 px scale.
- `shadow`: `overlay` only, under `surface-overlay`. Cards have no shadow and no border.
- `density`: `--row-h`, `--nav-h`, `--control-h`, `--control-inline-h`, `--chip-h`,
  `--control-primary-h`; `<html data-density="compact">` swaps each for its `-compact` value (the
  rule at the end of `app.css`).
- `icon`, `motion`: icon sizes and animation timings, emitted as `--icon-*` and `--motion-*`.

---

## The generator

```
pnpm design:tokens     # tsx design/export-tokens.ts — rewrites app.css
pnpm design:test       # tsx --test design/*.test.ts
```

`build-css.ts` rewrites only what lies between the `/* @generated:<name>-start */` and
`/* @generated:<name>-end */` markers of `app.css`; everything else in the file is hand-written and
kept:

| Region | Content |
|---|---|
| `theme` | Tailwind `@theme`: fonts, `--color-<role>: var(--cl-color-<role>)` for every role, shadows, spacing, radius |
| `layer` | `@layer base`: the `--cl-color-*` values on `:root, [data-tint]` (light) and `.dark, .dark [data-tint]` (dark); `--cl-tint-h` and `--cl-hue-*` on `:root`; the `--color-*` roles declared again on `[data-tint]`; density, icon and motion variables |
| `type` | one `@utility type-<style>` per typography style |

`@theme` lands on `:root`, where `var(--cl-color-*)` is already resolved to the window's tint; that
is why a tinted subtree needs the roles declared again on `[data-tint]`.

There is no shadcn HSL bridge (`--background`, `--foreground`, …): nothing reads one. bits-ui is
used directly and reads no CSS variable.

### Updating tokens

1. Edit `design/tokens.json`.
2. Run `pnpm design:tokens`.
3. Run `pnpm design:test` (the generator tests fail if `app.css` is out of sync) and
   `pnpm --filter desktop test` (the contrast suite).
4. Commit `tokens.json` and `apps/desktop/src/app.css` together.

A new colour role must be added to the contrast matrix (or listed as exempt with a reason), or
the suite fails.

---

## The lint

`scripts/design-lint.sh` (bash 4 or later; on macOS `/opt/homebrew/bin/bash`) keeps the app on the
tokens. It fails on:

- in `apps/desktop/src/**/*.svelte`: `text-[Npx]` classes (use a `type-*` style) and raw hex
  colours (use a role; issue references such as `#317` and HTML entities are allowed);
- in `apps/desktop/src` and `apps/desktop/tests` (Svelte, TypeScript, JavaScript, CSS outside the
  generated regions): every name the Tonal restyle retired.

| Retired | Use instead |
|---|---|
| `surface-panel`, `surface-surface` | `surface-container` |
| `surface-raised`, `surface-row-hover` | `surface-container-high` |
| `border-default`, `border-faint` · `border-strong` | `outline` · `outline-strong` |
| `text-primary`, `text-data-bright` (as `text-text-…`, `--color-text-…`) | `text` |
| `text-secondary`, `text-log` | `text-muted` |
| `text-tertiary` | `text-subtle` |
| `text-disabled` | `text-subtle` at reduced opacity (no contrast requirement) |
| `accent` | `primary` |
| `accent-alt-violet`, `accent-alt-teal`, `cluster-*` for data | `data-1` … `data-5` |
| `cluster-*` for a cluster's identity | a `data-tint` subtree |
| `status-ok` · `warn` · `err` · `err-solid` · `info` | `success` · `warning` · `error` · `error-solid` · `text-muted` |
| `--alpha-selection-bg`, `--alpha-active-nav-bg` | `primary-container` |
| `--alpha-pill-*`, `--alpha-log-*-row` | the state's `*-container` |
| `type-subtitle` | `type-title` |
| `type-caption` | `type-body-sm` (running text) or `type-label` (a label) |
| `type-colhead`, `type-section` | `type-label` |
| `rounded-2xl`, `--radius-2xl` | `rounded-xl` |

`text-primary` alone is the primary role used as text and is allowed: a colour name is matched
after the dash that joins it to its utility or to `--color-`.

`scripts/design-lint.test.sh` runs the lint on throwaway trees: a clean one, and one per rule and
per retired name. Both run in CI (Design Lint job) and in `scripts/gates.sh` (`lint-test`,
`design-lint`).

---

## Contrast

`apps/desktop/src/design/tokens-contrast.test.ts` computes WCAG contrast from `tokens.json`
(OKLCH → sRGB, clipped to the gamut as a browser paints it, `apps/desktop/src/design/wcag.ts`) for
**both themes on the five identity hues**:

- 4.5:1 — `text`, `text-muted`, `text-subtle`, `primary`, `success`, `warning`, `error` on every
  surface; each `on-*` on its fill; `data-1` … `data-5` on the sunken and container surfaces;
- 3:1 — `outline-strong` on every surface, `success` on `primary-container`, the meter fills
  (`primary`, `warning`, `error`) on their `outline` track.

Every colour role must appear in that matrix or in its exempt list with a reason.

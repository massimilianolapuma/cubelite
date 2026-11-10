# Design Tokens — CubeLite

Single source of truth for all visual design primitives and semantic aliases used across the
CubeLite desktop application.

---

## Structure

```
design/
├── tokens.json          ← All tokens (v3, Tonal)
├── build-css.ts         ← Pure builders: tokens → the generated regions of app.css
├── build-css.test.ts    ← Generator tests (`pnpm design:test`)
├── export-tokens.ts     ← CLI wrapper — run to sync tokens → CSS
├── type-style.ts        ← Parser for the compact typography syntax
└── README.md            ← This file
```

Design system (usage rules, component guidelines): https://claude.ai/artifact/NhxxZZksmWfXA5FyA2vr3d
Spec: `docs/superpowers/specs/2026-11-10-tonal-design-system-design.md`

---

## Token layers

### 1. Colour roles (`color`)

Each role is OKLCH per theme: `"$dark": [lightness, chroma, hue]`, `"$light": […]`. A hue of
`"tint"` follows the active cluster: the generator emits `oklch(L C var(--cl-tint-h))`.

| Group | Roles |
|---|---|
| Surfaces (tinted) | `surface-window`, `surface-sunken`, `surface-container`, `surface-container-high`, `surface-container-top`, `surface-overlay` |
| Lines (tinted) | `outline` (decorative), `outline-strong` (control borders, 3:1) |
| Text (tinted) | `text`, `text-muted`, `text-subtle` |
| Primary (tinted) | `primary` / `on-primary`, `primary-container` / `on-primary-container` |
| State (fixed hues) | `success`, `warning`, `error`, their `*-container` / `on-*-container` pairs, `error-solid` / `on-error-solid` |
| Data (fixed hues) | `data-1` … `data-5`: chart series, log sources, JSON values |

Roles become Tailwind colours (`bg-surface-container`, `text-text-muted`, `border-outline`, …) and
`var(--color-<role>)`.

### 2. Tint and identity (`identity`)

`identity.hues` maps each cluster colour to a hue (blue 240, magenta 345, teal 190, violet 310,
indigo 275). The generator emits `--cl-hue-<colour>` and `--cl-color-cluster-<colour>` (the primary
lightness and chroma at that hue). `--cl-tint-h` defaults to the `identity.default` hue and is set
inline on `<html>` from the active cluster (`applyTint` in `apps/desktop/src/lib/appearance.ts`).

Colour values are declared on `:root, [data-tint]` (and `.dark, .dark [data-tint]`): put
`data-tint` and `style="--cl-tint-h: var(--cl-hue-teal)"` on an element to tint its subtree with
another cluster's colour.

Identity hues stay between 185 and 345: red, amber and green mean a state, never a cluster.

### 3. Aliases (`alias`, `font.alias`)

The v2 names (`surface-panel`, `text-secondary`, `border-default`, `accent`, `status-ok`, …;
`type-caption`, `type-colhead`, `type-section`, `type-subtitle`) are emitted as aliases of the new
roles and styles while components move over. **Do not use them in new code.** They are removed
when the restyle is complete (#604).

### 4. Typography (`font`)

`--font-sans` = Inter (interface), `--font-mono` = JetBrains Mono (values the cluster produced),
`--font-display` = Space Grotesk (titles, status heroes, key numbers).

`font.style.*` tokens use the compact syntax
`"<weight> <size>px <sans|mono|display>[ · uppercase][ · ls <em>em]"` plus optional `$lineHeight`
and `$color` (a colour role). The generator emits one Tailwind `@utility type-<name>` per token.
Sizes below 10px are rejected.

| Token | Value | Use |
|---|---|---|
| display | 600 34px display · ls −.02em | view title and its count |
| stat | 600 32px display | the numbers that explain a state |
| headline | 600 22px display · ls −.01em | status hero, dialog titles, empty states |
| title | 600 15px sans | card titles, primary button |
| body | 500 14px sans | navigation, buttons, chips, rows |
| body-sm | 400 13px sans | descriptions, helper text |
| label | 600 12px sans | column headers, field labels (sentence case) |
| micro | 500 11px sans | keyboard hints, counters |
| data | 500 13px mono | resource names, values |
| data-sm | 500 12px mono | numeric cells, counts |
| log | 400 12px mono | log lines, YAML, terminal |

Components must use these utilities; hard-coded `text-[Npx]` classes are not allowed.

### 5. Shape, space, density

- `--radius-{xs,sm,md,lg,xl,full}` = 6 · 10 · 16 · 20 · 28 · pill (`2xl` is retired, equal to `xl`).
- `--spacing-{1…8}`: 4 px base scale.
- Density variables: `--row-h`, `--nav-h`, `--control-h`, `--control-inline-h`, `--chip-h`,
  `--control-primary-h`. `<html data-density="compact">` swaps them for their `-compact` values
  (see the end of `app.css`).
- `--shadow-overlay` only under `surface-overlay`. Cards have no shadow.

---

## Accessibility

`apps/desktop/src/design/tokens-contrast.test.ts` computes WCAG contrast from `tokens.json`
(OKLCH → sRGB, clipped to the gamut as a browser paints it) for **both themes on every identity
hue**: text roles on every surface (4.5:1), each `on-*` on its fill, state and data colours as
text, `outline-strong` as a control border (3:1). A new colour role must be added to that matrix or
listed as exempt with a reason, or the suite fails.

---

## Updating tokens

1. Edit `design/tokens.json`
2. Run `pnpm design:tokens` (executes `tsx design/export-tokens.ts`)
3. Run `pnpm design:test` (generator tests, including "app.css is in sync") and `pnpm test`
   (contrast matrix)
4. Commit `tokens.json` and `apps/desktop/src/app.css`

> The generator rewrites **only** the content between `/* @generated:*-start */` and
> `/* @generated:*-end */` markers — manual CSS outside those blocks is preserved.

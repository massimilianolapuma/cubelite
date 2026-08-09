# WCAG AA contrast audit — design tokens

Date: 2026-08-09 · Scope: `design/tokens.json` (both apps, light + dark themes) ·
Stage 1 of 3 for issue #120.

## Method

- **Math**: WCAG 2.1 contrast ratio — relative luminance with sRGB
  linearization, `(L1 + 0.05) / (L2 + 0.05)` where `L1 ≥ L2`. Implemented
  dependency-free in `apps/desktop/src/design/wcag.ts`
  (`relativeLuminance`, `contrastRatio`), unit-tested against known
  reference pairs (black/white = 21:1, the canonical `#767676`/`#ffffff` ≈
  4.54:1 pair, symmetry, self-contrast = 1:1) in `wcag.test.ts`.
- **Audit suite**: `apps/desktop/src/design/tokens-contrast.test.ts` reads
  `design/tokens.json` directly and, for a declared pairing matrix of text
  tokens against the surfaces they legitimately sit on (per component
  usage), asserts a contrast ratio for both themes. It runs permanently as
  part of `pnpm vitest run`, so future token edits cannot silently regress
  contrast.
- **Thresholds**: 4.5:1 for normal text (WCAG AA), applied uniformly to
  `text.*`, `status.*`, `accent.default`, and `cluster-identity.*` as used
  for text (log source column). `text.disabled` is exempt from AA (WCAG
  1.4.3 disabled-content exception) but is floor-asserted ≥ 2.5:1 against
  `window`/`panel`/`surface` so it never becomes illegible.
- **Fix pass**: for every failing pairing, the failing token's lightness
  (HSL) was nudged by the smallest step that clears the threshold against
  its *worst* surface for that theme, with hue and saturation held
  constant — then re-verified against every surface that token is tested
  on. Surface tokens were never touched (no surface had multiple failing
  text tokens that a single surface nudge would have cleared more
  cheaply). The nudge search used a scratch Node script duplicating the
  math in `wcag.ts` — not committed.

## Result: zero exceptions

All 28 failing pairings from the pre-fix audit clear 4.5:1 (or the 2.5:1
disabled floor) with a pure hue/saturation-preserving lightness change —
none required trading off identity hue, so the `EXCEPTIONS` map in
`tokens-contrast.test.ts` remains empty. 88/88 audit assertions pass.

## Changed tokens (before → after)

All changes are light-theme (`$light`) except `text.tertiary`, which was
dark-theme only. Ratio columns show the **worst** surface pairing for that
token/theme before and after (full matrix below).

| Token | Theme | Before hex | After hex | Worst-surface ratio before → after |
|---|---|---|---|---|
| `text.tertiary` | dark | `#71717a` | `#7d7d86` | 3.837 → 4.547 (surface) |
| `text.disabled` | light | `#a0a0ab` | `#9b9ba7` | 2.378 → 2.524 (panel floor) |
| `accent.default` | light | `#4e77e5` | `#3b68e2` | 3.786 → 4.523 (panel) |
| `status.ok` | light | `#0a9a6b` | `#087e58` | 3.186 → 4.504 (sunken) |
| `status.warn` | light | `#c47b09` | `#9b6107` | 3.012 → 4.536 (sunken) |
| `status.err` | light | `#dc3f3f` | `#d42727` | 3.860 → 4.523 (sunken) |
| `status.info` | light | `#0f7fbd` | `#0e74ad` | 3.888 → 4.521 (sunken) |
| `cluster-identity.blue` | light | `#3b82f6` | `#0b63f3` | 3.263 → 4.551 (sunken) |
| `cluster-identity.teal` | light | `#0d9488` | `#0b7b71` | 3.321 → 4.559 (sunken) |
| `cluster-identity.amber` | light | `#d97706` | `#a65b05` | 2.826 → 4.521 (sunken) |
| `cluster-identity.pink` | light | `#db2777` | `#cf236f` | 4.078 → 4.518 (sunken) |

All 11 changes preserve hue and saturation exactly (HSL H/S unchanged) —
only lightness (L) moved, by 1.7 to 10.3 percentage points depending on the
token, the smallest step that clears its threshold. `cluster-identity.amber`
needed the largest move (L 43.7% → 33.5%), matching it being the worst
pre-fix miss (2.83:1). `cluster-identity.violet` was already compliant in
both themes and needed no change.

## Full post-fix matrix

Ratios are `text token` on `surface token`, both themes, after the fix
pass. All values ≥ threshold (4.5:1, or 2.5:1 for the disabled floor).

### text.primary (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| window | 17.890 | 16.974 |
| panel | 17.281 | 16.271 |
| surface | 16.871 | 17.717 |
| raised | 15.770 | 15.026 |
| overlay | 16.429 | 17.717 |
| sunken | 17.655 | 15.716 |
| row-hover | 16.416 | 15.438 |

### text.secondary (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| window | 7.229 | 7.406 |
| panel | 6.983 | 7.099 |
| surface | 6.817 | 7.730 |
| overlay | 6.638 | 7.730 |

### text.tertiary (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| window | 4.822 | 4.831 |
| panel | 4.658 | 4.631 |
| surface | 4.547 | 5.043 |

### text.log (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| sunken | 11.670 | 9.969 |

### text.data-bright (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| panel | 14.970 | 13.679 |
| surface | 14.615 | 14.895 |

### status.ok (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| window | 10.229 | 4.865 |
| panel | 9.881 | 4.664 |
| surface | 9.646 | 5.078 |
| sunken | 10.094 | 4.504 |

### status.warn (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| window | 11.780 | 4.899 |
| panel | 11.379 | 4.696 |
| surface | 11.109 | 5.114 |
| sunken | 11.625 | 4.536 |

### status.err (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| window | 7.109 | 4.885 |
| panel | 6.867 | 4.682 |
| surface | 6.704 | 5.098 |
| sunken | 7.015 | 4.523 |

### status.info (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| window | 11.794 | 4.883 |
| panel | 11.393 | 4.681 |
| surface | 11.122 | 5.097 |
| sunken | 11.639 | 4.521 |

### accent.default (min 4.5:1)

| Surface | Dark | Light |
|---|---|---|
| window | 7.182 | 4.718 |
| panel | 6.938 | 4.523 |
| surface | 6.773 | 4.925 |

### cluster-identity.* on sunken (min 4.5:1)

| Identity color | Dark | Light |
|---|---|---|
| blue | 7.633 | 4.551 |
| teal | 10.425 | 4.559 |
| amber | 9.036 | 4.521 |
| pink | 7.327 | 4.518 |
| violet | 7.131 | 5.055 |

### text.disabled floor (min 2.5:1, AA-exempt)

| Surface | Dark | Light |
|---|---|---|
| window | 2.976 | 2.633 |
| panel | 2.874 | 2.524 |
| surface | 2.806 | 2.749 |

## Exceptions

None. The `EXCEPTIONS` map in `apps/desktop/src/design/tokens-contrast.test.ts`
is empty — every failing pairing reached its threshold with a
hue/saturation-preserving lightness nudge, so no pairing needed to trade
identity hue for contrast.

## Out of scope

Per the design spec (`docs/superpowers/specs/2026-08-09-a11y-contrast-audit-design.md`),
the following are explicitly out of scope for this audit and were not
assessed:

- **Component-level contrast**: alpha overlays composited via
  `color-mix()` (selection backgrounds, active-nav/rail tints, pill
  backgrounds, log row tints, focus rings) — these blend a token color at
  partial opacity over a surface at render time, and their effective
  contrast depends on the runtime composite, not a static token pairing.
- **Hover/interactive states** built from those alpha recipes.
- **Non-text contrast** (borders, icons) — noted as a follow-up, not
  covered by this stage.
- **Stage 2** (VoiceOver + keyboard) and **Stage 3** (Dynamic Type) of
  issue #120 — separate specs, separate stages.

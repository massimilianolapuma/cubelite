# Tonal phase 1 — token foundations and cluster tint — implementation plan

**Goal:** put the Tonal tokens under the whole desktop app so it recolours at once, with the tint
following the active cluster; no component is restyled.

**Spec:** `docs/superpowers/specs/2026-11-10-tonal-design-system-design.md` (§3 #3 #4 #9, §4, §11.1)
**Issue:** #608 · **Branch:** `feat/608-tonal-foundations` → `feat/604-tonal`

**Architecture:** `design/tokens.json` becomes schema v3 (colour roles as `[L, C, H]` per theme, `H`
a number or `"tint"`). The generator is split into a pure `design/build-css.ts` (testable with
`node:test`) and the CLI `design/export-tokens.ts`. Every tinted colour is
`oklch(L C var(--cl-tint-h))`, declared on `:root, [data-tint]` so a subtree can carry another
cluster's tint. Old utility names stay as aliases of the new roles.

## Global constraints

- Token values exactly as spec §4.2–§4.4. Identity hues: teal 190, blue 240, indigo 275, violet 310,
  magenta 345. Default tint 240.
- Old names keep resolving (spec §4.5) so no component file needs a colour or type edit in this phase.
- No `unwrap`-style shortcuts in tests: every new behaviour has a test that failed first.
- Gates before each commit: `pnpm lint`, `pnpm test`, `pnpm design:test`, `npx svelte-check --threshold error`.

## Review focus

1. A hue outside sRGB gamut: contrast must be computed on the clipped colour, as a browser paints it.
2. A saved identity colour that is no longer in the palette (`amber`, `pink`, or garbage) must
   migrate or fall back, never crash or leave a context without a colour.
3. `app.css` edited by hand and drifting from `tokens.json`: a test regenerates and compares.
4. A subtree tint (`data-tint`) inside the dark theme must get dark values, not light ones.
5. The pop-out log window must carry the tint of the cluster its pod belongs to.

## Tasks

### 1 · OKLCH contrast math — `apps/desktop/src/design/wcag.ts`, `wcag.test.ts`
Produces: `oklchLuminance(l: number, c: number, h: number): number` (linear sRGB, each channel
clipped to 0–1) and `contrastRatioOklch(a: Oklch, b: Oklch): number` with `type Oklch = [number, number, number]`.
Tests: white `[1,0,0]` → 1; black → 0; `[0.627955, 0.257683, 29.2339]` (sRGB red) → 0.2126 ± 0.002;
an out-of-gamut colour does not exceed 1; ratio white/black = 21.

### 2 · Type syntax — `design/type-style.ts`, `type-style.test.ts`
`TypeFamily` gains `"display"`; `ls` accepts a negative value (`ls -.02em`).

### 3 · Token schema v3 and generator — `design/tokens.json`, `design/build-css.ts` (new), `design/export-tokens.ts`, `design/build-css.test.ts` (new), `apps/desktop/src/app.css`
Produces: `buildCss(css: string, tokens: Tokens): string`.
Tests (node:test): tinted role emits `oklch(0.165 0.03 var(--cl-tint-h))` under `.dark, .dark [data-tint]`
and the light value under `:root, [data-tint]`; fixed-hue role emits its number; `--cl-tint-h: 240`
and `--cl-hue-<identity>` on `:root`; `--color-surface-panel: var(--cl-color-surface-container)` and the
other §4.5 aliases in `@theme`; `type-caption` emitted with `body-sm` declarations; no HSL bridge;
`buildCss(app.css, tokens.json) === app.css` (freshness).
Manual CSS in `app.css`: font imports, `@property --cl-tint-h` with a 240 ms transition (off under
reduced motion), compact overrides for the new density variables.

### 4 · Contrast matrix — `apps/desktop/src/design/tokens-contrast.test.ts`
Rewritten on the v3 schema: spec §4.6 matrix × `dark|light` × five identity hues; coverage guard:
every colour role is audited or listed exempt with a reason.

### 5 · Fonts — `apps/desktop/package.json`, `app.css`
`@fontsource/inter` 400 500 600, `@fontsource/space-grotesk` 500 600, `@fontsource/jetbrains-mono`
400 500 600 700. Geist imports and packages removed (nothing references them after task 3).

### 6 · Identity palette — `apps/desktop/src/lib/cluster-identity.ts`, `cluster-identity.test.ts`
`IDENTITY_COLORS = ["blue", "magenta", "teal", "violet", "indigo"]`; saved `amber` → `indigo`,
`pink` → `magenta`; unknown values are reassigned. New `identityHue(color): string` →
`var(--cl-hue-<color>)`. Test: the palette equals the `identity` keys of `tokens.json`.

### 7 · Tint and Accent removal — `appearance.ts`, `appearance.test.ts`, `stores/settings.svelte.ts`, `routes/+page.svelte`, `PreferencesModal.svelte`, `overlays.test.ts`
`applyTint(color: IdentityColor | null, root?)` sets or removes `--cl-tint-h`. The main window follows
the active cluster (none on the dashboard); the pop-out window follows the seeded session's cluster.
`applyAccent`, `Accent`, `settings.accent` and the Preferences section are removed.

### 8 · Close out
`design/README.md` (schema and tables), `CHANGELOG.md` (Unreleased), all gates plus
`scripts/design-lint.sh` and `npx playwright test --workers 1`, whole-branch review, PR to `feat/604-tonal`.

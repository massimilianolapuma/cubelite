# Accessibility #120 — stage 1: WCAG AA contrast audit + token fixes (design)

Date: 2026-08-09 · Scope: design tokens (both apps) · First of three staged PRs for #120.

Issue #120 acceptance requires a contrast audit against WCAG AA in light + dark.
Stage 2 (VoiceOver + keyboard) and stage 3 (Dynamic Type) are separate specs.

## Context

- Single source of truth: `design/tokens.json` (v2 schema — `$value` = dark hex,
  `$light` = light hex; `$light` falls back to `$value` when omitted).
- `pnpm design:tokens` (`design/export-tokens.ts`) generates BOTH
  `apps/desktop/src/app.css` and
  `apps/macos/cubelite/cubelite/Helpers/DesignTokens.swift` — a token change
  lands in both apps at once. Generated files are never edited by hand.

## Decision

Automate the audit as a **vitest test in `design/`** that parses `tokens.json`,
computes WCAG 2.1 contrast ratios for a declared list of text/background
pairings in both themes, and fails on any pairing below its threshold unless it
carries a documented exception. The test is the audit: it runs in `Test
Frontend` CI forever, so future token edits cannot silently regress contrast.

## Pairing matrix (initial)

Text tokens vs the surfaces they legitimately sit on (from component usage):

| Text token | Surfaces | Threshold |
|---|---|---|
| `text.primary` | window, panel, surface, raised, overlay, sunken, row-hover | 4.5:1 (AA normal) |
| `text.secondary` | window, panel, surface, overlay | 4.5:1 |
| `text.tertiary` | window, panel, surface | 4.5:1 |
| `text.log` | sunken | 4.5:1 |
| `text.data-bright` | panel, surface | 4.5:1 |
| `status.*` (ok/warn/err/info) as text | window, panel, surface, sunken | 4.5:1 |
| `accent` as text/link | window, panel, surface | 4.5:1 |
| `cluster.*` (identity) as text (log source column) | sunken | 3:1 (AA large/bold-adjacent: 9.5px semibold mono is small — target 4.5:1, allow documented 3:1 exceptions only if fix would break identity hue) |
| `text.disabled` | window, panel, surface | exempt (WCAG 1.4.3 exception for disabled), asserted ≥ 2.5:1 as a floor |

The matrix lives in the test file as data; adding a pairing is adding a row.

## Exceptions

An `exceptions` map in the test file: `{ "<text>/<surface>/<theme>": { ratio,
reason } }`. Every entry needs a reason string; the test asserts the actual
ratio still matches the recorded one (so an exception cannot rot silently).
Goal: zero or near-zero exceptions after the fix pass.

## Fix pass

For every failing pairing: adjust the failing token in `tokens.json` with the
MINIMAL delta that clears the threshold (nudge lightness, preserve hue),
preferring text-token changes over surface changes (surfaces cascade wider).
Regenerate with `pnpm design:tokens`; commit source + both generated files
together. Both apps' suites must stay green; visual deltas are expected to be
subtle (a few % lightness) — flagged in the PR body per token with
before/after hex + ratio for the user's eyeball check.

## Audit report

`docs/a11y/contrast-audit.md` (generated once, committed): full matrix with
ratios per theme, before → after for changed tokens, exception list with
reasons. Satisfies the "documented in docs/" acceptance line of #120.

## Testing

- The vitest audit file itself (runs in `Test Frontend` CI; `design/` has no
  test setup today — add the file under `apps/desktop` test glob OR extend
  vitest config to include `design/`; prefer whichever needs the smaller
  config change).
- WCAG math (relative luminance, 4.5/3.0 thresholds) implemented locally with
  unit cases against known pairs (black/white = 21, etc.) — no new dependency.
- macOS + desktop suites green after regeneration.

## Out of scope

Component-level contrast (alpha overlays via `color-mix`, hover states),
stage 2/3 work, non-text contrast (borders/icons — noted as follow-up).

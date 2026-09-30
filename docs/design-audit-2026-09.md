# Design audit — 2026-09

Date: 2026-09-29 · Scope: `apps/desktop` and `apps/macos` against Design System v1.1
(`design/tokens.json`, handoff `design/design_handoff_cubelite_ui/README.md` → "v1.1 amendments").
Spec: `docs/superpowers/specs/2026-09-16-unified-parity-v2-design.md` §5 · Issue #360.

## Rules

`scripts/design-lint.sh` runs in CI (job **Design Lint**, after its own self-test `scripts/design-lint.test.sh`).

| Stack | Files | Flagged | Use instead |
|---|---|---|---|
| desktop | `apps/desktop/src/**/*.svelte` | `text-[Npx]` classes; raw `#hex` colours (3/4/6/8 digits; all-digit issue refs such as `#317` and `&#…;` entities are ignored) | `type-*` utilities, colour tokens (`text-text-*`, `bg-surface-*`, `var(--color-*)`) |
| native | `apps/macos/**/Views/**/*.swift` | `.font(.system…)` and text-style fonts (`.caption`, `.callout`, `.headline`, `.title…`, …); raw system colours `.blue .green .orange .red .purple .indigo .teal .yellow` | `DesignTokens.Typography.*`, `DesignTokens` colour tokens |

Limits:

- **Desktop is held at 0.** Any match fails CI.
- **Native** is capped per file by `scripts/design-lint-allow.txt` (`<path> <max>`). A file above its cap fails CI. A file below its cap prints a hint to lower the entry, so the allow-list only shrinks.

The script counts matching lines, so a line with both a font and a colour counts twice.

## Result

### Desktop: 0

There are no `text-[Npx]` classes and no raw hex colours in any Svelte component. All 38 `text-[Npx]` classes counted in the spec have been migrated to `type-*` utilities. Hex values now exist only in the generated regions of `app.css` and in `design/tokens.json`.

### Native: 71 in 2 files (23 fonts, 48 colours)

The baseline was 238 in 33 files (158 fonts, 80 colours). Migration is tracked in **#395**; the table lists what is left, capped by the allow-list.

| Batch | Files | Removed |
|---|---|---|
| 1: `LogPanel/*`, `Shell/*` | 6 | 16 fonts |
| 2: `*ListView.swift` | 12 | 45 fonts, 13 colours |
| 3: `DeploymentDetailView`, `ResourceDetailView`, `LogsView`, `MainView+Sidebar` | 4 | 49 fonts, 11 colours |
| 4: `FirstLaunch`, `Preferences`, `ErrorBanner`, `MenuBarContext`, `MainView+Toolbar/ContentColumn/DetailArea`, `AggregatedLogs`, `PodExec` | 9 | 25 fonts, 8 colours |

| File (under `apps/macos/cubelite/cubelite/`) | Fonts | Colours | Cap |
|---|---|---|---|
| `Views/CrossClusterDashboardView.swift` | 11 | 19 | 30 |
| `Views/OverviewView.swift` | 12 | 29 | 41 |

Notes:

- **`Shell/*` and `LogPanel/*`** (done, batch 1): log lines use `log`; timestamps, source and level chips and counters use `micro` in mono (`.monospaced`, as the desktop's `type-micro font-mono`), with `.weight(.semibold)` where the desktop is semibold. SF Symbol glyphs and the bell badge digits use the new `icon` tokens (`2xs` 7, `xs` 8, `sm` 10, `md` 11) through `View.iconSize(_:)`, which scales with Dynamic Type like `scaledFont`.
- **`OverviewView` and `CrossClusterDashboardView`**: the raw colours are mostly per-card accent tints (`.blue`, `.purple`, `.teal`, …). They should map to the cluster-identity or status tokens.
- **List views** (done, batch 2): the Name column uses `data` (12.5 mono medium) and every other cell `data-sm` (12 mono), as the desktop tables do; namespace, class and status move from sans to mono with them. Status tints use `statusOk`/`statusWarn`/`statusErr`; the Service and Secret type tags keep their per-type tint through the cluster-identity tokens (`clusterBlue`, `clusterAmber`, `clusterViolet`, `clusterTeal`).
- **Detail views, Logs and Sidebar** (done, batch 3): the same mapping as the desktop drawers, with `title` for headers, `section` for section titles, `caption` for meta, `data-sm` for values and `micro` (mono) for log timestamps. Icons use the `icon` tokens, which now also cover `lg` 14 (sidebar rows), `xl` 28 (detail header) and `2xl` 40 (empty states). Log severity badges map to `statusErr`, `statusWarn` and `statusInfo`.
- **Onboarding, Preferences, banners, menu bar and toolbar** (done, batch 4): `title`/`subtitle` for onboarding headings, `body` for rows and banners, `caption`/`micro` for meta, `dataSm` for the kubeconfig path and the exec prompt. The error banner tint and the toolbar badge use `statusErr`. Only `OverviewView` and `CrossClusterDashboardView` remain.

## Keeping it at zero

1. Migrate a file to `DesignTokens`, then run `scripts/design-lint.sh`.
2. Lower or remove the file's line in `scripts/design-lint-allow.txt`. The script prints a `hint` line when a cap can drop.
3. Update the table above. Close #395 when the allow-list is empty.

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

### Native: 222 in 27 files (142 fonts, 80 colours)

The baseline was 238 in 33 files (158 fonts, 80 colours). Migration is tracked in **#395**; the table lists what is left, capped by the allow-list.

| Batch | Files | Removed |
|---|---|---|
| 1: `LogPanel/*`, `Shell/*` | 6 | 16 fonts |

| File (under `apps/macos/cubelite/cubelite/`) | Fonts | Colours | Cap |
|---|---|---|---|
| `Views/AggregatedLogsView.swift` | 1 | 0 | 1 |
| `Views/ConfigMapListView.swift` | 4 | 0 | 4 |
| `Views/CronJobListView.swift` | 2 | 0 | 2 |
| `Views/CrossClusterDashboardView.swift` | 11 | 19 | 30 |
| `Views/DeploymentDetailView.swift` | 16 | 4 | 20 |
| `Views/DeploymentListView.swift` | 3 | 2 | 5 |
| `Views/ErrorBannerView.swift` | 1 | 4 | 5 |
| `Views/FirstLaunchView.swift` | 8 | 2 | 10 |
| `Views/HelmReleaseListView.swift` | 5 | 3 | 8 |
| `Views/IngressListView.swift` | 6 | 1 | 7 |
| `Views/JobListView.swift` | 1 | 0 | 1 |
| `Views/LogsView.swift` | 12 | 4 | 16 |
| `Views/MainView+ContentColumn.swift` | 1 | 0 | 1 |
| `Views/MainView+DetailArea.swift` | 1 | 0 | 1 |
| `Views/MainView+Sidebar.swift` | 15 | 2 | 17 |
| `Views/MainView+Toolbar.swift` | 2 | 1 | 3 |
| `Views/MenuBarContextView.swift` | 4 | 0 | 4 |
| `Views/NodeListView.swift` | 2 | 0 | 2 |
| `Views/OverviewView.swift` | 12 | 29 | 41 |
| `Views/PodExecView.swift` | 1 | 0 | 1 |
| `Views/PodListView.swift` | 8 | 1 | 9 |
| `Views/PreferencesView.swift` | 6 | 1 | 7 |
| `Views/PvcListView.swift` | 2 | 0 | 2 |
| `Views/ResourceDetailView.swift` | 6 | 1 | 7 |
| `Views/SecretListView.swift` | 5 | 3 | 8 |
| `Views/ServiceListView.swift` | 6 | 3 | 9 |
| `Views/StatefulSetListView.swift` | 1 | 0 | 1 |

Notes:

- **`Shell/*` and `LogPanel/*`** (done, batch 1): log lines use `log`; timestamps, source and level chips and counters use `micro` in mono (`.monospaced`, as the desktop's `type-micro font-mono`), with `.weight(.semibold)` where the desktop is semibold. SF Symbol glyphs and the bell badge digits use the new `icon` tokens (`2xs` 7, `xs` 8, `sm` 10, `md` 11) through `View.iconSize(_:)`, which scales with Dynamic Type like `scaledFont`.
- **`OverviewView` and `CrossClusterDashboardView`**: the raw colours are mostly per-card accent tints (`.blue`, `.purple`, `.teal`, …). They should map to the cluster-identity or status tokens.
- **List views** (`*ListView.swift`): `.callout` / `.callout.monospaced()` cells map to `body` and `data-sm`.

## Keeping it at zero

1. Migrate a file to `DesignTokens`, then run `scripts/design-lint.sh`.
2. Lower or remove the file's line in `scripts/design-lint-allow.txt`. The script prints a `hint` line when a cap can drop.
3. Update the table above. Close #395 when the allow-list is empty.

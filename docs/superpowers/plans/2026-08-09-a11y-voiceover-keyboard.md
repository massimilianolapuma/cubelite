# A11y VoiceOver + Keyboard (#120 stage 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the VoiceOver/keyboard conventions of spec `docs/superpowers/specs/2026-08-09-a11y-voiceover-keyboard-design.md` to every interactive element of the macOS app; convert the four `onTapGesture` keyboard gaps to real buttons.

**Architecture:** Pure view-layer sweep in three area batches. No model/service changes. Every change is behavior-preserving: converted buttons keep the exact action closure and visual (`.buttonStyle(.plain)`), labels/traits are additive modifiers.

**Tech Stack:** SwiftUI (macOS), XCTest (suites as regression guard only).

## Global Constraints

- Single PR, branch `feat/120-a11y-voiceover-keyboard` (spec + this plan on it).
- The spec's §Conventions is the rulebook — every step cites the rule it applies. Read the spec file FIRST in every task.
- Labels in English, verb-phrase style ("Close tab", not "close-button").
- Identifier pattern `<area>.<element>` (es. `logpanel.follow`, `rail.cluster-<n>`, `palette.search`).
- `onTapGesture` → `Button` conversions MUST preserve the visual exactly (`.buttonStyle(.plain)`) and reuse the same closure; if a `contentShape` was implied by the tap area, add `.contentShape(Rectangle())`.
- Existing tests untouched and green. Gates per task (repo root, explicit exit codes):
  - `xcodebuild build-for-testing -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build 2>&1 | tail -3; echo "X=${PIPESTATUS[0]}"`
  - `xcodebuild test-without-building -project apps/macos/cubelite/cubelite.xcodeproj -scheme cubelite -destination 'platform=macOS' -derivedDataPath /tmp/cubelite-build -skip-testing cubeliteUITests 2>&1 | tail -5; echo "X=${PIPESTATUS[0]}"`
  - Known flaky (pass isolated, unrelated): LoadClientIdentityTests, AppSettingsContextNamespacesTests.
- Conventional Commits, NO Claude attribution, no session links.

---

### Task 1: Shell chrome sweep + palette/sidebar keyboard gaps

**Files (Modify):**
- `apps/macos/cubelite/cubelite/Views/Shell/ClusterRailView.swift`
- `apps/macos/cubelite/cubelite/Views/Shell/UnifiedSidebarView.swift`
- `apps/macos/cubelite/cubelite/Views/Shell/UnifiedHeaderView.swift`
- `apps/macos/cubelite/cubelite/Views/Shell/StatusBarView.swift`
- `apps/macos/cubelite/cubelite/Views/Shell/CommandPaletteView.swift` (contains one of the four `onTapGesture` gaps — result rows)
- `apps/macos/cubelite/cubelite/Views/MainView+Sidebar.swift` (contains one `onTapGesture` gap)
- `apps/macos/cubelite/cubelite/Views/MainView+Toolbar.swift`
- `apps/macos/cubelite/cubelite/Views/MenuBarContextView.swift`

**Interfaces:** none produced; conventions from the spec.

- [ ] **Step 1: Read the spec, then audit each file** — list every interactive element and which convention applies (report table: file, element, rule, action).
- [ ] **Step 2: Apply conventions** — labels on icon-only buttons; identity dots `accessibilityHidden` or folded into parent labels; `accessibilityIdentifier` on rail buttons (`rail.cluster-<name>`), palette search field (`palette.search`).
- [ ] **Step 3: Convert the two `onTapGesture` sites** (CommandPaletteView result rows → Button plain, keeps row visual + Return already handled?; MainView+Sidebar) per Global Constraints. Palette: ensure `@FocusState` puts focus in the search field on open (check existing behavior first — may already do it; report).
- [ ] **Step 4: Gates green (build + full suite), commit** `feat(macos): a11y sweep — shell chrome labels, traits, keyboard access`

### Task 2: List + detail views sweep

**Files (Modify):**
- `PodListView.swift` (contains the logs-chip `onTapGesture` gap → Button conversion)
- `DeploymentListView.swift`, `ServiceListView.swift`, `IngressListView.swift`, `ConfigMapListView.swift`, `SecretListView.swift`, `NamespaceListView.swift`, `NodeListView.swift`, `JobListView.swift`, `CronJobListView.swift`, `StatefulSetListView.swift`, `PvcListView.swift`, `HelmReleaseListView.swift` (only where rows/controls exist — audit first; many are plain tables)
- `ResourceDetailView.swift`, `DeploymentDetailView.swift`, `OverviewView.swift`, `CrossClusterDashboardView.swift`
- (all under `apps/macos/cubelite/cubelite/Views/`)

- [ ] **Step 1: Audit** — same report table. Rows get `accessibilityElement(children: .combine)` with composed labels (rule 5) ONLY where the row is interactive or informative as a unit; skip static tables where SwiftUI's default is already correct (report the skips).
- [ ] **Step 2: Apply** — PodListView logs chip → Button (identifier `podlist.logs-chip`); detail-view copy/action buttons labeled.
- [ ] **Step 3: Gates green, commit** `feat(macos): a11y sweep — list and detail views`

### Task 3: Log panel + preferences + dialogs sweep, conventions doc

**Files (Modify):**
- `LogPanel/LogToolbar.swift` (18 controls — the dense one: follow/pause, previous, wrap, timestamps, tail menu, export menu, container picker, search field: labels + state values per rule 2; identifiers `logpanel.*`)
- `LogPanel/LogTabStrip.swift` (tab select `onTapGesture` → Button; close buttons labeled "Close <pod> logs"; identifiers)
- `LogPanel/LogPanelView.swift`, `LogPanel/LogBodyView.swift` (reconnect banner: label + `retry` button; new-lines pill)
- `PreferencesView.swift`, `FirstLaunchView.swift`, `PodExecView.swift`, `LogsView.swift`, `AggregatedLogsView.swift`, `ErrorBannerView.swift`, `Shell/ManifestSheetView.swift`, `Shell/UnreachableView.swift` (if exists — audit)
- Create: `docs/a11y/voiceover-keyboard.md`

- [ ] **Step 1: Audit + apply** as previous tasks.
- [ ] **Step 2: Write `docs/a11y/voiceover-keyboard.md`** — the spec's conventions verbatim, per-area implementation notes (what got labeled/converted where), and the MANUAL VERIFICATION CHECKLIST for the user: Accessibility Inspector audit steps per screen; VoiceOver walk (cluster switch → pod list → drawer → log panel open/search/export → preferences); keyboard-only session of the same flow with expected focus behavior noted.
- [ ] **Step 3: Gates green, commit** `feat(macos): a11y sweep — log panel, preferences; verification checklist`

---

## Delivery

Single PR `feat/120-a11y-voiceover-keyboard` → main. Titolo: `feat(macos): VoiceOver labels and full keyboard access (#120)`. PR body: per-area summary + link al checklist doc + nota esplicita che l'acceptance (Inspector 0 critical + VoiceOver pass) è verifica manuale dell'utente sul build della PR. Push `massilp`; merge utente.

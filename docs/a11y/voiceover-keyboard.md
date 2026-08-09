# VoiceOver + keyboard accessibility (#120 stage 2)

Companion to `docs/a11y/contrast-audit.md` (stage 1). This covers stage 2: every
interactive element exposes a meaningful VoiceOver label and correct traits,
and the app is fully operable with keyboard only — no trackpad. Delivered as
three sweep tasks (shell chrome; list/detail views; log panel + preferences +
dialogs) against the design at
`docs/superpowers/specs/2026-08-09-a11y-voiceover-keyboard-design.md`.

## Conventions

Verbatim from the design doc's §Conventions — every change in this stage
follows one of these seven rules:

1. **Icon-only / symbol-only Button** → `.accessibilityLabel("<verb phrase>")`
   (e.g. "Close tab", "Export visible lines"). Never label text-bearing
   buttons redundantly.
2. **Stateful controls** (follow/pause, previous, wrap, timestamps) →
   `.accessibilityLabel` + `.accessibilityValue` or `.isToggle` trait so
   VoiceOver reads state, not just the name.
3. **Clickable non-Button** (`onTapGesture`) → convert to `Button` with
   `.buttonStyle(.plain)` preserving the exact visual, so it enters focus
   traversal and gets the button trait natively. This is the fix for all four
   keyboard gaps.
4. **Decorative images/dots** → `.accessibilityHidden(true)`; informative
   status dots → folded into the parent's label/value
   (`.accessibilityElement(children: .combine)` on rows).
5. **List rows** (pods, deployments, …) → `.accessibilityElement(children:
   .combine)` with a composed label "name, status, restarts N" so a row is one
   focus stop, not five.
6. **Identifiers**: `.accessibilityIdentifier` on primary interactive elements
   (rail buttons, palette field, log toolbar controls) with the pattern
   `<area>.<element>` (e.g. `logpanel.follow`) — groundwork for future
   UITests.
7. **Focus**: keep native traversal; add `@FocusState`/`.focused` only where a
   flow demands it (palette opens → search field focused; Esc returns focus to
   the invoking control where determinable). No custom tab-order overrides.

## Per-area implementation notes

### Shell chrome (task 1)

`ClusterRailView`, `UnifiedSidebarView`, `UnifiedHeaderView`, `StatusBarView`,
`CommandPaletteView`, `MainView+Sidebar`, `MainView+Toolbar`,
`MenuBarContextView`. Icon-only rail/header/toolbar buttons labeled
("All Clusters", "Open preferences", "Refresh all", "View logs and errors");
selection/connection state exposed via `.accessibilityValue`; decorative
status dots and chevrons hidden; `MainView+Sidebar`'s `clusterHeader`
`onTapGesture` converted to `Button` (one of the four keyboard gaps). New
identifiers use the `<area>.<element>` pattern; three pre-existing identifiers
(`rail-all-clusters`, `rail-context-<name>`, `palette-input`) were **not**
renamed to the dot pattern because `cubeliteUITests` references them by
literal string — renaming would silently break that suite (skipped by the
gate command run in CI for this stage). Command palette's backdrop-scrim
`onTapGesture` (dismiss-on-click-outside) was deliberately **not** converted —
Escape already provides full keyboard dismissal, and turning a full-window
scrim into a focusable `Button` would insert a spurious tab stop with no
benefit.

### List + detail views (task 2)

`PodListView`, `DeploymentListView`, `ServiceListView`, `IngressListView`,
`ConfigMapListView`, `SecretListView`, `HelmReleaseListView`, `NodeListView`,
`JobListView`, `CronJobListView`, `StatefulSetListView`, `PvcListView`,
`ResourceDetailView`, `DeploymentDetailView`, `OverviewView`,
`CrossClusterDashboardView`. Native `Table` rows were left alone (macOS
already gives them per-row AX semantics and arrow-key traversal for free);
rule 5's "combine into one row" treatment was instead applied to custom
`ForEach`-built rows without `Table` backing (container list, warnings list,
cross-cluster snapshot cards) — except where a row nests its own interactive
control (port-forward session row's "Stop" button), which was left
uncombined so the button keeps its own focus stop. Status dots were hidden
where an adjacent text column already states the same fact, and explicitly
labeled where they're the only source of that information (Job list, ingress
TLS icon, port-forward session state). `PodListView`'s "logs" chip
`onTapGesture` converted to `Button` (second of the four keyboard gaps).

### Log panel + preferences + dialogs (task 3, this doc's origin)

- **`LogPanel/LogToolbar.swift`** (the dense one — container picker, previous
  chip, search field + prev/next/filter, tail menu, follow button, overflow
  menu with timestamps/wrap toggles and export/clear): every stateful control
  now carries both a verb-phrase label and an `.accessibilityValue`
  reflecting its current state (follow → "Following"/"Paused", previous →
  "On"/"Off", filter → "On"/"Off", container/tail → current selection).
  The pre-existing "previous" chip label was upgraded from the bare word
  to "Show previous container logs". All controls got `logpanel.*`
  identifiers (`logpanel.search`, `logpanel.filter`, `logpanel.container`,
  `logpanel.previous`, `logpanel.tail`, `logpanel.follow`,
  `logpanel.overflow`, `logpanel.timestamps`, `logpanel.wrap`,
  `logpanel.export-visible`, `logpanel.export-full`, `logpanel.clear`,
  `logpanel.load-earlier`, `logpanel.search-previous`,
  `logpanel.search-next`).
- **`LogPanel/LogTabStrip.swift`**: the tab-select `onTapGesture` converted to
  `Button` (the last of the four keyboard gaps) with a composed label
  ("pod-name, container X, ready"/"not ready") and an
  `.accessibilityValue("Active tab")` for the current tab. The select `Button`
  wraps only the status circle + pod name + container text; the row's visual
  decoration (background/top accent bar/trailing divider) stays on a plain
  `HStack` container, and the close `Button` ("Close `<pod>` logs") is a
  **sibling** after the select button, not nested inside it — both are
  independent native focus stops with no click-through risk. Identifiers:
  `logpanel.tab-<pod>`, `logpanel.tab-close-<pod>`, `logpanel.collapse`.
- **`LogPanel/LogPanelView.swift`**: reconnect banner's pulsing status dot
  hidden (redundant with the adjacent "stream lost — reconnecting…" text);
  "retry now" labeled "Retry connection now",
  identifier `logpanel.reconnect-retry`.
- **`LogPanel/LogBodyView.swift`**: the "↓ N new lines" pill labeled
  "Jump to N new lines" (the raw down-arrow glyph would otherwise be spoken
  literally), identifier `logpanel.new-lines`.
- **`PreferencesView.swift`**: mostly standard `Toggle`/`Picker`/`Button`
  controls that are already accessible via their text labels — no gaps.
  `KubeconfigPathRow`'s found/missing status icon labeled ("File found"/"File
  missing", it isn't restated anywhere in text) and its icon-only remove
  button labeled "Remove `<path>`". Added identifiers to the two singular
  action buttons (`preferences.reset-credentials`,
  `preferences.add-kubeconfig-file`).
- **`FirstLaunchView.swift`**: feature-row and status-card icons are all
  decorative (redundant with adjacent text) → hidden. "Get Started" CTA
  got `firstlaunch.get-started`.
- **`PodExecView.swift`**: the "$" prompt glyph hidden (purely decorative);
  command `TextField` labeled "Shell command"
  (`podexec.command`); "Done" button got `podexec.done`.
- **`LogsView.swift`**: "Logs" heading + entry-count badge combined into one
  VoiceOver stop; segmented filter `Picker` (which hides its own label via
  `.labelsHidden()`) given an explicit "Filter log entries" label; each
  `LogRowView` combined into one row (timestamp, severity, source, message
  read as a unit). Identifiers: `logsview.close`, `logsview.clear-all`,
  `logsview.filter`.
- **`AggregatedLogsView.swift`**: label-selector and text-filter fields
  labeled; level chips (ALL/INFO/WARN/ERR) get a label + selected-state
  value; follow button gets the same label+value treatment as
  `LogToolbar`'s (folding in the "+N new lines" badge when paused); each log
  row combined into one stop. Identifiers: `aggregatedlogs.label-selector`,
  `aggregatedlogs.text-filter`, `aggregatedlogs.level-<name>`,
  `aggregatedlogs.follow`, `aggregatedlogs.clear`.
- **`ErrorBannerView.swift`**: exclamation icon hidden (decorative); "View
  Logs →" button's arrow glyph replaced in the accessible name with plain
  "View logs" (`errorbanner.view-logs`).
- **`Shell/ManifestSheetView.swift`**: all buttons are already text-bearing
  (Cancel/Apply/Edit/Copy/Done, no icon-only controls) — only identifiers
  added (`manifest.cancel`, `manifest.apply`, `manifest.edit`,
  `manifest.copy`, `manifest.done`), as groundwork for future tests around
  the copy/edit/apply flow.
- **`Shell/UnreachableView.swift`**: does not exist in the codebase — audited
  and confirmed absent (searched the whole `Views/` tree for "unreachable"
  content; the closest thing, `UnifiedErrorState` in `Shell/UnifiedStates.swift`,
  is purely presentational static text/icon with no interactive elements, so
  no accessibility gap to fix).

## Manual verification checklist

Automated tests do not exercise SwiftUI accessibility attributes (no XCTest
assertions cover `.accessibilityLabel`/`.accessibilityValue`/focus — that's
a UITests concern, out of scope for this stage). The acceptance criteria for
issue #120 stage 2 is a **manual pass on the PR build**, covering:

### 1. Accessibility Inspector audit (per screen)

For each of the following screens, open **Xcode → Open Developer Tool →
Accessibility Inspector**, point it at the running CubeLite build, and run
the **Audit** tab. Target: 0 critical issues per screen.

- [ ] Main window — cluster rail + sidebar + header (no cluster selected)
- [ ] Main window — pod list (Table)
- [ ] Main window — deployment/service/ingress/configmap/secret/node/job/
      cronjob/statefulset/pvc/helm-release lists (spot-check a few; they
      share the same `Table` pattern)
- [ ] Resource detail panel (pod detail with containers + port-forward)
- [ ] Deployment detail panel (spec grid + conditions table)
- [ ] Overview / cross-cluster dashboard
- [ ] Command palette (⌘K)
- [ ] Log panel — collapsed (tab strip only)
- [ ] Log panel — expanded (toolbar + body, with an active search and an
      active reconnect banner if you can trigger one)
- [ ] Preferences window — all three tabs (General, Appearance, Advanced)
- [ ] First-launch onboarding screen (best checked via a fresh
      `~/Library/Application Support` or by temporarily forcing the flag)
- [ ] Pod exec (shell) sheet
- [ ] Manifest sheet (view + edit mode)
- [ ] Aggregated logs view
- [ ] Logs & Errors window
- [ ] Error banner (trigger an error, e.g. disconnect network briefly)

For each: select every interactive control at least once in the Inspector's
element list and confirm it has a non-empty, meaningful label; for toggles/
menus, confirm the value line reflects current state.

### 2. VoiceOver walk

Enable VoiceOver (⌘F5), then walk this flow start to finish, confirming every
stop announces a sensible label and, where applicable, a state:

1. **Cluster switch**: rail → hear each cluster avatar announce cluster name
   + selected state; switch clusters via VO interact and confirm the sidebar/
   header update announced correctly.
2. **Pod list**: arrow through table rows; each row should read name +
   status + restarts as it's the native `Table` semantics; open the row's
   "Open logs" chip via VO and confirm the log panel opens.
3. **Drawer / resource detail**: open a pod's detail panel; walk through
   container rows (should read as one stop: name + sidecar/init tag + state)
   and the port-forward form (Remote port / Local port fields, Stop button
   reachable independently on active sessions).
4. **Log panel — open**: confirm the tab strip announces each tab's pod name,
   container, and ready state, and the active tab's "Active tab" value; tab
   through the toolbar (container picker → previous chip if visible → search
   field → tail menu → follow button → overflow menu) and confirm each
   announces its state.
5. **Log panel — search**: ⌘F to focus search, type a query, confirm the
   match-count text and prev/next/filter buttons are all reachable and
   labeled; Esc clears and returns focus.
6. **Log panel — export**: open the overflow menu (⋯), confirm Timestamps/
   Wrap Lines toggles announce on/off, and Export visible/full announce as
   plain actions.
7. **Preferences**: ⌘, to open; walk all three tabs, confirming every toggle/
   picker/stepper announces its current value; in Advanced, confirm the
   kubeconfig path rows announce "File found"/"File missing" + path + a
   "Remove `<path>`" action.

### 3. Keyboard-only session (no trackpad/mouse)

Repeat the same flow using only the keyboard (Tab/Shift-Tab to move focus,
Space/Return to activate, Esc to dismiss):

1. **Cluster switch**: Tab into the rail, arrow/Tab between cluster avatars,
   Return to select. Expected: focus ring visible on each avatar; selecting
   updates the sidebar without requiring a click.
2. **Pod list**: Tab into the table, arrow keys move between rows (native
   `Table` traversal), Return/Space on the "Open logs" chip opens the log
   panel. Expected: no unreachable rows or chips.
3. **Drawer**: Tab through the detail panel's actions (Logs/Shell/Describe/
   Restart/Delete), then into port-forward fields (Remote/Local) and the Stop
   button on any active session. Expected: Stop is reachable on its own Tab
   stop, not merged into the row.
4. **Log panel open/search/export**: ⌘L toggles collapse; Tab through the
   tab strip — expect each tab reachable, and its close (×) button reachable
   as its own, separate Tab stop right after (select and close are sibling
   `Button`s, not nested). ⌘F jumps
   focus straight to the search field from anywhere in the window. Tab
   through toolbar controls in order (container → previous → search → prev/
   next/filter → tail → follow → overflow) and confirm Return/Space toggles
   each one. Open the overflow menu with Return, arrow to Export visible…,
   Return to trigger.
5. **Preferences**: ⌘, opens the window with focus in a sensible default
   place; ⌘1/⌘2/⌘3 (or Tab) switch tabs; Tab through every control in each
   tab; Return activates the reset-credentials / add-file buttons.

Expected overall: nothing in this flow requires a click or trackpad gesture;
every interactive element is reachable via Tab/Shift-Tab in a logical order,
and Esc/⌘. dismiss sheets and return focus to the control that opened them
where that's determinable.

# macOS Quick-Fix Batch — Design

**Date:** 2026-07-18
**Issue:** [#314](https://github.com/massimilianolapuma/cubelite/issues/314)
**Scope:** Four small native macOS fixes found during the desktop ↔ macOS feature-parity audit. First batch of the parity alignment effort (#314–#318).

## Context

The macOS native app and cubelite-desktop are developed in parallel and must converge on features. This batch fixes the four defects with known root causes; larger parity work (Overview/metrics #315, logs #316, desktop gaps #317/#318) follows separately.

## Fix 1 — Default namespace (empty Dashboard)

**Bug:** With no namespace selected in the picker, nothing is fetched and nothing is shown. Resources load only from `.onChange(of: sidebarSelection)` (`Views/MainView.swift:297-317`); when `sidebarSelection == nil` the watch is cancelled and `loadResources` is never called.

**Design:** `sidebarSelection` must never be nil after a context finishes loading. Resolution order when selecting a context:

1. Last namespace the user selected for this context — new `appSettings.lastNamespace[context]` dictionary persisted to UserDefaults, updated on every namespace change.
2. The kubeconfig context's default namespace (existing `resolveDefaultNamespace`, `MainView+ConfigLoader.swift:44`).
3. "All Namespaces".

This also covers returning to the Dashboard screen: the selection survives, so resources are always loaded. Matches desktop behavior (defaults to All Namespaces) and improves on it (persistence).

## Fix 2 — Pod detail panel has no close control

**Bug:** `ResourceDetailView` header (`Views/ResourceDetailView.swift:253`) has no dismiss button; the panel disappears only when the table row is deselected.

**Design:** Add an `xmark` close button to the panel header. It invokes a new `onClose` callback wired in `MainView+DetailArea.swift` that sets `selectedPodID = nil`. Apply the same pattern to `DeploymentDetailView` if it lacks a close control.

## Fix 3 — "Describe" tears down the panel

**Bug:** `runAction` always calls `onPodMutated?()` on success (`Views/ResourceDetailView.swift:244`). `onPodMutated` (wired in `MainView+DetailArea.swift:161-166`) sets `selectedPodID = nil`, which unmounts the panel hosting the manifest `.sheet` before it can present — the panel closes and nothing is shown.

**Design:** Split the action path: only genuinely mutating actions (Restart, Delete) notify `onPodMutated`. Describe fetches the manifest and sets `manifestItem` directly without touching the mutation path; the panel stays open and the sheet presents.

## Fix 4 — Port-forward number formatting and input validation

**Bug:** The session row interpolates `Int` ports into a `LocalizedStringKey` (`Text("localhost:\(session.localPort) → \(session.remotePort)")`, `Views/ResourceDetailView.swift:202`), so locale grouping applies: 6789 renders as "6.789" in an Italian locale.

**Design:**
- Render ports with `Text(verbatim:)` (pattern already used in `LogsView.swift:63`).
- Validate the local-port field: numeric, range 1–65535, visible inline error on invalid input; the Forward button is disabled while invalid.
- Surface NWListener bind failures (port already in use) in the UI instead of failing silently.
- Out of scope (deferred to #318, shared behavior with desktop): automatic free-port assignment.

## Testing

- Unit tests where infrastructure exists: namespace resolution order (fix 1), port input validation (fix 4).
- Manual UI verification for panel close/Describe sheet (fixes 2–3) and locale rendering of ports (fix 4, Italian locale).

## Non-goals

Metrics, Events, Overview rename (#315); aggregated log viewer and log filters (#316); desktop window drag (#317); desktop port-forward (#318).

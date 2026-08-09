# A11y Dynamic Type (#120 stage 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Primary text scales to AX5 via a `scaledFont` modifier replacing ~109 fixed `.font(.system(size:))` sites, per spec `docs/superpowers/specs/2026-08-09-a11y-dynamic-type-design.md`.

**Architecture:** One `ScaledFontModifier` (@ScaledMetric wrapper, pixel-identical at default size), then a mechanical sweep with an explicit exclusion list (log grid, rail initials). No layout restructuring.

**Tech Stack:** SwiftUI (macOS), XCTest.

## Global Constraints

- Single PR, branch `feat/120-a11y-dynamic-type` (spec + plan on it).
- The spec's §Scope exclusion list governs — excluded sites keep `.font(.system(size:))` untouched.
- Anchor buckets (spec): size ≥ 13 → `relativeTo: .title3`; 10.5–12.9 → `.body` (omit, it's the default); ≤ 10.4 → `.caption`.
- Sizes/weights/designs preserved verbatim — only the wrapper changes.
- Gates (repo root, explicit exit codes): build-for-testing + test-without-building (`-derivedDataPath /tmp/cubelite-build`, `-skip-testing cubeliteUITests`, `; echo "X=${PIPESTATUS[0]}"`); run the test gate in background and POLL its output file. Known flaky: LoadClientIdentityTests, AppSettingsContextNamespacesTests, AppSettingsNamespaceMemoryTests.
- Conventional Commits, NO Claude attribution, no session links. SourceKit phantom diagnostics: ignore.

---

### Task 1: `ScaledFontModifier` + helper

**Files:**
- Create: `apps/macos/cubelite/cubelite/Helpers/ScaledFont.swift`
- Test: `apps/macos/cubelite/cubeliteTests/ScaledFontTests.swift`

**Interfaces:**
- Produces: `View.scaledFont(size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default, relativeTo: Font.TextStyle = .body) -> some View` — exact signature the sweep relies on.

- [ ] **Step 1: Failing test** — `ScaledFontTests`: modifier init stores the given size/weight/design; bucket helper (`ScaledFontModifier.anchor(for size: CGFloat) -> Font.TextStyle`, exposed for testability) returns `.title3` for 13/14, `.body` for 11/12.5, `.caption` for 9.5/10. Run gate → FAIL.
- [ ] **Step 2: Implement** per the spec's §Decision code block, plus the `anchor(for:)` static used by callers that don't pass `relativeTo:` explicitly — NOTE: default parameter stays `.body`; the sweep passes the bucket explicitly where ≠ .body.
- [ ] **Step 3: Gates green, commit** `feat(macos): scaledFont modifier for Dynamic Type`

### Task 2: Sweep — shell chrome + list/detail views

**Files (Modify):** all `Views/` and `Views/Shell/` files with `.font(.system(size:` EXCEPT `Views/LogPanel/*` (Task 3 handles those selectively). Enumerate with grep at task start; audit table in report (file, count converted, bucket choices, exclusions applied with reason).

- [ ] **Step 1: Grep + convert** — `.font(.system(size: X, weight: W, design: D))` → `.scaledFont(size: X, weight: W, design: D)` (+ `relativeTo: .title3`/`.caption` per bucket). EXCLUDE: `ClusterRailView` avatar initials (spec §Scope out).
- [ ] **Step 2: Layout sanity** — list any converted site inside a fixed `.frame(width:)`; if the text is primary content (not a data chip), keep conversion and note the truncation-at-AX5 acceptance; report the list.
- [ ] **Step 3: Gates green, commit** `feat(macos): dynamic type sweep — shell and views`

### Task 3: Sweep — log panel chrome (selective) + doc + verification section

**Files (Modify):** `Views/LogPanel/LogToolbar.swift`, `LogTabStrip.swift`, `LogPanelView.swift`, `LogBodyView.swift` (SELECTIVE per spec: chrome scales — toolbar button labels, search field, tab labels, banner, pill; the log GRID stays fixed — LogLineRow columns, monospaced data chips like tail counts if inside fixed-width chips: judge and report); `docs/a11y/voiceover-keyboard.md` (append "Dynamic Type verification" section: what scales, what's fixed by design, manual steps at max text size across the stage-2 walk).

- [ ] **Step 1: Selective conversion** with per-element rationale in the audit table.
- [ ] **Step 2: Doc section** + explicit list of intentionally-fixed elements.
- [ ] **Step 3: Gates green, commit** `feat(macos): dynamic type — log panel chrome; verification doc`

---

## Delivery

Single PR `feat/120-a11y-dynamic-type` → main. Titolo: `feat(macos): Dynamic Type for primary text (#120)`. Body: conteggio siti convertiti/esclusi per area, artefatti noti a AX5, puntatore alla sezione doc per la verifica manuale. Chiude #120 (dopo acceptance manuale utente su tutte e tre le stage). Push `massilp`; merge utente.

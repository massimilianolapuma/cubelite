# Accessibility #120 — stage 2: VoiceOver + keyboard traversal (design)

Date: 2026-08-09 · Scope: macOS app · Second of three staged PRs for #120
(stage 1 = contrast, merged as #341; stage 3 = Dynamic Type).

## Goal

Every interactive element exposes a meaningful VoiceOver label and correct
traits, and the whole app is operable with full keyboard access — no trackpad.
Acceptance (issue #120): Accessibility Inspector audit with 0 critical issues +
manual VoiceOver pass, both performed by the user on the PR build.

## Inventory (audited 2026-08-09)

~85 standard controls (Button/Toggle/Picker/Menu) across ~20 view files —
these are keyboard-focusable for free; the work is labels/traits on icon-only
and symbol-only controls. Four `onTapGesture` sites are true keyboard gaps
(invisible to focus): PodListView (logs chip), CommandPaletteView (result
rows), LogTabStrip (tab select), MainView+Sidebar. 6 existing focus usages,
10 keyboard shortcuts.

## Conventions (the rulebook every change follows)

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
   `<area>.<element>` (e.g. `logpanel.follow`) — groundwork for future UITests.
7. **Focus**: keep native traversal; add `@FocusState`/`.focused` only where a
   flow demands it (palette opens → search field focused; Esc returns focus to
   the invoking control where determinable). No custom tab-order overrides.

## Delivery

One PR, three sweep tasks by area (shell chrome; list/detail views; log panel +
preferences + dialogs), each applying the conventions to its files, plus the
four `onTapGesture` conversions in whichever area owns them. Conventions doc
committed as `docs/a11y/voiceover-keyboard.md` (rules above + per-area notes +
manual-verification checklist for the user).

## Verification

- Automated: both suites green (behavior-preserving changes; converted buttons
  keep the same action closures — existing interaction tests must not change).
  SwiftUI accessibility attributes are not unit-testable without UI tests —
  the suites guard against regressions, not label presence.
- Manual (user, on the PR build): Accessibility Inspector audit per main
  screen (target: 0 critical), VoiceOver walk of: cluster switch → pod list →
  drawer → log panel (open, search, export) → preferences; full keyboard-only
  session of the same flow (checklist in the doc).

## Out of scope

Dynamic Type (stage 3), UITests automation, desktop app (Svelte a11y is a
separate effort), custom rotor/actions beyond labels+traits+focus.

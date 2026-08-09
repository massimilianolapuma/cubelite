# Accessibility #120 — stage 3: Dynamic Type (design)

Date: 2026-08-09 · Scope: macOS app · Last of three staged PRs for #120
(stage 1 = contrast #341, stage 2 = VoiceOver/keyboard #342).

## Goal

Primary text scales with the system accessibility text size up to AX5
(issue #120: "Dynamic Type support up to AX5 in primary text"). On macOS this
tracks System Settings → Accessibility → Display → Text size (macOS 14+);
SwiftUI's `@ScaledMetric` follows it.

## Current state

~109 call sites use `.font(.system(size: N, weight:, design:))` with fixed
sizes (dominant: 11pt ×35, 10pt ×15, 12pt ×10; range 7–14). Zero
`@ScaledMetric`/`relativeTo` usage. Sizes are design-system values — they must
be preserved exactly at the default text size.

## Decision: `scaledFont` modifier

One new view modifier wrapping `@ScaledMetric`:

```swift
struct ScaledFontModifier: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let weight: Font.Weight
    private let design: Font.Design
    init(size: CGFloat, weight: Font.Weight, design: Font.Design,
         relativeTo style: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
        self.design = design
    }
    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }
}
extension View {
    func scaledFont(size: CGFloat, weight: Font.Weight = .regular,
                    design: Font.Design = .default,
                    relativeTo style: Font.TextStyle = .body) -> some View
}
```

At default text size, `@ScaledMetric` returns the wrapped value unchanged —
pixel-identical rendering. Under larger accessibility sizes it scales along the
anchor style's curve. Anchor buckets: size ≥ 13 → `.title3`; 10.5–12.9 →
`.body` (default); ≤ 10.4 → `.caption` — keeps small labels from outgrowing
their role.

The sweep is mechanical: `.font(.system(size: X, weight: W, design: D))` →
`.scaledFont(size: X, weight: W, design: D[, relativeTo: bucket])`.

## Scope

**In (primary text):** list/table rows, detail views, headers/toolbars,
sidebar, palette, preferences, dialogs, banners, status bar, menu bar extra.

**Out (stay fixed, documented):**
- Log panel body (`LogLineRow` timestamp/severity/source/message columns and
  the toolbar's monospised data chips): fixed-density monospace grid by
  design decision (stage-2 approved); fixed column widths (94/52/42pt) would
  truncate under scaling. The log SEARCH field and toolbar button labels DO
  scale (they're chrome, not grid).
- Identity initials in rail avatars (fixed 2-letter badges in fixed circles).
- Decorative/graphic glyphs already `accessibilityHidden`.

**Layout guard:** where scaled text sits inside a fixed-width frame, the sweep
does not restructure layouts; rows rely on SwiftUI's natural growth. Known
acceptable artifact at AX5: some table columns truncate (tail) — acceptable
for this stage, noted in the doc. Egregious breakage found during the sweep
(clipped to unreadable) is fixed case-by-case with `minWidth`/`lineLimit`
relaxation and reported.

## Verification

- Unit: modifier returns the exact input size at default `dynamicTypeSize`
  (rendering-level assertions aren't feasible in XCTest without UI tests; the
  test asserts the modifier's stored properties/mapping — plus build gates).
- Full suites green (behavior-preserving at default size).
- Manual (user, PR build): System Settings text size at max (AX-equivalent) —
  walk the stage-2 checklist screens; primary text scales, no unreadable
  clipping; log grid intentionally fixed. Checklist appended to
  `docs/a11y/voiceover-keyboard.md` (same doc, new section).

## Out of scope

Desktop app, log grid density modes, per-window text scaling, stage-2
follow-ups (dead-code cleanup, palette AX focus).

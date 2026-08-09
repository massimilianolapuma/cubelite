import SwiftUI

// MARK: - Dynamic Type scaled font

/// Wraps `.font(.system(size:weight:design:))` in `@ScaledMetric` so primary
/// text scales with the system accessibility text size (macOS 14+, System
/// Settings → Accessibility → Display → Text size) while staying
/// pixel-identical to the fixed-size rendering at the default text size.
///
/// See `docs/superpowers/specs/2026-08-09-a11y-dynamic-type-design.md`.
struct ScaledFontModifier: ViewModifier {
    @ScaledMetric var size: CGFloat
    let weight: Font.Weight
    let design: Font.Design

    init(size: CGFloat, weight: Font.Weight, design: Font.Design,
         relativeTo style: Font.TextStyle) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight
        self.design = design
    }

    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: weight, design: design))
    }

    /// Maps a fixed point size to the Dynamic Type anchor style that drives
    /// its scaling curve, so small labels don't outgrow their role.
    ///
    /// - `size >= 13` → `.title3`
    /// - `10.5...12.9` → `.body` (default)
    /// - `size <= 10.4` → `.caption`
    static func anchor(for size: CGFloat) -> Font.TextStyle {
        if size >= 13 {
            return .title3
        } else if size >= 10.5 {
            return .body
        } else {
            return .caption
        }
    }
}

extension View {
    /// Applies a Dynamic Type-aware font: pixel-identical to
    /// `.font(.system(size:weight:design:))` at the default text size, and
    /// scaling along `relativeTo`'s curve under larger accessibility text
    /// sizes.
    func scaledFont(
        size: CGFloat,
        weight: Font.Weight = .regular,
        design: Font.Design = .default,
        relativeTo style: Font.TextStyle = .body
    ) -> some View {
        modifier(ScaledFontModifier(size: size, weight: weight, design: design, relativeTo: style))
    }
}

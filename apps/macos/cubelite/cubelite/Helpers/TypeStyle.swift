import SwiftUI

// MARK: - Design-system text styles

/// Applies a `DesignTokens.Typography.Style`: bundled Geist / Geist Mono via
/// `AppFont`, size scaled with `@ScaledMetric` along the same anchor buckets
/// as `scaledFont`, plus tracking and uppercase when the token asks for them.
struct TypeStyleModifier: ViewModifier {
    @ScaledMetric var size: CGFloat
    let style: DesignTokens.Typography.Style
    let anchor: Font.TextStyle

    init(style: DesignTokens.Typography.Style) {
        let anchor = ScaledFontModifier.anchor(for: style.size)
        _size = ScaledMetric(wrappedValue: style.size, relativeTo: anchor)
        self.style = style
        self.anchor = anchor
    }

    /// Letter spacing in points at the current (scaled) size.
    var trackingPoints: CGFloat { style.tracking * size }

    /// `.uppercase` for section/colhead styles, nil otherwise (inherit).
    var textCase: Text.Case? { style.uppercase ? .uppercase : nil }

    func body(content: Content) -> some View {
        content
            .font(AppFont.font(mono: style.mono, weight: style.weight, size: size))
            .tracking(trackingPoints)
            .textCase(textCase)
    }
}

/// Applies `color` only when provided, so `typeStyle` never clobbers an
/// inherited foreground style.
private struct OptionalForeground: ViewModifier {
    let color: Color?

    @ViewBuilder
    func body(content: Content) -> some View {
        if let color {
            content.foregroundStyle(color)
        } else {
            content
        }
    }
}

extension View {
    /// Design-system text style (Geist / Geist Mono, Dynamic Type scaled).
    ///
    ///     Text("Pods").typeStyle(DesignTokens.Typography.subtitle)
    ///     Text("107").typeStyle(DesignTokens.Typography.stat, color: DesignTokens.textDataBright)
    func typeStyle(_ style: DesignTokens.Typography.Style, color: Color? = nil) -> some View {
        modifier(TypeStyleModifier(style: style)).modifier(OptionalForeground(color: color))
    }
}

// MARK: - Style variants

extension DesignTokens.Typography.Style {
    /// The same style in Geist Mono — desktop `type-* font-mono`.
    var monospaced: Self {
        Self(size: self.size, weight: self.weight, mono: true,
             uppercase: self.uppercase, tracking: self.tracking)
    }

    /// The same style at another weight — desktop `type-* font-semibold`.
    func weighted(_ newWeight: Font.Weight) -> Self {
        Self(size: self.size, weight: newWeight, mono: self.mono,
             uppercase: self.uppercase, tracking: self.tracking)
    }
}

// MARK: - Icon sizes

extension View {
    /// SF Symbol glyph (or badge digits) at a design-system icon size
    /// (`DesignTokens.icon*`), Dynamic Type scaled like `scaledFont`.
    ///
    ///     Image(systemName: "chevron.down").iconSize(DesignTokens.iconXs)
    func iconSize(_ size: CGFloat, weight: Font.Weight = .regular) -> some View {
        scaledFont(size: size, weight: weight, relativeTo: ScaledFontModifier.anchor(for: size))
    }
}

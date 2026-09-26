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

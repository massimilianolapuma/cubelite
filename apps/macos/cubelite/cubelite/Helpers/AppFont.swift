import AppKit
import SwiftUI

// MARK: - Bundled Geist families

/// Access to the Geist / Geist Mono weights shipped in `Resources/Fonts`
/// (registered by `ATSApplicationFontsPath`). The design system uses only
/// 400 / 500 / 600; other weights clamp to the nearest bundled file.
///
/// Falls back to the SF system font when the bundle is unavailable (Xcode
/// previews, missing resource), so text never disappears.
enum AppFont {

    /// PostScript name of the bundled weight closest to `weight`.
    nonisolated static func postScriptName(mono: Bool, weight: Font.Weight) -> String {
        let family = mono ? "GeistMono" : "Geist"
        switch weight {
        case .ultraLight, .thin, .light, .regular:
            return "\(family)-Regular"
        case .medium:
            return "\(family)-Medium"
        default:  // .semibold, .bold, .heavy, .black
            return "\(family)-SemiBold"
        }
    }

    /// True once CoreText can resolve the bundled regular weight.
    static let isAvailable: Bool = NSFont(name: "Geist-Regular", size: 13) != nil

    /// Geist / Geist Mono at `size`, or the SF equivalent when unavailable.
    static func font(mono: Bool, weight: Font.Weight, size: CGFloat) -> Font {
        guard isAvailable else {
            return .system(size: size, weight: weight, design: mono ? .monospaced : .default)
        }
        return .custom(postScriptName(mono: mono, weight: weight), size: size)
    }
}

import SwiftUI

// MARK: - Cluster Identity (Design System v1)
//
// Stable per-cluster identity color and avatar initials, mirroring the
// desktop app's cluster-identity assignment (first-appearance order over
// the five-color palette). Identity ≠ health: health is always a separate
// dot/badge.

enum ClusterIdentity {

    /// The identity palette from the design tokens, in assignment order.
    static let palette: [Color] = [
        DesignTokens.clusterBlue,
        DesignTokens.clusterAmber,
        DesignTokens.clusterPink,
        DesignTokens.clusterViolet,
        DesignTokens.clusterTeal,
    ]

    /// Identity color for `context`, assigned by first-appearance order in
    /// `contexts` and cycling when the palette is exhausted.
    static func color(for context: String, in contexts: [String]) -> Color {
        guard let index = contexts.firstIndex(of: context) else {
            return palette[0]
        }
        return palette[index % palette.count]
    }

    /// Two-character avatar initials (e.g. `"prod-eu-1"` → `"PE"`).
    static func initials(for name: String) -> String {
        let parts = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        if parts.count >= 2, let a = parts[0].first, let b = parts[1].first {
            return String([a, b]).uppercased()
        }
        if let first = parts.first {
            return String(first.prefix(2)).uppercased()
        }
        return "?"
    }
}

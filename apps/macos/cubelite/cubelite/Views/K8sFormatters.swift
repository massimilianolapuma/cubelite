import SwiftUI

// MARK: - Age Formatting

extension Optional where Wrapped == String {
    /// Converts an optional ISO 8601 timestamp to a human-readable Kubernetes age string.
    ///
    /// Returns compact strings like `"3d"`, `"12h"`, `"5m"`, `"42s"`, or `"—"` when
    /// the value is `nil` or cannot be parsed as a valid ISO 8601 date.
    var k8sAge: String {
        guard let iso = self else { return "—" }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let createdAt = date else { return "—" }
        let elapsed = Int(Date().timeIntervalSince(createdAt))
        if elapsed < 60 { return "\(elapsed)s" }
        if elapsed < 3_600 { return "\(elapsed / 60)m" }
        if elapsed < 86_400 { return "\(elapsed / 3_600)h" }
        return "\(elapsed / 86_400)d"
    }
}

// MARK: - Pod Phase Color

extension Color {
    /// Returns the display colour for a given Kubernetes pod phase string.
    ///
    /// | Phase       | Color        |
    /// |-------------|--------------|
    /// | `Running`   | `.green`     |
    /// | `Pending`   | `.orange`    |
    /// | `Succeeded` | `.blue`      |
    /// | `Failed`    | `.red`       |
    /// | *(other)*   | `.secondary` |
    static func podPhase(_ phase: String?) -> Color {
        switch phase {
        case "Running":   return .green
        case "Pending":   return .orange
        case "Succeeded": return .blue
        case "Failed":    return .red
        default:          return .secondary
        }
    }
}

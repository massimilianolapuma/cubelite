import SwiftUI

// MARK: - Age Formatting

private enum K8sDateFormatters {
    nonisolated(unsafe) static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) static let standard: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        return f
    }()
}

extension Optional where Wrapped == String {
    /// Converts an optional ISO 8601 timestamp to a human-readable Kubernetes age string.
    ///
    /// Returns compact strings like `"3d"`, `"12h"`, `"5m"`, `"42s"`, or `"—"` when
    /// the value is `nil` or cannot be parsed as a valid ISO 8601 date.
    var k8sAge: String {
        guard let iso = self else { return "—" }
        let date = K8sDateFormatters.fractional.date(from: iso) ?? K8sDateFormatters.standard.date(from: iso)
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
    /// Returns the display colour for a given Kubernetes pod phase string,
    /// mapped onto the Design System v1 status palette.
    ///
    /// | Phase       | Token             |
    /// |-------------|-------------------|
    /// | `Running`   | `statusOk`        |
    /// | `Pending`   | `statusWarn`      |
    /// | `Succeeded` | `statusInfo`      |
    /// | `Failed`    | `statusErr`       |
    /// | *(other)*   | `textTertiary`    |
    static func podPhase(_ phase: String?) -> Color {
        switch phase {
        case "Running":   return DesignTokens.statusOk
        case "Pending":   return DesignTokens.statusWarn
        case "Succeeded": return DesignTokens.statusInfo
        case "Failed":    return DesignTokens.statusErr
        default:          return DesignTokens.textTertiary
        }
    }

    /// Returns the display colour for a Kubernetes deployment condition
    /// status string, mapped onto the Design System v1 status palette.
    ///
    /// | Status    | Token        |
    /// |-----------|--------------|
    /// | `True`    | `statusOk`   |
    /// | `False`   | `statusErr`  |
    /// | *(other)* | `statusWarn` |
    static func conditionStatus(_ status: String) -> Color {
        switch status {
        case "True":  return DesignTokens.statusOk
        case "False": return DesignTokens.statusErr
        default:      return DesignTokens.statusWarn
        }
    }
}

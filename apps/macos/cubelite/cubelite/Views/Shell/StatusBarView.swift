import SwiftUI

/// 27pt status bar (Design System v1, parity v2 §3): server URL, cluster
/// version and auto-refresh interval on the left; clickable warning-event
/// and unread-error counts on the right.
struct StatusBarView: View {

    let serverURL: String?
    let clusterVersion: String?
    let autoRefreshInterval: Int
    let warningCount: Int
    let unreadErrorCount: Int
    let onShowEvents: () -> Void
    let onShowDiagnostics: () -> Void

    // MARK: - Labels

    /// `refresh off` / `refresh 1m` / `refresh Ns`, as on the desktop.
    nonisolated static func refreshLabel(interval: Int) -> String {
        switch interval {
        case 0: "refresh off"
        case 60: "refresh 1m"
        default: "refresh \(interval)s"
        }
    }

    /// `k8s v1.30.2`, or nil when the version is unknown.
    nonisolated static func versionLabel(_ version: String?) -> String? {
        guard let version, !version.isEmpty else { return nil }
        return "k8s \(version)"
    }

    /// `N warning(s)`, or nil when there are none.
    nonisolated static func warningLabel(count: Int) -> String? {
        count > 0 ? "\(count) warning\(count == 1 ? "" : "s")" : nil
    }

    /// `N error(s)`, or nil when there are none.
    nonisolated static func errorLabel(count: Int) -> String? {
        count > 0 ? "\(count) error\(count == 1 ? "" : "s")" : nil
    }

    // MARK: - Body

    var body: some View {
        HStack(spacing: 16) {
            if let serverURL, !serverURL.isEmpty {
                label(serverURL)
                    .truncationMode(.middle)
                    .accessibilityIdentifier("statusbar.server")
            }
            if let version = Self.versionLabel(clusterVersion) {
                label(version)
                    .fixedSize()
                    .accessibilityIdentifier("statusbar.version")
            }
            label(Self.refreshLabel(interval: autoRefreshInterval))
                .fixedSize()
            Spacer(minLength: 0)
            if let warnings = Self.warningLabel(count: warningCount) {
                Button(action: onShowEvents) {
                    label(warnings, color: DesignTokens.statusWarn)
                }
                .buttonStyle(.plain)
                .fixedSize()
                .help("Show events")
                .accessibilityIdentifier("statusbar.warnings")
            }
            if let errors = Self.errorLabel(count: unreadErrorCount) {
                Button(action: onShowDiagnostics) {
                    label(errors, color: DesignTokens.statusErr)
                }
                .buttonStyle(.plain)
                .fixedSize()
                .help("Show diagnostics")
                .accessibilityIdentifier("statusbar.errors")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 27)
        .background(DesignTokens.surfacePanel)
        .overlay(alignment: .top) {
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
        }
    }

    private func label(_ text: String, color: Color = DesignTokens.textTertiary) -> some View {
        Text(text)
            .typeStyle(DesignTokens.Typography.micro.monospaced, color: color)
            .lineLimit(1)
    }
}

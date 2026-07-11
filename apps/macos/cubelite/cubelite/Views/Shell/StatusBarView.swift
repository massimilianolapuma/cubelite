import SwiftUI

/// 27pt status bar (Design System v1): auto-refresh interval on the left,
/// clickable unread-error count on the right.
struct StatusBarView: View {

    let autoRefreshInterval: Int
    let unreadErrorCount: Int
    let onShowLogs: () -> Void

    private var refreshLabel: String {
        switch autoRefreshInterval {
        case 0: "refresh off"
        case 60: "refresh 1m"
        default: "refresh \(autoRefreshInterval)s"
        }
    }

    var body: some View {
        HStack(spacing: 16) {
            Text(refreshLabel)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(DesignTokens.textTertiary)
            Spacer(minLength: 0)
            if unreadErrorCount > 0 {
                Button(action: onShowLogs) {
                    Text("\(unreadErrorCount) error\(unreadErrorCount == 1 ? "" : "s")")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(DesignTokens.statusWarn)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 27)
        .background(DesignTokens.surfacePanel)
        .overlay(alignment: .top) {
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
        }
    }
}

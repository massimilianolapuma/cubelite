import SwiftUI

/// Strip above the History body (#503): hit count and range, "load older",
/// progress, and a search error when lines are already shown.
struct HistoryStripView: View {

    let history: LogHistory

    var body: some View {
        HStack(spacing: 8) {
            if history.isLoading {
                ProgressView()
                    .controlSize(.mini)
                    .accessibilityLabel("Searching Elasticsearch")
            }
            if let error = history.error, !history.lines.isEmpty {
                Text(error)
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.statusErr)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(error)
                    .accessibilityIdentifier("logpanel.history-error")
            } else {
                Text(history.statusText)
                    .typeStyle(DesignTokens.Typography.caption.monospaced, color: DesignTokens.textTertiary)
                    .accessibilityIdentifier("logpanel.history-status")
            }
            Spacer()
            if history.lines.count >= LogHistory.cap {
                Text("showing the newest \(LogHistory.cap.formatted()) lines")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
            } else if history.next != nil {
                Button("load older") {
                    Task { await history.loadOlder() }
                }
                .buttonStyle(.plain)
                .typeStyle(DesignTokens.Typography.caption.weighted(.medium), color: DesignTokens.accentDefault)
                .disabled(!history.canLoadOlder)
                .accessibilityLabel("Load older log lines")
                .accessibilityIdentifier("logpanel.history-older")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 24)
        .background(DesignTokens.surfaceRaised)
        .overlay(alignment: .bottom) {
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
        }
    }
}

import SwiftUI

/// Inline banner shown when new errors have been recorded in ``LogStore``.
///
/// Displays a compact red-tinted bar with an exclamation icon, a short
/// message, and a "View Logs →" button that triggers `onViewLogs`.
struct ErrorBannerView: View {

    /// Short error message to display.
    let message: String
    /// Called when the user taps the "View Logs" button.
    let onViewLogs: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            bannerIcon
            bannerMessage
            Spacer(minLength: 8)
            viewLogsButton
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .background(Color.red.opacity(0.10))
        .overlay(alignment: .bottom) { Divider() }
    }

    // MARK: - Sub-views

    private var bannerIcon: some View {
        Image(systemName: "exclamationmark.circle.fill")
            .foregroundStyle(.red)
    }

    private var bannerMessage: some View {
        Text(message)
            .lineLimit(1)
            .truncationMode(.tail)
            .foregroundStyle(.primary)
    }

    private var viewLogsButton: some View {
        Button("View Logs →", action: onViewLogs)
            .buttonStyle(.borderless)
            .foregroundStyle(.red)
    }
}

// MARK: - Preview

#Preview {
    ErrorBannerView(
        message: "Failed to connect to cluster: connection timeout",
        onViewLogs: {}
    )
    .frame(width: 400)
}

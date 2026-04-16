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

    @Environment(\.colorScheme) private var colorScheme

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
        .background(Color.red.opacity(colorScheme == .dark ? 0.08 : 0.06))
        .overlay(alignment: .bottom) {
            Color.red.opacity(0.35).frame(height: 1)
        }
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
            .foregroundStyle(.red)
    }

    private var viewLogsButton: some View {
        Button("View Logs →", action: onViewLogs)
            .buttonStyle(.borderless)
            .foregroundStyle(.tint)
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

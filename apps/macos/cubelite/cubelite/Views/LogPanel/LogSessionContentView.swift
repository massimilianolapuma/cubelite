import SwiftUI

/// Everything a log session shows below the tab strip: toolbar, reconnect
/// banner, log body. Shared verbatim between the bottom panel and the
/// detached pop-out window (#298) — panel-only chrome (resize handle, tab
/// strip, collapse) stays in `LogPanelView`.
struct LogSessionContentView: View {

    let session: LogSession
    /// Panel mode pins the body to the store's panel height; window mode
    /// passes nil and the body fills the window.
    let bodyHeight: Double?

    var body: some View {
        VStack(spacing: 0) {
            LogToolbar(session: session)
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
            if session.isReconnecting {
                reconnectBanner(session)
            }
            if let bodyHeight {
                LogBodyView(session: session)
                    .frame(height: bodyHeight)
            } else {
                LogBodyView(session: session)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private func reconnectBanner(_ session: LogSession) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
                .modifier(PulseEffect())
                .accessibilityHidden(true)
            Text(
                "stream lost — reconnecting (attempt \(session.reconnectAttempt), "
                    + "next retry \(session.nextRetrySeconds)s)"
            )
            .scaledFont(size: 11, design: .monospaced)
            .foregroundStyle(DesignTokens.statusWarn)
            Spacer()
            Button("retry now") { session.retryNow() }
                .buttonStyle(.plain)
                .scaledFont(size: 11, weight: .medium)
                .foregroundStyle(DesignTokens.statusWarn)
                .underline()
                .accessibilityLabel("Retry connection now")
                .accessibilityIdentifier("logpanel.reconnect-retry")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(DesignTokens.statusWarn.opacity(0.08))
        .overlay(alignment: .bottom) {
            Rectangle().fill(DesignTokens.statusWarn.opacity(0.25)).frame(height: 1)
        }
    }
}

/// Slow opacity pulse for the reconnect banner's status dot.
private struct PulseEffect: ViewModifier {
    @State private var dimmed = false

    func body(content: Content) -> some View {
        content
            .opacity(dimmed ? 0.35 : 1)
            .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true), value: dimmed)
            .onAppear { dimmed = true }
    }
}

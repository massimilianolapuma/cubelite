import SwiftUI

/// True inside a detached pop-out log window; the toolbar uses it to swap
/// the detach button (`⧉`, panel-only) for the window's re-attach header.
private struct DetachedLogContextKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var isDetachedLogContext: Bool {
        get { self[DetachedLogContextKey.self] }
        set { self[DetachedLogContextKey.self] = newValue }
    }
}

/// Root view of a popped-out log session window (#298): minimal header
/// (pod/container + re-attach) above the shared session content. Binds the
/// same `LogSession` object as the panel — the stream never restarts.
/// Closing the window by any means re-attaches the tab to the panel; the
/// window dismisses itself if the session is closed elsewhere.
struct DetachedLogWindowView: View {

    @Environment(LogSessionStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let sessionID: String?

    var body: some View {
        if let sessionID,
            let session = store.sessions.first(where: { $0.pod.id == sessionID }) {
            VStack(spacing: 0) {
                header(session)
                Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                LogSessionContentView(session: session, bodyHeight: nil)
            }
            .background(DesignTokens.surfacePanel)
            .environment(\.isDetachedLogContext, true)
            .navigationTitle("\(session.pod.name) — logs")
            .overlay(alignment: .bottomTrailing) {
                if let toast = store.toast {
                    LogToastOverlay(message: toast)
                }
            }
            // Any close path (⌘W, traffic light, ⏷) lands here; reattach is
            // a no-op when the ⏷ button already did it or the session is gone.
            .onDisappear { store.reattach(sessionID: sessionID) }
        } else {
            // Session closed elsewhere (close-all, pod deleted) or nil
            // restoration value: the window has nothing to show.
            Color.clear.onAppear { dismiss() }
        }
    }

    private func header(_ session: LogSession) -> some View {
        HStack(spacing: 7) {
            Circle()
                .fill(session.pod.ready ? DesignTokens.statusOk : DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
                .accessibilityHidden(true)
            Text(session.pod.name)
                .scaledFont(size: 11, weight: .medium, design: .monospaced)
                .foregroundStyle(DesignTokens.textDataBright)
                .lineLimit(1)
                .truncationMode(.middle)
            if let container = session.selectedContainer {
                Text(session.isMerged ? "all containers" : container)
                    .scaledFont(size: 10, design: .monospaced, relativeTo: .caption)
                    .foregroundStyle(DesignTokens.textTertiary)
                    .lineLimit(1)
            }
            Spacer()
            Button {
                store.reattach(sessionID: session.pod.id)
                dismiss()
            } label: {
                Image(systemName: "arrow.down.backward.square")
                    .scaledFont(size: 11)
                    .foregroundStyle(DesignTokens.textSecondary)
                    .frame(width: 26)
                    .frame(minHeight: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Return this session to the log panel")
            .accessibilityLabel("Return to log panel")
            .accessibilityIdentifier("logwindow.reattach")
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 34)
        .background(DesignTokens.surfaceRaised)
    }
}

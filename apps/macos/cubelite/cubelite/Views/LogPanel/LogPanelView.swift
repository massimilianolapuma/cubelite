import AppKit
import SwiftUI

/// Persistent bottom log panel: resize handle, session tab strip, toolbar,
/// log body. Collapses to the 34pt strip (⌘L). Hidden when no session is
/// open.
struct LogPanelView: View {

    @Environment(LogSessionStore.self) private var store

    @State private var dragStartHeight: Double?

    var body: some View {
        if let session = store.activeSession {
            VStack(spacing: 0) {
                resizeHandle
                LogTabStrip()
                if !store.isCollapsed {
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    LogToolbar(session: session)
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    if session.isReconnecting {
                        reconnectBanner(session)
                    }
                    LogBodyView(session: session)
                        .frame(height: store.panelHeight)
                }
            }
            .background(DesignTokens.surfacePanel)
            .overlay(alignment: .bottomTrailing) {
                if let toast = store.toast {
                    Text(toast)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundStyle(DesignTokens.textLog)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(DesignTokens.surfaceOverlay)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(DesignTokens.borderStrong, lineWidth: 1))
                        .padding(12)
                        .transition(.opacity)
                }
            }
        }
    }

    private func reconnectBanner(_ session: LogSession) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
                .modifier(PulseEffect())
            Text(
                "stream lost — reconnecting (attempt \(session.reconnectAttempt), "
                    + "next retry \(session.nextRetrySeconds)s)"
            )
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(DesignTokens.statusWarn)
            Spacer()
            Button("retry now") { session.retryNow() }
                .buttonStyle(.plain)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(DesignTokens.statusWarn)
                .underline()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(DesignTokens.statusWarn.opacity(0.08))
        .overlay(alignment: .bottom) {
            Rectangle().fill(DesignTokens.statusWarn.opacity(0.25)).frame(height: 1)
        }
    }

    /// 6pt grab zone on the top edge; dragging up grows the panel.
    private var resizeHandle: some View {
        Rectangle()
            .fill(DesignTokens.borderStrong)
            .frame(height: 1)
            .padding(.vertical, 2.5)
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeUpDown.push()
                } else {
                    NSCursor.pop()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        if dragStartHeight == nil { dragStartHeight = store.panelHeight }
                        store.panelHeight = (dragStartHeight ?? 280) - value.translation.height
                    }
                    .onEnded { _ in dragStartHeight = nil }
            )
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

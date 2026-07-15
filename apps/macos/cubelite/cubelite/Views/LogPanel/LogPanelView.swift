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

import SwiftUI

/// One tab per open log session; right side hosts the active session's
/// line count and the collapse control (⌘L).
struct LogTabStrip: View {

    @Environment(LogSessionStore.self) private var store

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(store.sessions, id: \.pod.id) { session in
                        tab(session)
                    }
                }
            }
            Spacer(minLength: 8)
            if let active = store.activeSession {
                Text(lineCountLabel(active))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .lineLimit(1)
            }
            Button {
                store.isCollapsed.toggle()
            } label: {
                Image(systemName: store.isCollapsed ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("l", modifiers: .command)
            .accessibilityLabel(store.isCollapsed ? "Expand log panel" : "Collapse log panel")
            .padding(.leading, 8)
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(DesignTokens.surfaceRaised)
    }

    private func tab(_ session: LogSession) -> some View {
        let isActive = session.pod.id == store.activeSessionID
        return HStack(spacing: 7) {
            Circle()
                .fill(session.pod.ready ? DesignTokens.statusOk : DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
            Text(session.pod.name)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(
                    isActive ? DesignTokens.textDataBright : DesignTokens.textTertiary
                )
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 190)
            if let container = session.selectedContainer {
                Text(container)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .lineLimit(1)
            }
            Button {
                store.close(sessionID: session.pod.id)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 8))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close \(session.pod.name) logs")
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(isActive ? DesignTokens.surfacePanel : .clear)
        .overlay(alignment: .top) {
            if isActive {
                Rectangle().fill(DesignTokens.accentDefault).frame(height: 2)
            }
        }
        .overlay(alignment: .trailing) {
            Rectangle().fill(DesignTokens.borderFaint).frame(width: 1)
        }
        .contentShape(Rectangle())
        .onTapGesture { store.activeSessionID = session.pod.id }
    }

    private func lineCountLabel(_ session: LogSession) -> String {
        let visible = session.buffer.lines.count
        let total = session.buffer.totalAppended
        return total > visible ? "\(visible) lines · \(total) buffered" : "\(visible) lines"
    }
}

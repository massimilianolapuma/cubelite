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
                    .scaledFont(size: 10, relativeTo: .caption)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("l", modifiers: .command)
            .accessibilityLabel(store.isCollapsed ? "Expand log panel" : "Collapse log panel")
            .accessibilityIdentifier("logpanel.collapse")
            .padding(.leading, 8)
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(DesignTokens.surfaceRaised)
    }

    private func tab(_ session: LogSession) -> some View {
        let isActive = session.pod.id == store.activeSessionID
        return HStack(spacing: 7) {
            Button {
                store.activeSessionID = session.pod.id
            } label: {
                HStack(spacing: 7) {
                    Circle()
                        .fill(session.pod.ready ? DesignTokens.statusOk : DesignTokens.statusWarn)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                    Text(session.pod.name)
                        .scaledFont(size: 11, weight: .medium, design: .monospaced)
                        .foregroundStyle(
                            isActive ? DesignTokens.textDataBright : DesignTokens.textTertiary
                        )
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 190)
                    if let container = session.selectedContainer {
                        Text(container)
                            .scaledFont(size: 10, design: .monospaced, relativeTo: .caption)
                            .foregroundStyle(DesignTokens.textTertiary)
                            .lineLimit(1)
                    }
                }
                // Leading padding + full row height live on the label so the
                // button's hit area covers the padded region, not just the
                // circle/text's intrinsic size — contentShape must come
                // after them to pick up the padded frame.
                .padding(.leading, 12)
                .frame(height: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(tabAccessibilityLabel(session))
            .accessibilityValue(isActive ? "Active tab" : "")
            .accessibilityIdentifier("logpanel.tab-\(session.pod.name)")

            Button {
                store.close(sessionID: session.pod.id)
            } label: {
                Image(systemName: "xmark")
                    .scaledFont(size: 8, relativeTo: .caption)
                    .foregroundStyle(DesignTokens.textTertiary)
                    .padding(.trailing, 12)
                    .frame(height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close \(session.pod.name) logs")
            .accessibilityIdentifier("logpanel.tab-close-\(session.pod.name)")
        }
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
    }

    private func tabAccessibilityLabel(_ session: LogSession) -> String {
        var parts = [session.pod.name]
        if let container = session.selectedContainer {
            parts.append("container \(container)")
        }
        parts.append(session.pod.ready ? "ready" : "not ready")
        return parts.joined(separator: ", ")
    }

    private func lineCountLabel(_ session: LogSession) -> String {
        let visible = session.buffer.lines.count
        let total = session.buffer.totalAppended
        return total > visible ? "\(visible) lines · \(total) buffered" : "\(visible) lines"
    }
}

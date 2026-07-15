import SwiftUI

/// Persistent bottom log panel (single session): header strip, toolbar,
/// log body. Collapses to the 34pt strip. Hidden when no session is open.
struct LogPanelView: View {

    @Environment(LogSessionStore.self) private var store

    var body: some View {
        if let session = store.session {
            VStack(spacing: 0) {
                Rectangle().fill(DesignTokens.borderStrong).frame(height: 1)
                headerStrip(session)
                if !store.isCollapsed {
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    LogToolbar(session: session)
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                    LogBodyView(session: session)
                        .frame(height: 280)
                }
            }
            .background(DesignTokens.surfacePanel)
        }
    }

    private func headerStrip(_ session: LogSession) -> some View {
        HStack(spacing: 8) {
            Circle()
                .fill(session.pod.ready ? DesignTokens.statusOk : DesignTokens.statusWarn)
                .frame(width: 7, height: 7)
            Text(session.pod.name)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundStyle(DesignTokens.textDataBright)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: 190, alignment: .leading)
            if let container = session.selectedContainer {
                Text(container)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            Spacer()
            Text(lineCountLabel(session))
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(DesignTokens.textTertiary)
            Button {
                store.isCollapsed.toggle()
            } label: {
                Image(systemName: store.isCollapsed ? "chevron.up" : "chevron.down")
                    .font(.system(size: 10))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(store.isCollapsed ? "Expand log panel" : "Collapse log panel")
            Button {
                store.close()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close log panel")
        }
        .padding(.horizontal, 12)
        .frame(height: 34)
        .background(DesignTokens.surfaceRaised)
    }

    private func lineCountLabel(_ session: LogSession) -> String {
        let visible = session.buffer.lines.count
        let total = session.buffer.totalAppended
        return total > visible ? "\(visible) lines · \(total) buffered" : "\(visible) lines"
    }
}

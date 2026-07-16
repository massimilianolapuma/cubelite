import AppKit
import SwiftUI

/// Scrollable log body: severity-colored monospaced lines with optional
/// timestamp column; autoscrolls while following; wheel-up over the panel
/// pauses the follow (deployment target predates `onScrollPhaseChange`).
struct LogBodyView: View {

    @Environment(LogSessionStore.self) private var store
    let session: LogSession

    @State private var isHovering = false
    @State private var scrollMonitor: Any?

    private var visibleLines: [LogLine] {
        session.search.visibleLines(from: session.buffer.lines)
    }

    var body: some View {
        Group {
            if let error = session.streamError {
                UnifiedErrorState(title: "Log stream failed", message: error)
            } else if session.buffer.lines.isEmpty {
                emptyState
            } else if visibleLines.isEmpty {
                noMatchesState
            } else {
                logList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DesignTokens.surfaceSunken)
        .onHover { isHovering = $0 }
        .onAppear { installScrollMonitor() }
        .onDisappear { removeScrollMonitor() }
    }

    private var emptyState: some View {
        VStack(spacing: 4) {
            Text(session.hasCleared ? "buffer cleared" : "no logs yet")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(DesignTokens.textSecondary)
            Text(
                session.hasCleared
                    ? "stream is live — waiting for new lines"
                    : "waiting for the first line"
            )
            .font(.system(size: 11))
            .foregroundStyle(DesignTokens.textTertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var noMatchesState: some View {
        VStack(spacing: 4) {
            Text("no matches for “\(session.search.query)”")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(DesignTokens.textSecondary)
            Text("esc clears search · filter off shows all \(session.buffer.lines.count) lines")
                .font(.system(size: 11))
                .foregroundStyle(DesignTokens.textTertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var logList: some View {
        ScrollViewReader { proxy in
            ScrollView(store.wrapLines ? .vertical : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(visibleLines) { line in
                        LogLineRow(
                            line: line, showTimestamp: store.showTimestamps,
                            wrap: store.wrapLines,
                            searchQuery: session.search.isActive ? session.search.query : nil,
                            isActiveMatch: line.id == session.search.activeLineID)
                    }
                }
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: session.buffer.totalAppended) {
                session.search.recomputeDebounced(over: session.buffer.lines)
                if session.isFollowing, let last = session.buffer.lines.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            .onChange(of: session.search.query) {
                session.search.recomputeDebounced(over: session.buffer.lines)
            }
            .onChange(of: session.search.activeLineID) {
                if let id = session.search.activeLineID {
                    proxy.scrollTo(id, anchor: .center)
                }
            }
            .overlay(alignment: .bottom) {
                if !session.isFollowing, session.newLinesSincePause > 0 {
                    Button {
                        session.isFollowing = true
                        if let last = session.buffer.lines.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    } label: {
                        Text("↓ \(session.newLinesSincePause) new lines")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(DesignTokens.accentDefault)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 5)
                            .background(DesignTokens.surfaceOverlay)
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(DesignTokens.borderStrong, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 10)
                }
            }
        }
    }

    /// Scrolling up over the panel while following pauses the follow.
    private func installScrollMonitor() {
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            if isHovering, session.isFollowing, event.scrollingDeltaY > 0 {
                session.isFollowing = false
            }
            return event
        }
    }

    private func removeScrollMonitor() {
        if let scrollMonitor {
            NSEvent.removeMonitor(scrollMonitor)
            self.scrollMonitor = nil
        }
    }
}

/// One rendered log line.
struct LogLineRow: View {
    let line: LogLine
    let showTimestamp: Bool
    let wrap: Bool
    var searchQuery: String?
    var isActiveMatch = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if showTimestamp {
                Text(line.time ?? "—")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textTertiary)
                    .frame(width: 94, alignment: .leading)
            }
            Text(levelLabel)
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(levelColor)
                .frame(width: 42, alignment: .leading)
            Text(highlightedMessage)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(messageColor)
                .textSelection(.enabled)
                .lineLimit(wrap ? nil : 1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(rowTint)
        .id(line.id)
    }

    /// Message with every query occurrence tinted; the active match gets the
    /// solid warn treatment from the design.
    private var highlightedMessage: AttributedString {
        var attributed = AttributedString(line.message)
        guard let searchQuery, !searchQuery.isEmpty else { return attributed }
        var searchStart = attributed.startIndex
        while let range = attributed[searchStart...].range(
            of: searchQuery, options: .caseInsensitive)
        {
            attributed[range].backgroundColor =
                isActiveMatch ? DesignTokens.statusWarn : DesignTokens.accentDefault.opacity(0.3)
            if isActiveMatch {
                attributed[range].foregroundColor = DesignTokens.surfaceWindow
            }
            searchStart = range.upperBound
        }
        return attributed
    }

    private var levelLabel: String {
        switch line.level {
        case .debug: "DEBUG"
        case .info: "INFO"
        case .warn: "WARN"
        case .error: "ERROR"
        }
    }

    private var levelColor: Color {
        switch line.level {
        case .debug: DesignTokens.textTertiary
        case .info: DesignTokens.textLog
        case .warn: DesignTokens.statusWarn
        case .error: DesignTokens.statusErr
        }
    }

    private var messageColor: Color {
        switch line.level {
        case .warn: DesignTokens.statusWarn
        case .error: DesignTokens.statusErr
        default: DesignTokens.textLog
        }
    }

    private var rowTint: Color {
        switch line.level {
        case .error: DesignTokens.statusErr.opacity(0.07)
        case .warn: DesignTokens.statusWarn.opacity(0.045)
        default: .clear
        }
    }
}

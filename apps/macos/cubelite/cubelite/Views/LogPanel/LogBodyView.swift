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
        session.search.visibleLines(from: session.displayedLines)
    }

    var body: some View {
        Group {
            if session.showsHistory, let history = session.history, history.lines.isEmpty {
                HistoryEmptyState(history: history)
            } else if !session.showsHistory, let error = session.streamError {
                UnifiedErrorState(title: "Log stream failed", message: error)
            } else if session.displayedLines.isEmpty {
                emptyState
            } else if visibleLines.isEmpty {
                noMatchesState
            } else {
                logList
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(DesignTokens.surfaceSunken)
        // Recomputes live on the outer view: in filter mode with no match the
        // list is not on screen, and its handlers would never fire again.
        .onChange(of: session.buffer.totalAppended) {
            guard !session.showsHistory else { return }
            session.search.recomputeDebounced(over: session.displayedLines)
        }
        .onChange(of: session.search.query) {
            session.search.recomputeDebounced(over: session.displayedLines)
        }
        .onHover { isHovering = $0 }
        .onAppear { installScrollMonitor() }
        .onDisappear { removeScrollMonitor() }
    }

    private var emptyState: some View {
        VStack(spacing: 4) {
            Text(session.hasCleared ? "buffer cleared" : "no logs yet")
                .scaledFont(size: 12, weight: .medium, design: .monospaced)
                .foregroundStyle(DesignTokens.textSecondary)
            Text(
                session.hasCleared
                    ? "stream is live — waiting for new lines"
                    : "waiting for the first line"
            )
            .scaledFont(size: 11)
            .foregroundStyle(DesignTokens.textTertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var noMatchesState: some View {
        VStack(spacing: 4) {
            Text("no matches for “\(session.search.query)”")
                .scaledFont(size: 12, weight: .medium, design: .monospaced)
                .foregroundStyle(DesignTokens.textSecondary)
            Text("esc clears search · filter off shows all \(session.displayedLines.count) lines")
                .scaledFont(size: 11)
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
                            isActiveMatch: line.id == session.search.activeLineID,
                            sourceName: session.isMerged ? line.container : nil,
                            sourceColor: (session.isMerged ? line.container : nil).map {
                                ContainerIdentity.color(for: $0, in: session.containers)
                            },
                            mode: store.viewMode,
                            ecsMetadata: ECSDocument.Metadata(
                                namespace: session.pod.namespace, pod: session.pod.name,
                                container: session.isMerged ? nil : session.selectedContainer),
                            isExpanded: session.expandedLineIDs.contains(line.id),
                            onToggleExpanded: { session.toggleExpanded(line.id) }
                        )
                        .id(line.id)
                    }
                }
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: session.buffer.totalAppended) {
                guard !session.showsHistory else { return }
                if session.isFollowing, let last = session.buffer.lines.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            // A (re)load or a switch of source lands on the newest line;
            // "Load older" keeps the reading position.
            .onChange(of: session.history?.loads) { scrollToNewest(proxy) }
            .onChange(of: session.showsHistory) { scrollToNewest(proxy) }
            .onAppear { scrollToNewest(proxy) }
            .onChange(of: session.search.activeLineID) {
                if let id = session.search.activeLineID {
                    proxy.scrollTo(id, anchor: .center)
                }
            }
            .overlay(alignment: .bottom) {
                if !session.showsHistory, !session.isFollowing, session.newLinesSincePause > 0 {
                    Button {
                        session.isFollowing = true
                        if let last = session.buffer.lines.last {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    } label: {
                        Text("↓ \(session.newLinesSincePause) new lines")
                            .scaledFont(size: 11, weight: .medium)
                            .foregroundStyle(DesignTokens.accentDefault)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 5)
                            .background(DesignTokens.surfaceOverlay)
                            .clipShape(Capsule())
                            .overlay(Capsule().stroke(DesignTokens.borderStrong, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 10)
                    .accessibilityLabel("Jump to \(session.newLinesSincePause) new lines")
                    .accessibilityIdentifier("logpanel.new-lines")
                }
            }
        }
    }

    private func scrollToNewest(_ proxy: ScrollViewProxy) {
        guard session.showsHistory || session.isFollowing,
            let last = session.displayedLines.last
        else { return }
        proxy.scrollTo(last.id, anchor: .bottom)
    }

    /// Scrolling up over the panel while following pauses the follow.
    private func installScrollMonitor() {
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            if isHovering, !session.showsHistory, session.isFollowing, event.scrollingDeltaY > 0 {
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

/// One rendered log line. In JSON mode a line whose message is a JSON
/// object renders humanised (`message  key=value …`) and toggles a JSON tree
/// below it (#477); in ECS mode every line renders as its ECS document and
/// toggles a field table (#493); otherwise lines render raw.
struct LogLineRow: View {
    let line: LogLine
    let showTimestamp: Bool
    let wrap: Bool
    var searchQuery: String?
    var isActiveMatch = false
    var sourceName: String?
    var sourceColor: Color?
    /// Source column width: container names in the panel, wider for pod
    /// names in the aggregated Logs view.
    var sourceWidth: CGFloat = 52
    var mode: LogViewMode = .raw
    /// Kubernetes metadata for the ECS conversion.
    var ecsMetadata: ECSDocument.Metadata?
    var isExpanded = false
    var onToggleExpanded: (() -> Void)?

    @ScaledMetric(
        relativeTo: ScaledFontModifier.anchor(for: DesignTokens.Typography.micro.size))
    private var tailFontSize = DesignTokens.Typography.micro.size

    var body: some View {
        if mode == .ecs {
            ecsRow(
                ECSDocument.make(
                    line: line,
                    metadata: ecsMetadata ?? ECSDocument.Metadata(namespace: "", pod: "")))
        } else if mode == .json, let json = JSONLogView.parse(line.structuredText) {
            jsonRow(json)
        } else {
            rawRow
        }
    }

    private var rawRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            gutter(line.level)
            Text(highlighted(line.message, base: Self.messageColor(line.level)))
                .typeStyle(DesignTokens.Typography.log)
                .textSelection(.enabled)
                .lineLimit(wrap ? nil : 1)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.rowTint(line.level))
    }

    private func jsonRow(_ json: JSONLogView) -> some View {
        let level = json.level ?? line.level
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                gutter(level)
                Button {
                    onToggleExpanded?()
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Image(systemName: "chevron.right")
                            .iconSize(DesignTokens.iconXs, weight: .semibold)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .foregroundStyle(DesignTokens.textTertiary)
                            .accessibilityHidden(true)
                        Text(humanised(message: json.message, tail: json.tail, level: level))
                            .typeStyle(DesignTokens.Typography.log)
                            .lineLimit(wrap ? nil : 1)
                            .multilineTextAlignment(.leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
                .accessibilityHint("Shows all JSON fields")
                .accessibilityIdentifier("logpanel.json-row")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 1)
            if isExpanded {
                JSONTreeView(value: json.object, raw: line.structuredText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(DesignTokens.surfaceRaised)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.rowTint(level))
    }

    private func ecsRow(_ document: ECSDocument) -> some View {
        let level = document.level
        let row = document.row
        return VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                gutter(level)
                Button {
                    onToggleExpanded?()
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Image(systemName: "chevron.right")
                            .iconSize(DesignTokens.iconXs, weight: .semibold)
                            .rotationEffect(.degrees(isExpanded ? 90 : 0))
                            .foregroundStyle(DesignTokens.textTertiary)
                            .accessibilityHidden(true)
                        if let service = row.service {
                            Text(verbatim: service)
                                .typeStyle(
                                    DesignTokens.Typography.micro.monospaced,
                                    color: DesignTokens.textSecondary)
                                .padding(.horizontal, 4)
                                .background(
                                    DesignTokens.surfaceRaised,
                                    in: RoundedRectangle(cornerRadius: DesignTokens.radiusSm))
                                .accessibilityIdentifier("logpanel.ecs-service")
                        }
                        Text(humanised(message: row.message, tail: row.tail, level: level))
                            .typeStyle(DesignTokens.Typography.log)
                            .lineLimit(wrap ? nil : 1)
                            .multilineTextAlignment(.leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
                .accessibilityHint("Shows all ECS fields")
                .accessibilityIdentifier("logpanel.ecs-row")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 1)
            if isExpanded {
                ECSFieldTableView(document: document, raw: line.message)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(DesignTokens.surfaceRaised)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Self.rowTint(level))
    }

    @ViewBuilder
    private func gutter(_ level: LogLine.Level) -> some View {
        if showTimestamp {
            Text(line.time ?? "—")
                .typeStyle(DesignTokens.Typography.micro.monospaced)
                .foregroundStyle(DesignTokens.textTertiary)
                .frame(width: 94, alignment: .leading)
        }
        if let sourceName, let sourceColor {
            Text(sourceName)
                .typeStyle(DesignTokens.Typography.micro.monospaced.weighted(.semibold))
                .foregroundStyle(sourceColor)
                .frame(width: sourceWidth, alignment: .leading)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(sourceName)
        }
        Text(Self.levelLabel(level))
            .typeStyle(DesignTokens.Typography.micro.monospaced.weighted(.semibold))
            .foregroundStyle(Self.levelColor(level))
            .frame(width: 42, alignment: .leading)
    }

    /// `message  key=value  key2=value2`: message in the log style, tail in
    /// micro monospace with tertiary keys and secondary values.
    private func humanised(
        message: String, tail: [JSONLogView.TailField], level: LogLine.Level
    ) -> AttributedString {
        var text = highlighted(message, base: Self.messageColor(level))
        let tailFont = AppFont.font(
            mono: true, weight: DesignTokens.Typography.micro.weight, size: tailFontSize)
        for (n, field) in tail.enumerated() {
            var key = AttributedString((n == 0 ? " " : "  ") + field.key)
            key.foregroundColor = DesignTokens.textTertiary
            var equals = AttributedString("=")
            equals.foregroundColor = DesignTokens.textLog
            let value = highlighted(field.value, base: DesignTokens.textSecondary)
            var item = key + equals + value
            item.font = tailFont
            text += item
        }
        return text
    }

    /// `text` in `base` with every query occurrence tinted; the active match
    /// gets the solid warn treatment from the design (its own foreground).
    private func highlighted(_ text: String, base: Color) -> AttributedString {
        var attributed = AttributedString(text)
        attributed.foregroundColor = base
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

    private static func levelLabel(_ level: LogLine.Level) -> String {
        switch level {
        case .debug: "DEBUG"
        case .info: "INFO"
        case .warn: "WARN"
        case .error: "ERROR"
        }
    }

    private static func levelColor(_ level: LogLine.Level) -> Color {
        switch level {
        case .debug: DesignTokens.textTertiary
        case .info: DesignTokens.textLog
        case .warn: DesignTokens.statusWarn
        case .error: DesignTokens.statusErr
        }
    }

    private static func messageColor(_ level: LogLine.Level) -> Color {
        switch level {
        case .warn: DesignTokens.statusWarn
        case .error: DesignTokens.statusErr
        default: DesignTokens.textLog
        }
    }

    private static func rowTint(_ level: LogLine.Level) -> Color {
        switch level {
        case .error: DesignTokens.statusErr.opacity(0.07)
        case .warn: DesignTokens.statusWarn.opacity(0.045)
        default: .clear
        }
    }
}

/// Empty History body: searching, the search error, or nothing found.
private struct HistoryEmptyState: View {
    let history: LogHistory

    var body: some View {
        if let error = history.error {
            UnifiedErrorState(title: "History search failed", message: error)
        } else {
            VStack(spacing: 4) {
                Text(history.isLoading || !history.started ? "searching Elasticsearch…" : "no logs found")
                    .scaledFont(size: 12, weight: .medium, design: .monospaced)
                    .foregroundStyle(DesignTokens.textSecondary)
                if !history.isLoading, history.started {
                    Text("nothing in Elasticsearch for \(history.pod) in the last \(history.range.label)")
                        .scaledFont(size: 11)
                        .foregroundStyle(DesignTokens.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityIdentifier("logpanel.history-empty")
        }
    }
}

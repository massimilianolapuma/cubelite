import SwiftUI

/// Aggregated multi-pod Logs screen (desktop parity): streams every pod
/// in the current namespace scope — optionally narrowed by an equality
/// label selector — into one merged, filterable stream.
struct AggregatedLogsView: View {

    let pods: [PodInfo]
    let context: String?

    @State private var store: AggregatedLogStore
    @State private var labelSelector = ""
    /// Selector actually applied to the stream (debounced copy).
    @State private var appliedSelector = ""

    init(streamer: any PodLogStreaming, pods: [PodInfo], context: String?) {
        self.pods = pods
        self.context = context
        _store = State(initialValue: AggregatedLogStore(streamer: streamer))
    }

    private var matchedPods: [PodInfo] {
        let matcher = LabelSelectorMatcher(appliedSelector)
        return pods.filter { matcher.matches($0.labels) }
    }

    /// Identity of the streamed set — changing it restarts the stream.
    private var streamKey: String {
        let ids = matchedPods.map(\.id).sorted().joined(separator: ",")
        return "\(context ?? "")|\(appliedSelector)|\(ids)"
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            logList
        }
        .background(Color(nsColor: .controlBackgroundColor))
        // Debounce selector edits so each keystroke doesn't restart streams.
        .task(id: labelSelector) {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if !Task.isCancelled { appliedSelector = labelSelector }
        }
        .task(id: streamKey) {
            store.start(pods: matchedPods, context: context)
        }
        .onDisappear { store.stop() }
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 8) {
            Text(verbatim: streamingCaption)
                .font(.system(size: 10.5))
                .foregroundStyle(DesignTokens.textTertiary)
            Spacer(minLength: 8)
            TextField("label=value,…", text: $labelSelector)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11, design: .monospaced))
                .frame(width: 160)
            levelChips
            TextField("Filter…", text: Bindable(store).textFilter)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11))
                .frame(width: 140)
            followButton
            Button("Clear") { store.clear() }
                .controlSize(.small)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    private var streamingCaption: String {
        let total = matchedPods.count
        let streamed = min(total, AggregatedLogStore.maxPods)
        return streamed < total
            ? "streaming \(streamed) of \(total) pods"
            : "streaming \(streamed) pods"
    }

    private var levelChips: some View {
        let options: [(label: String, level: LogLine.Level?)] = [
            ("ALL", nil), ("INFO", .info), ("WARN", .warn), ("ERR", .error),
        ]
        return HStack(spacing: 0) {
            ForEach(options, id: \.label) { option in
                let active = store.levelFilter == option.level
                Button(option.label) { store.levelFilter = option.level }
                    .buttonStyle(.plain)
                    .font(.system(size: 9.5, weight: .semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(active ? DesignTokens.surfaceRaised : .clear)
                    .foregroundStyle(
                        active ? DesignTokens.textPrimary : DesignTokens.textTertiary)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.radiusMd)
                .strokeBorder(DesignTokens.borderDefault, lineWidth: 1))
    }

    private var followButton: some View {
        Button {
            store.isFollowing.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: store.isFollowing ? "play.fill" : "pause.fill")
                    .font(.system(size: 8))
                Text(store.isFollowing ? "Following" : "Paused")
                if !store.isFollowing, store.newSincePause > 0 {
                    Text(verbatim: "+\(store.newSincePause)")
                        .font(.system(size: 9, design: .monospaced))
                }
            }
            .font(.system(size: 10.5))
        }
        .controlSize(.small)
        .tint(store.isFollowing ? DesignTokens.statusOk : DesignTokens.statusWarn)
    }

    // MARK: - Log List

    private var logList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if store.filtered.isEmpty {
                        Text(
                            store.buffer.isEmpty
                                ? "Waiting for log lines…" : "No lines match the filter."
                        )
                        .font(.system(size: 11))
                        .foregroundStyle(DesignTokens.textTertiary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 32)
                    } else {
                        ForEach(store.filtered) { entry in
                            logRow(entry)
                                .id(entry.id)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .onChange(of: store.totalAppended) { _, _ in
                if store.isFollowing, let last = store.filtered.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
    }

    private func logRow(_ entry: AggregatedLogLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: entry.line.time ?? "—")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(DesignTokens.textTertiary)
                .frame(width: 88, alignment: .leading)
            Text(verbatim: levelLabel(entry.line.level))
                .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(levelColor(entry.line.level))
                .frame(width: 36, alignment: .leading)
            Text(entry.pod)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(DesignTokens.textSecondary)
                .lineLimit(1)
            Text(entry.line.message)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(DesignTokens.textLog)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 1)
    }

    private func levelLabel(_ level: LogLine.Level) -> String {
        switch level {
        case .debug: "DBG"
        case .info: "INFO"
        case .warn: "WARN"
        case .error: "ERR"
        }
    }

    private func levelColor(_ level: LogLine.Level) -> Color {
        switch level {
        case .debug: DesignTokens.textTertiary
        case .info: DesignTokens.statusInfo
        case .warn: DesignTokens.statusWarn
        case .error: DesignTokens.statusErr
        }
    }
}

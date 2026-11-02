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
                .scaledFont(size: 10.5)
                .foregroundStyle(DesignTokens.textTertiary)
            Spacer(minLength: 8)
            TextField("label=value,…", text: $labelSelector)
                .textFieldStyle(.roundedBorder)
                .scaledFont(size: 11, design: .monospaced)
                .frame(width: 160)
                .accessibilityLabel("Label selector")
                .accessibilityIdentifier("aggregatedlogs.label-selector")
            levelChips
            TextField("Filter…", text: Bindable(store).textFilter)
                .textFieldStyle(.roundedBorder)
                .scaledFont(size: 11)
                .frame(width: 140)
                .accessibilityLabel("Filter log messages")
                .accessibilityIdentifier("aggregatedlogs.text-filter")
            jsonViewButton
            followButton
            Button("Clear") { store.clear() }
                .controlSize(.small)
                .accessibilityIdentifier("aggregatedlogs.clear")
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
                    .scaledFont(size: 9.5, weight: .semibold, relativeTo: .caption)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(active ? DesignTokens.surfaceRaised : .clear)
                    .foregroundStyle(
                        active ? DesignTokens.textPrimary : DesignTokens.textTertiary)
                    .accessibilityLabel("Filter level \(option.label)")
                    .accessibilityValue(active ? "Selected" : "")
                    .accessibilityIdentifier("aggregatedlogs.level-\(option.label.lowercased())")
            }
        }
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.radiusMd)
                .strokeBorder(DesignTokens.borderDefault, lineWidth: 1))
    }

    /// Humanises JSON log lines (#477), with its own remembered preference.
    private var jsonViewButton: some View {
        Button {
            store.jsonView.toggle()
        } label: {
            Image(systemName: "curlybraces")
                .scaledFont(size: 11, weight: store.jsonView ? .semibold : .regular)
                .foregroundStyle(
                    store.jsonView ? DesignTokens.accentDefault : DesignTokens.textSecondary)
                .frame(width: 26, height: 22)
                .background(
                    store.jsonView ? DesignTokens.surfaceRaised : .clear,
                    in: RoundedRectangle(cornerRadius: DesignTokens.radiusSm))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("JSON view")
        .accessibilityLabel("JSON view")
        .accessibilityValue(store.jsonView ? "On" : "Off")
        .accessibilityAddTraits(store.jsonView ? .isSelected : [])
        .accessibilityIdentifier("aggregatedlogs.json-view")
    }

    private var followButton: some View {
        Button {
            store.isFollowing.toggle()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: store.isFollowing ? "play.fill" : "pause.fill")
                    .iconSize(DesignTokens.iconXs)
                    .accessibilityHidden(true)
                Text(store.isFollowing ? "Following" : "Paused")
                if !store.isFollowing, store.newSincePause > 0 {
                    Text(verbatim: "+\(store.newSincePause)")
                        .scaledFont(size: 9, design: .monospaced, relativeTo: .caption)
                }
            }
            .scaledFont(size: 10.5)
        }
        .controlSize(.small)
        .tint(store.isFollowing ? DesignTokens.statusOk : DesignTokens.statusWarn)
        .accessibilityLabel("Follow log stream")
        .accessibilityValue(followAccessibilityValue)
        .accessibilityIdentifier("aggregatedlogs.follow")
    }

    private var followAccessibilityValue: String {
        guard !store.isFollowing else { return "Following" }
        return store.newSincePause > 0 ? "Paused, \(store.newSincePause) new lines" : "Paused"
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
                        .scaledFont(size: 11)
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

    /// The log panel's row, with the pod name in a wide source column
    /// (desktop #461).
    private func logRow(_ entry: AggregatedLogLine) -> some View {
        LogLineRow(
            line: entry.line, showTimestamp: true, wrap: true,
            sourceName: entry.pod, sourceColor: DesignTokens.textSecondary, sourceWidth: 140,
            jsonView: store.jsonView,
            isExpanded: store.expandedLineIDs.contains(entry.id),
            onToggleExpanded: { store.toggleExpanded(entry.id) })
    }
}

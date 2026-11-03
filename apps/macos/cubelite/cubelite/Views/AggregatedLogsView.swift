import SwiftUI

/// Aggregated multi-pod Logs screen (desktop parity): streams every pod
/// in the current namespace scope — optionally narrowed to one workload
/// (#529) or by an equality label selector — into one merged, filterable
/// stream, with the same filter's Elasticsearch history one click away.
struct AggregatedLogsView: View {

    let pods: [PodInfo]
    let context: String?

    @Environment(ClusterState.self) private var clusterState: ClusterState?
    @Environment(LogSessionStore.self) private var logSessions: LogSessionStore?
    @Environment(AppSettings.self) private var settings: AppSettings?

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
        let inScope = store.scope?.matcher() ?? { _ in true }
        return pods.filter { inScope($0) && matcher.matches($0.labels) }
    }

    /// Identity of the streamed set — changing it restarts the stream.
    private var streamKey: String {
        let ids = matchedPods.map(\.id).sorted().joined(separator: ",")
        return "\(context ?? "")|\(appliedSelector)|\(ids)"
    }

    private var namespace: String? { clusterState?.selectedNamespace }

    /// Workloads to narrow to (#529).
    private var workloads: [LogScope] {
        guard let clusterState else { return [] }
        let deployments = clusterState.deployments.map {
            LogScope(namespace: $0.namespace, workload: .deployment($0.name))
        }
        let statefulSets = clusterState.statefulSets.map {
            LogScope(namespace: $0.namespace, workload: .statefulSet($0.name))
        }
        let jobs = clusterState.jobs.map { LogScope(namespace: $0.namespace, workload: .job($0.name)) }
        let all = deployments + statefulSets + jobs
        // The current scope stays selectable while the lists load.
        if let scope = store.scope, !all.contains(scope) { return [scope] + all }
        return all
    }

    /// History query of the filter (#529).
    private var historyMapping: LogsHistoryMapping {
        LogsHistoryMapping.map(namespace: namespace, scope: store.scope, selector: appliedSelector)
    }

    private var historyEndpoint: EsEndpoint? {
        guard let context else { return nil }
        return logSessions?.elastic?.endpoints.endpoint(for: context)
    }

    /// Identity of the history's query: changing it replaces the history.
    private var historyKey: String {
        "\(context ?? "")|\(String(describing: historyMapping))|\(historyEndpoint.map { "\($0)" } ?? "")"
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
        .task(id: historyKey) {
            store.elastic = logSessions?.elastic
            store.setHistory(historyMapping, context: context)
        }
        // A scope belongs to its context and namespace.
        .onChange(of: context) { _, _ in store.scope = nil }
        .onChange(of: namespace) { _, new in
            if let new, let scope = store.scope, scope.namespace != new { store.scope = nil }
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
            workloadPicker
            TextField("label=value,…", text: $labelSelector)
                .textFieldStyle(.roundedBorder)
                .scaledFont(size: 11, design: .monospaced)
                .frame(width: 160)
                .accessibilityLabel("Label selector")
                .accessibilityIdentifier("aggregatedlogs.label-selector")
            sourceControls
            levelChips
            TextField("Filter…", text: Bindable(store).textFilter)
                .textFieldStyle(.roundedBorder)
                .scaledFont(size: 11)
                .frame(width: 140)
                .accessibilityLabel("Filter log messages")
                .accessibilityIdentifier("aggregatedlogs.text-filter")
            viewModePicker
            if store.showsHistory {
                if let endpoint = historyEndpoint, logSessions?.elastic?.canOpenKibana(endpoint) ?? false {
                    Button("Open in Kibana") { openKibana() }
                        .controlSize(.small)
                        .accessibilityIdentifier("aggregatedlogs.open-kibana")
                }
            } else {
                followButton
                Button("Clear") { store.clear() }
                    .controlSize(.small)
                    .accessibilityIdentifier("aggregatedlogs.clear")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    /// One workload's pods, live and in history (#529).
    private var workloadPicker: some View {
        Picker(
            "Workload",
            selection: Binding(get: { store.scope }, set: { store.scope = $0 })
        ) {
            Text("All pods").tag(LogScope?.none)
            ForEach(workloads) { scope in
                Text(verbatim: "\(scope.kindLabel) \(namespace == nil ? "\(scope.namespace)/" : "")\(scope.workload.name)")
                    .tag(Optional(scope))
            }
        }
        .labelsHidden()
        .controlSize(.small)
        .fixedSize()
        .help("Show one workload's pods, live and in Elasticsearch history")
        .accessibilityLabel("Workload")
        .accessibilityIdentifier("aggregatedlogs.workload")
    }

    /// Live · History (#529) and, in History, its range and query.
    @ViewBuilder
    private var sourceControls: some View {
        if historyEndpoint != nil {
            sourcePicker(enabled: store.history != nil, help: historyMapping.reason)
        } else if IntegrationHints.showsSetup(
            available: logSessions?.elastic != nil, configured: false, hints: settings?.integrationHints ?? false)
        {
            sourcePicker(enabled: false, help: IntegrationHints.historyHelp)
            IntegrationSetupButton(title: "Set up", pane: .elasticsearch, context: context)
        }
        if store.showsHistory, let history = store.history {
            HistoryQueryControls(history: history)
        }
    }

    private func sourcePicker(enabled: Bool, help: String?) -> some View {
        Picker(
            "Log source",
            selection: Binding(get: { store.source }, set: { store.setSource($0) })
        ) {
            Text("Live").tag(LogSession.Source.live)
            Text("History").tag(LogSession.Source.history).disabled(!enabled)
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .fixedSize()
        .help(help ?? "Live stream, or these pods' past logs from Elasticsearch")
        .accessibilityIdentifier("aggregatedlogs.source")
    }

    /// Opens Discover with the history's filter.
    private func openKibana() {
        Task {
            if let url = try? await store.kibanaURL(context: context) {
                NSWorkspace.shared.open(url)
            }
        }
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

    /// Raw / JSON (#477) / ECS (#493) rendering, with its own remembered preference.
    private var viewModePicker: some View {
        LogViewModePicker(mode: Bindable(store).viewMode, identifier: "aggregatedlogs.view-mode")
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

    @ViewBuilder
    private var logList: some View {
        if store.showsHistory, let history = store.history {
            HistoryStripView(history: history)
            if store.sourceLines.isEmpty {
                HistoryEmptyState(history: history)
            } else {
                lines
            }
        } else {
            lines
        }
    }

    private var lines: some View {
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
                if !store.showsHistory, store.isFollowing, let last = store.filtered.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            // History: show the newest lines after each (re)load.
            .onChange(of: store.history?.loads) { _, _ in
                if store.showsHistory, let last = store.filtered.last {
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
            mode: store.viewMode,
            ecsMetadata: ECSDocument.Metadata(namespace: entry.namespace, pod: entry.pod),
            isExpanded: store.expandedLineIDs.contains(entry.id),
            onToggleExpanded: { store.toggleExpanded(entry.id) })
    }
}

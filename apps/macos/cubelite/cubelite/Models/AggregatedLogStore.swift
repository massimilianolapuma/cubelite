import Foundation
import Observation

/// One line in the aggregated multi-pod stream, with pod attribution and
/// a store-global ID (per-pod line IDs would collide across streams).
struct AggregatedLogLine: Identifiable, Sendable {
    let id: Int
    let pod: String
    let namespace: String
    let line: LogLine
}

/// Aggregated multi-pod log stream for the Logs screen (desktop parity):
/// fans out one follow-stream per pod into a single ring buffer with
/// level/text filtering and a follow/pause marker. The screen can narrow to
/// one workload's pods and show their Elasticsearch history (#529) with the
/// log panel's `LogHistory`.
@Observable
@MainActor
final class AggregatedLogStore {

    /// Streamed-pod cap, matching the desktop backend's MAX_LOG_PODS.
    static let maxPods = 20
    /// Merged ring-buffer capacity.
    static let bufferCap = 2000
    /// History requested per pod when a stream (re)opens.
    static let tailLines = 50

    private let streamer: any PodLogStreaming
    private let defaults: UserDefaults
    private let backoffBase: Double
    private var tasks: [Task<Void, Never>] = []
    private var nextID = 0

    /// Merged lines, oldest first, bounded at ``bufferCap``.
    private(set) var buffer: [AggregatedLogLine] = []
    /// Total lines ever appended (drives autoscroll + the "new" pill).
    private(set) var totalAppended = 0
    /// How many pods are actually being streamed (after the cap).
    private(set) var streamedPodCount = 0
    private(set) var isStreaming = false

    /// nil shows every level.
    var levelFilter: LogLine.Level?
    var textFilter = ""
    var isFollowing = true {
        didSet { pausedAtCount = isFollowing ? nil : totalAppended }
    }
    /// `totalAppended` at the moment of pausing; nil while following.
    private(set) var pausedAtCount: Int?

    /// Raw, JSON (#477) or ECS (#493) rendering; its own preference.
    var viewMode: LogViewMode {
        didSet { defaults.set(viewMode.rawValue, forKey: "logs.viewMode") }
    }
    /// Lines expanded into a JSON tree; cleared with the buffer, ids evicted
    /// by the ring are dropped on the next toggle.
    private(set) var expandedLineIDs: Set<Int> = []

    /// Expands or collapses the JSON tree of line `id`, dropping ids the
    /// ring has evicted (line ids only grow).
    func toggleExpanded(_ id: Int) {
        if expandedLineIDs.remove(id) == nil { expandedLineIDs.insert(id) }
        if let oldest = buffer.first?.id {
            expandedLineIDs = expandedLineIDs.filter { $0 >= oldest }
        }
    }

    /// Lines arrived since the user paused.
    var newSincePause: Int {
        guard let pausedAtCount else { return 0 }
        return totalAppended - pausedAtCount
    }

    /// Workload the screen is narrowed to (#529); nil streams every pod in scope.
    var scope: LogScope?
    /// Live stream or Elasticsearch history; the stream keeps running in History.
    private(set) var source: LogSession.Source = .live
    /// History of the current filter; nil when the filter has no history
    /// query or the context no Elasticsearch endpoint.
    private(set) var history: LogHistory?
    /// Identity of `history`'s query (context, namespace, workload).
    private var historyKey: String?
    /// Elasticsearch access (the log panel's), set by the view.
    var elastic: LogHistoryAccess?

    /// History is shown.
    var showsHistory: Bool { source == .history && history != nil }

    /// Lines of the active source, with their pods.
    var sourceLines: [AggregatedLogLine] {
        guard showsHistory, let history else { return buffer }
        return history.lines.map {
            AggregatedLogLine(id: $0.id, pod: $0.pod ?? "", namespace: history.namespace, line: $0)
        }
    }

    /// Points History at the screen's filter on `context` (#529). A
    /// different query replaces the history (its point in time is
    /// released); without one the screen goes back to Live.
    func setHistory(_ mapping: LogsHistoryMapping, context: String?) {
        let endpoint = context.flatMap { elastic?.endpoints.endpoint(for: $0) }
        var key: String?
        if case .query(let namespace, let target) = mapping, let context, let endpoint {
            key = "\(context)|\(namespace)|\(String(describing: target))|\(endpoint)"
        }
        guard key != historyKey else { return }
        historyKey = key
        history?.close()
        dropHistoryExpansions()
        guard case .query(let namespace, let target) = mapping, let context, let elastic, endpoint != nil
        else {
            history = nil
            source = .live
            return
        }
        let endpoints = elastic.endpoints
        let history = LogHistory(
            context: context, namespace: namespace, target: target,
            endpoint: { endpoints.endpoint(for: context) }, container: { nil },
            searcher: elastic.searcher, onReplace: { [weak self] in self?.dropHistoryExpansions() })
        self.history = history
        if source == .history { Task { await history.reload() } }
    }

    /// Switches the source; the first switch to History loads a page.
    func setSource(_ new: LogSession.Source) {
        guard new == .live || history != nil else { return }
        source = new
        if new == .history, let history, !history.started {
            Task { await history.reload() }
        }
    }

    /// Kibana Discover with the history's filter: the configured URL, else
    /// the in-cluster Kibana through a port-forward.
    func kibanaURL(context: String?) async throws -> URL? {
        guard let history, let context, let elastic,
            let endpoint = elastic.endpoints.endpoint(for: context),
            let base = try await elastic.kibanaBase(context: context, endpoint: endpoint)
        else { return nil }
        return history.kibanaURL(shown: showsHistory, base: base)
    }

    private func dropHistoryExpansions() {
        expandedLineIDs = expandedLineIDs.filter { $0 < LogHistory.idBase }
    }

    var filtered: [AggregatedLogLine] {
        let text = textFilter.lowercased()
        return sourceLines.filter { entry in
            if let levelFilter, entry.line.level != levelFilter { return false }
            if !text.isEmpty,
                !"\(entry.pod) \(entry.line.message)".lowercased().contains(text)
            {
                return false
            }
            return true
        }
    }

    init(
        streamer: any PodLogStreaming, defaults: UserDefaults = .standard,
        backoffBase: Double = 2
    ) {
        self.streamer = streamer
        self.defaults = defaults
        self.backoffBase = backoffBase
        self.viewMode = LogViewMode.stored(in: defaults, key: "logs.viewMode", legacyKey: "logs.jsonView")
    }

    /// Restarts streaming for the given pod set (first ``maxPods`` pods).
    func start(pods: [PodInfo], context: String?) {
        stop()
        let selected = pods.prefix(Self.maxPods)
        streamedPodCount = selected.count
        isStreaming = !selected.isEmpty
        for pod in selected {
            tasks.append(
                Task { [weak self] in
                    await self?.streamLoop(pod: pod, context: context)
                })
        }
    }

    func stop() {
        for task in tasks {
            task.cancel()
        }
        tasks = []
        isStreaming = false
    }

    func clear() {
        buffer = []
        expandedLineIDs.removeAll()
        totalAppended = 0
        pausedAtCount = isFollowing ? nil : 0
    }

    /// Follows one pod's log stream, reconnecting with capped exponential
    /// backoff when the server drops it (same shape as LogSession).
    private func streamLoop(pod: PodInfo, context: String?) async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                let stream = try await streamer.streamPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: nil,
                    tailLines: Self.tailLines, sinceTime: nil, inContext: context)
                for try await raw in stream {
                    attempt = 0
                    append(raw, pod: pod)
                }
                // Stream ended without error: server closed it — reconnect.
            } catch is CancellationError {
                return
            } catch {
                // Transient failure — fall through to backoff.
            }
            if Task.isCancelled { return }
            attempt += 1
            let delay = min(30, backoffBase * pow(2, Double(attempt - 1)))
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    private func append(_ raw: String, pod: PodInfo) {
        let line = LogLine.parse(raw, id: nextID)
        buffer.append(
            AggregatedLogLine(id: nextID, pod: pod.name, namespace: pod.namespace, line: line))
        nextID += 1
        totalAppended += 1
        if buffer.count > Self.bufferCap {
            buffer.removeFirst(buffer.count - Self.bufferCap)
        }
    }
}

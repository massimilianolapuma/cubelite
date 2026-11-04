import Foundation
import Observation

/// History time ranges (spec §4); raw values are Elasticsearch date math.
enum HistoryRange: String, CaseIterable, Sendable {
    case last15m = "now-15m"
    case last1h = "now-1h"
    case last24h = "now-24h"
    case last7d = "now-7d"

    var label: String {
        switch self {
        case .last15m: "15 min"
        case .last1h: "1 h"
        case .last24h: "24 h"
        case .last7d: "7 d"
        }
    }
}

/// One page of history for the log panel (ElasticService in the app).
/// Port-forwards to an in-cluster Kibana (ElasticService in the app).
protocol KibanaForwarding: Sendable {
    func kibanaForward(context: String, service: KibanaService) async throws -> UInt16
}

extension ElasticService: KibanaForwarding {}

protocol LogHistorySearching: Sendable {
    func search(context: String, endpoint: EsEndpoint, query: HistoryQuery) async throws
        -> HistoryPage
    /// Releases the point in time behind a cursor whose search was replaced
    /// or closed (#531), best effort.
    func closeCursor(context: String, endpoint: EsEndpoint, cursor: HistoryCursor) async
}

extension ElasticService: LogHistorySearching {}

/// Elasticsearch history of one log session (#503): pages of a pod's logs —
/// or of a workload's pods or a whole namespace for the Logs view (#529) —
/// newest first from the server, kept oldest-first here so the panel shows
/// them like a live buffer; "Load older" prepends. Mirrors the desktop's
/// `LogHistory`. The paging cursor is opaque (#531): it may hold a point in
/// time, released when the search is replaced, capped or closed.
@Observable @MainActor
final class LogHistory {

    /// History line ids live far above live ring ids so expansions never collide.
    static let idBase = 1_000_000_000_000
    /// Upper bound of lines kept (twenty pages of 500).
    static let cap = 10_000

    private(set) var lines: [LogLine] = []
    private(set) var isLoading = false
    private(set) var error: String?
    private(set) var total: Int?
    private(set) var totalIsLowerBound = false
    /// Opaque cursor for older lines; nil at the end.
    private(set) var next: HistoryCursor?
    var range: HistoryRange = .last1h
    var text = ""
    /// True once a first page was requested.
    private(set) var started = false
    /// Bumped when a (re)load lands, so the view can jump to the newest line.
    private(set) var loads = 0

    let namespace: String
    /// One pod, a workload's pods, or (nil) the whole namespace.
    let target: Workload?
    private let context: String
    private let endpoint: () -> EsEndpoint?
    private let container: () -> String?
    private let searcher: any LogHistorySearching
    private let onReplace: () -> Void
    /// Called whenever `lines` changes (the session re-runs its search).
    var onLinesChanged: () -> Void = {}
    private var nextID = LogHistory.idBase
    private var generation = 0
    /// Range, text and container of the last reload: `next` belongs to them.
    private var params: (range: HistoryRange, text: String?, container: String?)?
    /// The endpoint the last page came from: cursors are released there.
    private var lastEndpoint: EsEndpoint?
    /// `_index`/`_id` of the lines shown: a resumed page may repeat some (#531).
    private var seen: Set<String> = []

    /// One pod's history (the log panel).
    convenience init(
        context: String, namespace: String, pod: String,
        endpoint: @escaping () -> EsEndpoint?, container: @escaping () -> String?,
        searcher: any LogHistorySearching, onReplace: @escaping () -> Void = {}
    ) {
        self.init(
            context: context, namespace: namespace, target: .pod(pod), endpoint: endpoint,
            container: container, searcher: searcher, onReplace: onReplace)
    }

    init(
        context: String, namespace: String, target: Workload?,
        endpoint: @escaping () -> EsEndpoint?, container: @escaping () -> String?,
        searcher: any LogHistorySearching, onReplace: @escaping () -> Void = {}
    ) {
        self.context = context
        self.namespace = namespace
        self.target = target
        self.endpoint = endpoint
        self.container = container
        self.searcher = searcher
        self.onReplace = onReplace
    }

    var canLoadOlder: Bool { next != nil && !isLoading && lines.count < Self.cap }

    /// The pod name of a one-pod history; "" otherwise.
    var pod: String {
        if case .pod(let name)? = target { name } else { "" }
    }

    /// What the history covers, for empty states: the pod, `deployment api`,
    /// or `namespace shop`.
    var subject: String {
        switch target {
        case .pod(let name)?: name
        case .deployment(let name)?: "deployment \(name)"
        case .statefulSet(let name)?: "StatefulSet \(name)"
        case .daemonSet(let name)?: "DaemonSet \(name)"
        case .job(let name)?: "job \(name)"
        case nil: "namespace \(namespace)"
        }
    }

    /// "1,234 hits · showing 500 · 1 h", or "" before the first page.
    var statusText: String {
        guard started, let total else { return "" }
        let count = total.formatted(.number.locale(Locale(identifier: "en_US")))
        let hits = "\(count)\(totalIsLowerBound ? "+" : "") hit\(total == 1 ? "" : "s")"
        let shown = lines.count.formatted(.number.locale(Locale(identifier: "en_US")))
        return "\(hits) · showing \(shown) · \(params?.range.label ?? range.label)"
    }

    /// Kibana Discover for the shown search (last reload's range and
    /// container) or, with `shown == false` (Live), the current container
    /// over the last hour; nil without a Kibana URL.
    func kibanaURL(shown: Bool) -> URL? {
        guard let base = endpoint()?.kibanaURL else { return nil }
        return kibanaURL(shown: shown, base: base)
    }

    /// Discover on `base` (a configured URL or a forwarded in-cluster Kibana).
    func kibanaURL(shown: Bool, base: String) -> URL? {
        let base = base.trimmingCharacters(in: .whitespaces)
        guard let endpoint = endpoint(), !base.isEmpty else { return nil }
        let shownParams = shown ? params : nil
        let from = (shownParams?.range ?? (shown ? range : .last1h)).rawValue
        guard !pod.isEmpty else {
            // A workload's pods or the namespace: the history's filter (#529).
            return Integration.webURL(
                Elastic.kibanaWorkloadURL(
                    kibanaBase: base, preset: endpoint.preset, namespace: namespace, workload: target, from: from,
                    clusterFilter: endpoint.clusterFilter))
        }
        let text = Elastic.kibanaDiscoverURL(
            kibanaBase: base.trimmingCharacters(in: .whitespaces), preset: endpoint.preset,
            namespace: namespace, pod: pod, container: shownParams?.container ?? container(),
            from: (shownParams?.range ?? (shown ? range : .last1h)).rawValue, to: "now",
            clusterFilter: endpoint.clusterFilter)
        return Integration.webURL(text)
    }

    /// First page for the current range, text and container (replaces the lines).
    func reload() async {
        generation += 1
        let mine = generation
        // The previous search is replaced: its cursor is never used again.
        release(next)
        next = nil
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let current = (range: range, text: trimmed.isEmpty ? nil : trimmed, container: container())
        params = current
        started = true
        isLoading = true
        error = nil
        defer { if mine == generation { isLoading = false } }
        do {
            guard let page = try await fetch(current, after: nil) else {
                lines = []
                next = nil
                total = nil
                onLinesChanged()
                return
            }
            guard mine == generation else {
                release(page.next)
                return
            }
            onReplace()
            seen = []
            lines = page.lines.map(toLine).reversed()
            onLinesChanged()
            total = page.total
            totalIsLowerBound = page.totalIsLowerBound
            next = page.next
            loads += 1
        } catch {
            if mine == generation {
                self.error = error.localizedDescription
                // The cursor belongs to the previous search.
                next = nil
            }
        }
    }

    /// Forgets everything (the endpoint changed); the next switch to
    /// History searches again.
    func reset() {
        generation += 1
        onReplace()
        lines = []
        release(next)
        next = nil
        total = nil
        error = nil
        isLoading = false
        started = false
        params = nil
        onLinesChanged()
    }

    /// Prepends the next older page.
    func loadOlder() async {
        guard canLoadOlder, let params, let cursor = next else { return }
        let mine = generation
        isLoading = true
        error = nil
        defer { if mine == generation { isLoading = false } }
        do {
            // Same range, text and container as the page the cursor came
            // from, even if the inputs were edited since.
            guard let page = try await fetch(params, after: cursor) else { return }
            guard mine == generation else {
                release(page.next)
                return
            }
            // A page resumed on a new point in time may repeat the boundary lines.
            let fresh = page.lines.filter { Self.key($0).map { !seen.contains($0) } ?? true }
            let room = Self.cap - lines.count
            // Newest-first page: keep its newest `room` lines; past the cap
            // there is nothing older to fetch.
            let kept = Array(fresh.prefix(room))
            lines = kept.map(toLine).reversed() + lines
            if kept.count < fresh.count {
                release(page.next)
                next = nil
            } else {
                next = page.next
            }
            onLinesChanged()
        } catch {
            if mine == generation { self.error = error.localizedDescription }
        }
    }

    /// The session closed: releases the cursor of the shown search.
    func close() {
        generation += 1
        release(next)
        next = nil
    }

    /// Releases the point in time a cursor may hold, without waiting (it
    /// expires on its own if this fails).
    private func release(_ cursor: HistoryCursor?) {
        guard let cursor, cursor.pitID != nil, let endpoint = lastEndpoint else { return }
        let searcher = searcher
        let context = context
        Task { await searcher.closeCursor(context: context, endpoint: endpoint, cursor: cursor) }
    }

    private func fetch(
        _ params: (range: HistoryRange, text: String?, container: String?), after: HistoryCursor?
    ) async throws -> HistoryPage? {
        guard let endpoint = endpoint() else {
            error = "No Elasticsearch endpoint for this cluster — set one in Settings → Integrations."
            return nil
        }
        lastEndpoint = endpoint
        // One pod by name; a workload by a regexp on its pod names (#529).
        let workload = pod.isEmpty ? target : nil
        let query = HistoryQuery(
            namespace: namespace, pod: pod, workload: workload, container: params.container,
            from: params.range.rawValue, to: "now", text: params.text, searchAfter: after)
        return try await searcher.search(context: context, endpoint: endpoint, query: query)
    }

    /// `_index`/`_id` of a hit; nil when the server did not send them.
    private static func key(_ line: HistoryLine) -> String? {
        guard let index = line.docIndex, let id = line.docID else { return nil }
        return "\(index)/\(id)"
    }

    private func toLine(_ line: HistoryLine) -> LogLine {
        defer { nextID += 1 }
        if let key = Self.key(line) { seen.insert(key) }
        // The panel's time column shows the time of day, like live lines.
        let time = line.time.flatMap { $0.split(separator: "T").last.map(String.init) }
        return LogLine(
            id: nextID, time: time, level: line.level, message: line.message,
            container: line.container, timestamp: line.time, document: line.document,
            pod: line.pod ?? (pod.isEmpty ? nil : pod))
    }
}

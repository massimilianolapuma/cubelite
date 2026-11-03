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
protocol LogHistorySearching: Sendable {
    func search(context: String, endpoint: EsEndpoint, query: HistoryQuery) async throws
        -> HistoryPage
}

extension ElasticService: LogHistorySearching {}

/// Elasticsearch history of one log session (#503): pages of a pod's logs,
/// newest first from the server, kept oldest-first here so the panel shows
/// them like a live buffer; "Load older" prepends. Mirrors the desktop's
/// `LogHistory`.
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
    /// `search_after` for older lines; nil at the end.
    private(set) var next: [JSONValue]?
    var range: HistoryRange = .last1h
    var text = ""
    /// True once a first page was requested.
    private(set) var started = false
    /// Bumped when a (re)load lands, so the view can jump to the newest line.
    private(set) var loads = 0

    let namespace: String
    let pod: String
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

    init(
        context: String, namespace: String, pod: String,
        endpoint: @escaping () -> EsEndpoint?, container: @escaping () -> String?,
        searcher: any LogHistorySearching, onReplace: @escaping () -> Void = {}
    ) {
        self.context = context
        self.namespace = namespace
        self.pod = pod
        self.endpoint = endpoint
        self.container = container
        self.searcher = searcher
        self.onReplace = onReplace
    }

    var canLoadOlder: Bool { next != nil && !isLoading && lines.count < Self.cap }

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
        guard let endpoint = endpoint(), let base = endpoint.kibanaURL,
            !base.trimmingCharacters(in: .whitespaces).isEmpty
        else { return nil }
        let shownParams = shown ? params : nil
        let text = Elastic.kibanaDiscoverURL(
            kibanaBase: base.trimmingCharacters(in: .whitespaces), preset: endpoint.preset,
            namespace: namespace, pod: pod, container: shownParams?.container ?? container(),
            from: (shownParams?.range ?? (shown ? range : .last1h)).rawValue, to: "now")
        guard let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased())
        else { return nil }
        return url
    }

    /// First page for the current range, text and container (replaces the lines).
    func reload() async {
        generation += 1
        let mine = generation
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
            guard mine == generation else { return }
            onReplace()
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
            guard let page = try await fetch(params, after: cursor), mine == generation else {
                return
            }
            let room = Self.cap - lines.count
            // Newest-first page: keep its newest `room` lines; past the cap
            // there is nothing older to fetch.
            let kept = Array(page.lines.prefix(room))
            lines = kept.map(toLine).reversed() + lines
            next = kept.count < page.lines.count ? nil : page.next
            onLinesChanged()
        } catch {
            if mine == generation { self.error = error.localizedDescription }
        }
    }

    private func fetch(
        _ params: (range: HistoryRange, text: String?, container: String?), after: [JSONValue]?
    ) async throws -> HistoryPage? {
        guard let endpoint = endpoint() else {
            error = "No Elasticsearch endpoint for this cluster — set one in Settings → Integrations."
            return nil
        }
        let query = HistoryQuery(
            namespace: namespace, pod: pod, container: params.container, from: params.range.rawValue,
            to: "now", text: params.text, searchAfter: after)
        return try await searcher.search(context: context, endpoint: endpoint, query: query)
    }

    private func toLine(_ line: HistoryLine) -> LogLine {
        defer { nextID += 1 }
        // The panel's time column shows the time of day, like live lines.
        let time = line.time.flatMap { $0.split(separator: "T").last.map(String.init) }
        return LogLine(
            id: nextID, time: time, level: line.level, message: line.message,
            container: line.container, timestamp: line.time, document: line.document)
    }
}

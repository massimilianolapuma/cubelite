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
/// level/text filtering and a follow/pause marker.
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

    /// Lines arrived since the user paused.
    var newSincePause: Int {
        guard let pausedAtCount else { return 0 }
        return totalAppended - pausedAtCount
    }

    var filtered: [AggregatedLogLine] {
        let text = textFilter.lowercased()
        return buffer.filter { entry in
            if let levelFilter, entry.line.level != levelFilter { return false }
            if !text.isEmpty,
                !"\(entry.pod) \(entry.line.message)".lowercased().contains(text)
            {
                return false
            }
            return true
        }
    }

    init(streamer: any PodLogStreaming, backoffBase: Double = 2) {
        self.streamer = streamer
        self.backoffBase = backoffBase
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

import Foundation
import Observation

/// Live follow loop of ONE pod container: opens the stream, forwards raw
/// lines tagged with the container name, reconnects with exponential
/// backoff (base·2ⁿ capped at 30s) resuming from the last seen timestamp.
/// Extracted from LogSession so merged "all containers" mode can run N in
/// parallel.
@Observable @MainActor
final class ContainerLogStream {

    let container: String?

    /// Consecutive failed reconnect attempts; 0 while the stream is healthy.
    private(set) var reconnectAttempt = 0
    /// Backoff of the pending retry, for the banner countdown.
    private(set) var nextRetrySeconds = 0
    var isInBackoff: Bool { reconnectAttempt > 0 }

    private let pod: PodInfo
    private let context: String?
    private let streamer: any PodLogStreaming
    private let backoffBase: Double
    private let tailLines: () -> Int
    private let onLine: (String, String?) -> Void
    private var streamTask: Task<Void, Never>?
    /// Full RFC 3339 prefix of the last received line, resent as
    /// `sinceTime` on reconnect so history isn't duplicated.
    private var lastRawTimestamp: String?
    private var retryNowRequested = false

    init(
        pod: PodInfo, context: String?, container: String?,
        streamer: any PodLogStreaming, backoffBase: Double,
        tailLines: @escaping () -> Int,
        onLine: @escaping (String, String?) -> Void
    ) {
        self.pod = pod
        self.context = context
        self.container = container
        self.streamer = streamer
        self.backoffBase = backoffBase
        self.tailLines = tailLines
        self.onLine = onLine
    }

    func start() {
        streamTask = Task { [weak self] in
            await self?.followWithReconnect()
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// Skips the current backoff sleep and retries immediately.
    func retryNow() {
        retryNowRequested = true
    }

    private func followWithReconnect() async {
        while !Task.isCancelled {
            do {
                let stream = try await streamer.streamPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: container,
                    tailLines: tailLines(),
                    sinceTime: lastRawTimestamp, inContext: context)
                for try await raw in stream {
                    // `sinceTime` is inclusive: a reconnect re-receives the
                    // last line we already saw (most visible on a TERMINATED
                    // container, where kubelet closes the follow stream
                    // right after replaying it). Skip anything at or before
                    // the last seen timestamp so it isn't appended twice,
                    // and don't let a skipped replay reset the backoff —
                    // otherwise a dead container reconnects forever at the
                    // base interval instead of backing off to the cap.
                    if let prefix = timestampPrefix(raw), let last = lastRawTimestamp,
                        prefix <= last
                    {
                        continue
                    }
                    reconnectAttempt = 0
                    trackTimestamp(raw)
                    onLine(raw, container)
                }
                // Stream ended without error: server closed it — reconnect.
            } catch is CancellationError {
                return
            } catch {
                // Drop — fall through to backoff.
            }
            if Task.isCancelled { return }
            reconnectAttempt += 1
            let delay = min(30, backoffBase * pow(2, Double(reconnectAttempt - 1)))
            nextRetrySeconds = max(1, Int(delay.rounded()))
            await sleepInterruptibly(seconds: delay)
        }
    }

    private func trackTimestamp(_ raw: String) {
        if let prefix = timestampPrefix(raw) {
            lastRawTimestamp = prefix
        }
    }

    /// Extracts the RFC 3339 timestamp prefix Kubernetes prepends to each
    /// log line (before the first space), or nil if `raw` doesn't look
    /// timestamped.
    private func timestampPrefix(_ raw: String) -> String? {
        guard let space = raw.firstIndex(of: " "), raw.hasPrefix("2"),
            raw[raw.startIndex..<space].contains("T")
        else { return nil }
        return String(raw[raw.startIndex..<space])
    }

    /// Sleeps in 50ms slices so `retryNow()` (and cancellation) cut the
    /// backoff short.
    private func sleepInterruptibly(seconds: Double) async {
        retryNowRequested = false
        let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
        while ContinuousClock.now < deadline {
            if Task.isCancelled || retryNowRequested { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}

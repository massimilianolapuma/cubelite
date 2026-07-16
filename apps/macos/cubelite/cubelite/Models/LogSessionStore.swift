import Foundation
import Observation

/// One open log-viewing session: the streamed container of one pod.
@Observable @MainActor
final class LogSession {

    let pod: PodInfo
    let context: String?

    private(set) var containers: [ContainerInfo] = []
    private(set) var selectedContainer: String?
    private(set) var showingPrevious = false
    private(set) var buffer = LogRingBuffer(cap: 5000)
    private(set) var tailLines = 500
    private(set) var streamError: String?
    private(set) var hasCleared = false
    var isFollowing = true {
        didSet {
            guard oldValue != isFollowing else { return }
            pausedAtCount = isFollowing ? nil : buffer.totalAppended
        }
    }
    /// Buffer total at the moment the user paused; nil while following.
    private(set) var pausedAtCount: Int?
    /// Search state scoped to this session; the query survives container
    /// switches and stream restarts (matches recompute against the new buffer).
    let search = LogSearchModel()

    /// Lines appended since the user paused (drives the "new lines" pill).
    var newLinesSincePause: Int {
        guard let pausedAtCount else { return 0 }
        return buffer.totalAppended - pausedAtCount
    }

    /// Consecutive failed reconnect attempts; 0 while the stream is healthy.
    private(set) var reconnectAttempt = 0
    /// Backoff of the pending retry, for the banner countdown.
    private(set) var nextRetrySeconds = 0
    var isReconnecting: Bool { reconnectAttempt > 0 }

    /// Skips the current backoff sleep and retries immediately.
    func retryNow() {
        retryNowRequested = true
    }

    /// Test hook: routes through the private `append` used by the stream.
    func simulateAppendForTesting(_ raw: String) { append(raw) }

    private let streamer: any PodLogStreaming
    private let defaults: UserDefaults
    /// Base of the exponential reconnect backoff (2s·2ⁿ, capped at 30s);
    /// injectable so tests don't wait real seconds.
    private let backoffBase: Double
    private var streamTask: Task<Void, Never>?
    private var nextLineID = 0
    /// Full RFC 3339 prefix of the last received line, resent as
    /// `sinceTime` on reconnect so history isn't duplicated.
    private var lastRawTimestamp: String?
    private var retryNowRequested = false

    /// UserDefaults key remembering the last-picked container for this pod.
    private var containerMemoryKey: String { "logPanel.container.\(pod.namespace)/\(pod.name)" }

    init(
        pod: PodInfo, context: String?, streamer: any PodLogStreaming,
        defaults: UserDefaults, backoffBase: Double = 2
    ) {
        self.pod = pod
        self.context = context
        self.streamer = streamer
        self.defaults = defaults
        self.backoffBase = backoffBase
    }

    func start() {
        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let fetched = try await streamer.fetchPodContainers(
                    namespace: pod.namespace, pod: pod.name, inContext: context)
                self.containers = fetched
                let remembered = defaults.string(forKey: containerMemoryKey)
                let name =
                    fetched.first { $0.name == remembered }?.name ?? fetched.first?.name
                self.selectedContainer = name
                await self.stream(container: name)
            } catch is CancellationError {
            } catch {
                self.streamError = error.localizedDescription
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    func switchContainer(to name: String) {
        guard name != selectedContainer else { return }
        selectedContainer = name
        defaults.set(name, forKey: containerMemoryKey)
        showingPrevious = false
        restart()
    }

    func setPrevious(_ previous: Bool) {
        guard previous != showingPrevious else { return }
        showingPrevious = previous
        if previous { isFollowing = false }
        restart()
    }

    func setTail(_ lines: Int) {
        guard lines != tailLines else { return }
        tailLines = lines
        restart()
    }

    /// Restarts the stream with a 500-line-larger tail ("load earlier").
    func loadEarlier() {
        isFollowing = false
        setTail(tailLines + 500)
    }

    func clear() {
        buffer.removeAll()
        hasCleared = true
    }

    private func restart() {
        stop()
        buffer.removeAll()
        hasCleared = false
        streamError = nil
        reconnectAttempt = 0
        lastRawTimestamp = nil
        search.recompute(over: [])
        streamTask = Task { [weak self] in
            await self?.stream(container: self?.selectedContainer)
        }
    }

    private func stream(container: String?) async {
        if showingPrevious {
            do {
                let lines = try await streamer.fetchPreviousPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: container,
                    tailLines: tailLines, inContext: context)
                for raw in lines { append(raw) }
            } catch is CancellationError {
            } catch {
                streamError = error.localizedDescription
            }
            return
        }
        await followWithReconnect(container: container)
    }

    /// Live follow loop: reopens the stream with exponential backoff when
    /// the server drops it, resuming from the last seen timestamp.
    private func followWithReconnect(container: String?) async {
        while !Task.isCancelled {
            do {
                let stream = try await streamer.streamPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: container,
                    tailLines: tailLines,
                    sinceTime: lastRawTimestamp, inContext: context)
                for try await raw in stream {
                    reconnectAttempt = 0
                    append(raw)
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

    private func append(_ raw: String) {
        if let space = raw.firstIndex(of: " "), raw.hasPrefix("2"),
            raw[raw.startIndex..<space].contains("T")
        {
            lastRawTimestamp = String(raw[raw.startIndex..<space])
        }
        buffer.append(LogLine.parse(raw, id: nextLineID))
        nextLineID += 1
        if !buffer.lines.isEmpty { hasCleared = false }
    }
}

/// Shell-level owner of the log panel: the open sessions (one tab each),
/// the active tab, and panel chrome state.
@Observable @MainActor
final class LogSessionStore {

    private(set) var sessions: [LogSession] = []
    var activeSessionID: String?
    var isCollapsed = false

    var activeSession: LogSession? {
        sessions.first { $0.pod.id == activeSessionID }
    }

    var panelHeight: Double {
        didSet {
            let clamped = min(560, max(160, panelHeight))
            if clamped != panelHeight {
                panelHeight = clamped
                return
            }
            defaults.set(panelHeight, forKey: "logPanel.height")
        }
    }

    var showTimestamps: Bool {
        didSet { defaults.set(showTimestamps, forKey: "logPanel.showTimestamps") }
    }
    var wrapLines: Bool {
        didSet { defaults.set(wrapLines, forKey: "logPanel.wrapLines") }
    }

    /// Transient confirmation message (export result); auto-clears after 3s.
    private(set) var toast: String?

    private let streamer: any PodLogStreaming
    private let defaults: UserDefaults
    private let backoffBase: Double
    private var toastTask: Task<Void, Never>?

    init(
        streamer: any PodLogStreaming, defaults: UserDefaults = .standard,
        backoffBase: Double = 2
    ) {
        self.streamer = streamer
        self.defaults = defaults
        self.backoffBase = backoffBase
        self.showTimestamps =
            defaults.object(forKey: "logPanel.showTimestamps") as? Bool ?? true
        self.wrapLines = defaults.bool(forKey: "logPanel.wrapLines")
        let storedHeight = defaults.double(forKey: "logPanel.height")
        self.panelHeight = storedHeight == 0 ? 280 : min(560, max(160, storedHeight))
    }

    /// Opens the log session for `pod` (or focuses its existing tab) and
    /// expands the panel.
    func open(pod: PodInfo, context: String?) {
        isCollapsed = false
        if let existing = sessions.first(where: { $0.pod.id == pod.id }) {
            activeSessionID = existing.pod.id
            return
        }
        let new = LogSession(
            pod: pod, context: context, streamer: streamer, defaults: defaults,
            backoffBase: backoffBase)
        sessions.append(new)
        activeSessionID = new.pod.id
        new.start()
    }

    /// Closes one tab; if it was active, the right neighbor (else the last
    /// remaining tab) becomes active.
    func close(sessionID: String) {
        guard let index = sessions.firstIndex(where: { $0.pod.id == sessionID }) else { return }
        sessions[index].stop()
        let wasActive = activeSessionID == sessionID
        sessions.remove(at: index)
        if wasActive {
            activeSessionID =
                sessions.indices.contains(index)
                ? sessions[index].pod.id : sessions.last?.pod.id
        }
    }

    func closeAll() {
        sessions.forEach { $0.stop() }
        sessions = []
        activeSessionID = nil
    }

    /// Shows a transient confirmation in the panel, replacing any pending one.
    func showToast(_ message: String) {
        toastTask?.cancel()
        toast = message
        toastTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }
}

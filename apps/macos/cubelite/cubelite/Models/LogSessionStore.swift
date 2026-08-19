import Foundation
import Observation

/// One open log-viewing session: the streamed container of one pod.
@Observable @MainActor
final class LogSession {

    let pod: PodInfo
    let context: String?

    /// Sentinel container selection: merged stream of every container.
    static let allContainers = "*"
    /// True when the session is following every container of the pod at
    /// once rather than a single selected one.
    var isMerged: Bool { selectedContainer == Self.allContainers }

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

    /// Consecutive failed attempts of the worst-off sub-stream (banner text).
    var reconnectAttempt: Int { streams.map(\.reconnectAttempt).max() ?? 0 }
    /// Soonest pending retry among backing-off sub-streams (banner countdown).
    var nextRetrySeconds: Int {
        streams.filter(\.isInBackoff).map(\.nextRetrySeconds).min() ?? 0
    }
    /// Reconnecting = every sub-stream is down (single mode: the one stream).
    var isReconnecting: Bool { !streams.isEmpty && streams.allSatisfy(\.isInBackoff) }

    /// Skips the current backoff sleep and retries immediately.
    func retryNow() {
        for stream in streams { stream.retryNow() }
    }

    /// Test hook: routes through the private `append` used by the stream.
    func simulateAppendForTesting(_ raw: String) { append(raw, from: nil) }

    private let streamer: any PodLogStreaming
    private let defaults: UserDefaults
    /// Base of the exponential reconnect backoff (2s·2ⁿ, capped at 30s);
    /// injectable so tests don't wait real seconds.
    private let backoffBase: Double
    private var streamTask: Task<Void, Never>?
    private var nextLineID = 0
    /// Per-container follow loops; length 1 outside merged "all containers"
    /// mode, one per pod container when merged.
    private var streams: [ContainerLogStream] = []

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
                let fetched = try await self.fetchContainers()
                let remembered = defaults.string(forKey: containerMemoryKey)
                let name: String? =
                    remembered == Self.allContainers
                    ? Self.allContainers
                    : fetched.first { $0.name == remembered }?.name ?? fetched.first?.name
                self.selectedContainer = name
                await self.stream(container: name)
            } catch is CancellationError {
            } catch let urlError as URLError where urlError.code == .cancelled {
                // A restart (e.g. picking "all containers" mid-fetch) cancels
                // this task's URLSession work, which surfaces as
                // URLError(.cancelled) rather than CancellationError — treat
                // it the same as a plain cancellation, not a real failure.
            } catch {
                self.streamError = error.localizedDescription
            }
        }
    }

    /// Fetches the pod's containers and remembers the result on the
    /// session. Shared by `start()` (initial load) and merged mode's
    /// `stream(container:)` (re-fetch when "all containers" was picked
    /// before the initial fetch finished, leaving `containers` empty).
    private func fetchContainers() async throws -> [ContainerInfo] {
        let fetched = try await streamer.fetchPodContainers(
            namespace: pod.namespace, pod: pod.name, inContext: context)
        self.containers = fetched
        return fetched
    }

    func stop() {
        streams.forEach { $0.stop() }
        streams = []
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
        guard !isMerged else { return }
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
                for raw in lines { append(raw, from: container) }
            } catch is CancellationError {
            } catch {
                streamError = error.localizedDescription
            }
            return
        }
        guard !Task.isCancelled else { return }
        if isMerged && containers.isEmpty {
            // "all containers" was picked before the initial fetch finished,
            // so there's nothing to fan streams out to yet — re-fetch rather
            // than dead-ending with zero streams and a stuck picker.
            do {
                _ = try await fetchContainers()
            } catch is CancellationError {
                return
            } catch let urlError as URLError where urlError.code == .cancelled {
                return
            } catch {
                streamError = error.localizedDescription
                return
            }
        }
        startStreams(containers: isMerged ? containers.map { $0.name as String? } : [container])
    }

    /// Starts one `ContainerLogStream` per target container and fans its
    /// lines into `append`. Single-element outside merged mode; one entry
    /// per pod container when `isMerged`.
    private func startStreams(containers targets: [String?]) {
        streams.forEach { $0.stop() }
        streams = targets.map { name in
            ContainerLogStream(
                pod: pod, context: context, container: name,
                streamer: streamer, backoffBase: backoffBase,
                tailLines: { [weak self] in self?.tailLines ?? 500 },
                onLine: { [weak self] raw, container in self?.append(raw, from: container) })
        }
        streams.forEach { $0.start() }
    }

    private func append(_ raw: String, from container: String?) {
        buffer.append(LogLine.parse(raw, id: nextLineID, container: container))
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

    /// Sessions currently popped out into their own OS windows. Not
    /// persisted: windows do not survive relaunch (#298).
    private(set) var detachedSessionIDs: Set<String> = []

    /// Sessions shown as panel tabs — everything not popped out. The
    /// invariant `activeSessionID` ∈ attached (or nil) is maintained by
    /// `detach`/`reattach`/`close`/`open`.
    var attachedSessions: [LogSession] {
        sessions.filter { !detachedSessionIDs.contains($0.pod.id) }
    }

    func isDetached(_ sessionID: String) -> Bool {
        detachedSessionIDs.contains(sessionID)
    }

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
        if let existing = sessions.first(where: { $0.pod.id == pod.id }) {
            guard !detachedSessionIDs.contains(existing.pod.id) else { return }
            isCollapsed = false
            activeSessionID = existing.pod.id
            return
        }
        isCollapsed = false
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
        detachedSessionIDs.remove(sessionID)
        if wasActive {
            let remaining = attachedSessions
            let attachedIndex = min(index, max(0, remaining.count - 1))
            activeSessionID =
                remaining.indices.contains(attachedIndex)
                ? remaining[attachedIndex].pod.id : remaining.last?.pod.id
        }
    }

    func closeAll() {
        sessions.forEach { $0.stop() }
        sessions = []
        detachedSessionIDs = []
        activeSessionID = nil
    }

    /// Pops the session out of the panel. The caller opens the OS window
    /// (`openWindow` is a SwiftUI Environment action, unavailable here).
    /// If the session was the active tab, the next attached tab takes
    /// over — same neighbor rule as `close`.
    func detach(sessionID: String) {
        guard sessions.contains(where: { $0.pod.id == sessionID }),
            !detachedSessionIDs.contains(sessionID)
        else { return }
        let attachedBefore = attachedSessions
        detachedSessionIDs.insert(sessionID)
        if activeSessionID == sessionID {
            let index = attachedBefore.firstIndex { $0.pod.id == sessionID } ?? 0
            let remaining = attachedSessions
            activeSessionID =
                remaining.indices.contains(index)
                ? remaining[index].pod.id : remaining.last?.pod.id
        }
    }

    /// Returns a popped-out session to the panel as the active tab.
    /// Called by the window's `⏷` button and by window close.
    func reattach(sessionID: String) {
        guard detachedSessionIDs.remove(sessionID) != nil else { return }
        activeSessionID = sessionID
        isCollapsed = false
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

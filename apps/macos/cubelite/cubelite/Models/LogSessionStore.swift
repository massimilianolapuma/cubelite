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

    /// Test hook: routes through the private `append` used by the stream.
    func simulateAppendForTesting(_ raw: String) { append(raw) }

    private let streamer: any PodLogStreaming
    private let defaults: UserDefaults
    private var streamTask: Task<Void, Never>?
    private var nextLineID = 0

    /// UserDefaults key remembering the last-picked container for this pod.
    private var containerMemoryKey: String { "logPanel.container.\(pod.namespace)/\(pod.name)" }

    init(pod: PodInfo, context: String?, streamer: any PodLogStreaming, defaults: UserDefaults) {
        self.pod = pod
        self.context = context
        self.streamer = streamer
        self.defaults = defaults
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
        search.recompute(over: [])
        streamTask = Task { [weak self] in
            await self?.stream(container: self?.selectedContainer)
        }
    }

    private func stream(container: String?) async {
        do {
            if showingPrevious {
                let lines = try await streamer.fetchPreviousPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: container,
                    tailLines: tailLines, inContext: context)
                for raw in lines { append(raw) }
            } else {
                let stream = try await streamer.streamPodLogs(
                    namespace: pod.namespace, pod: pod.name, container: container,
                    tailLines: tailLines, sinceTime: nil, inContext: context)
                for try await raw in stream {
                    append(raw)
                }
            }
        } catch is CancellationError {
        } catch {
            streamError = error.localizedDescription
        }
    }

    private func append(_ raw: String) {
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

    private let streamer: any PodLogStreaming
    private let defaults: UserDefaults

    init(streamer: any PodLogStreaming, defaults: UserDefaults = .standard) {
        self.streamer = streamer
        self.defaults = defaults
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
        let new = LogSession(pod: pod, context: context, streamer: streamer, defaults: defaults)
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
}

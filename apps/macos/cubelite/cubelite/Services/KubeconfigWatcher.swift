import CoreServices
import Foundation
import os

/// Watches kubeconfig file paths on disk via FSEvents and fires a callback
/// when any change is detected.
///
/// Behavior:
/// - Resolves watched paths from `$KUBECONFIG` (colon-separated), expanding
///   tildes, falling back to `~/.kube/config`. Paths are de-duplicated.
/// - Files that don't exist yet are still observed by watching their parent
///   directory, so they get picked up on creation (e.g. `aws eks
///   update-kubeconfig` creating `~/.kube/config` for the first time).
/// - Coalesces rapid bursts of FSEvents through a 250 ms debounce so atomic
///   editor writes / multi-step CLI updates trigger exactly one callback.
/// - The FSEventStream callback is invoked from a private dispatch queue
///   (FSEvents is C-threaded). The watcher hops onto the main actor before
///   firing the user-supplied `onChange` closure so call sites can mutate
///   `@MainActor` state safely.
///
/// Usage:
/// ```swift
/// let watcher = KubeconfigWatcher { [weak self] in
///     await self?.reloadKubeconfig()
/// }
/// watcher.start(paths: KubeconfigWatcher.resolveWatchedPaths())
/// // … later
/// watcher.stop()
/// ```
final class KubeconfigWatcher: @unchecked Sendable {

    // MARK: - Types

    /// Async closure invoked on the main actor when a kubeconfig change is
    /// detected (after debounce).
    typealias ChangeHandler = @Sendable @MainActor () async -> Void

    // MARK: - Constants

    /// Quiescence window in seconds. Multiple FSEvents arriving within this
    /// window collapse into a single `onChange` invocation.
    static let debounceInterval: TimeInterval = 0.25

    // MARK: - State

    /// Lock guarding `stream` and `currentPaths`.
    private let lock = NSLock()
    private var stream: FSEventStreamRef?
    private var currentPaths: [URL] = []
    private let queue = DispatchQueue(label: "com.cubelite.kubeconfig-watcher", qos: .utility)
    private let logger = Logger(subsystem: "com.cubelite", category: "KubeconfigWatcher")
    private let onChange: ChangeHandler
    private let debouncer: Debouncer

    // MARK: - Init

    /// Creates a watcher that calls `onChange` (on the main actor) whenever a
    /// watched path or its parent directory reports a relevant FSEvent, after
    /// debouncing.
    init(
        debounceInterval: TimeInterval = KubeconfigWatcher.debounceInterval,
        onChange: @escaping ChangeHandler
    ) {
        self.onChange = onChange
        self.debouncer = Debouncer(interval: debounceInterval)
    }

    deinit {
        stopInternal()
    }

    // MARK: - Public API

    /// Starts watching the supplied paths. Calling `start` while already
    /// running stops the existing stream and replaces it with a new one
    /// configured for the new paths. Passing an empty array stops the watcher
    /// without starting a new stream.
    func start(paths: [URL]) {
        lock.lock()
        defer { lock.unlock() }
        stopInternal()
        guard !paths.isEmpty else {
            logger.debug("start(paths:) called with empty paths — watcher idle")
            return
        }
        currentPaths = paths
        let watchTargets = Self.expandToWatchTargets(paths)
        guard !watchTargets.isEmpty else {
            logger.warning("No usable watch targets resolved from paths: \(paths.map(\.path), privacy: .public)")
            return
        }
        stream = Self.makeStream(
            paths: watchTargets,
            queue: queue,
            owner: Unmanaged.passUnretained(self).toOpaque()
        )
        if let stream {
            FSEventStreamStart(stream)
            logger.info("Started watching \(watchTargets.count, privacy: .public) target(s) for \(paths.count, privacy: .public) kubeconfig path(s)")
        } else {
            logger.error("FSEventStreamCreate returned nil for paths: \(watchTargets, privacy: .public)")
        }
    }

    /// Stops watching and cancels any pending debounced callback.
    func stop() {
        lock.lock()
        defer { lock.unlock() }
        stopInternal()
    }

    /// Currently watched kubeconfig paths (the user-facing list, not the
    /// expanded directory targets passed to FSEvents).
    var watchedPaths: [URL] {
        lock.lock()
        defer { lock.unlock() }
        return currentPaths
    }

    // MARK: - Path Resolution

    /// Resolves the set of kubeconfig paths to watch from the environment.
    ///
    /// Mirrors `kubectl` semantics:
    /// 1. If `$KUBECONFIG` is set and non-empty, split on `:` and expand
    ///    tildes. Empty entries are dropped.
    /// 2. Otherwise fall back to `~/.kube/config`.
    ///
    /// Paths that resolve to the same standardized URL are de-duplicated
    /// while preserving first-occurrence order.
    static func resolveWatchedPaths(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = realHomeDirectory()
    ) -> [URL] {
        var raw: [String] = []
        if let envValue = environment["KUBECONFIG"], !envValue.isEmpty {
            raw = envValue.split(separator: ":", omittingEmptySubsequences: true).map(String.init)
        } else {
            raw = [homeDirectory.appendingPathComponent(".kube/config").path]
        }
        var seen = Set<String>()
        var result: [URL] = []
        for entry in raw {
            let trimmed = entry.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }
            let expanded = expandTilde(trimmed, home: homeDirectory)
            let url = URL(fileURLWithPath: expanded).standardizedFileURL
            if seen.insert(url.path).inserted {
                result.append(url)
            }
        }
        return result
    }

    /// Returns the user's real home directory, bypassing sandbox container
    /// redirection. Mirrors the helper in `KubeconfigService`.
    static func realHomeDirectory() -> URL {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
            return URL(fileURLWithPath: String(cString: dir))
        }
        return FileManager.default.homeDirectoryForCurrentUser
    }

    /// For each requested kubeconfig path, returns either the file itself
    /// (when it exists) or its parent directory (so a not-yet-created file is
    /// still picked up). Duplicates are removed.
    static func expandToWatchTargets(_ paths: [URL]) -> [String] {
        let fm = FileManager.default
        var seen = Set<String>()
        var targets: [String] = []
        for url in paths {
            let standardized = url.standardizedFileURL
            let target: String
            if fm.fileExists(atPath: standardized.path) {
                target = standardized.path
            } else {
                target = standardized.deletingLastPathComponent().path
            }
            // FSEvents requires the path to exist; skip targets whose parent
            // directory is also missing rather than silently failing.
            guard fm.fileExists(atPath: target) else { continue }
            if seen.insert(target).inserted {
                targets.append(target)
            }
        }
        return targets
    }

    // MARK: - Private

    private static func expandTilde(_ path: String, home: URL) -> String {
        guard path.hasPrefix("~") else { return path }
        if path == "~" { return home.path }
        if path.hasPrefix("~/") {
            return home.appendingPathComponent(String(path.dropFirst(2))).path
        }
        // Other forms like ~user are not supported; return unchanged.
        return path
    }

    /// Caller MUST hold `lock`.
    private func stopInternal() {
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            self.stream = nil
        }
        debouncer.cancel()
        currentPaths = []
    }

    private static func makeStream(
        paths: [String],
        queue: DispatchQueue,
        owner: UnsafeMutableRawPointer
    ) -> FSEventStreamRef? {
        var context = FSEventStreamContext(
            version: 0,
            info: owner,
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let flags: FSEventStreamCreateFlags = UInt32(
            kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagNoDefer
                | kFSEventStreamCreateFlagUseCFTypes
        )
        let callback: FSEventStreamCallback = { _, info, numEvents, _, _, _ in
            guard let info, numEvents > 0 else { return }
            let watcher = Unmanaged<KubeconfigWatcher>.fromOpaque(info).takeUnretainedValue()
            watcher.scheduleDebouncedFire()
        }
        guard let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.05,
            flags
        ) else {
            return nil
        }
        FSEventStreamSetDispatchQueue(stream, queue)
        return stream
    }

    /// Schedules a debounced fire. Called from the FSEvents dispatch queue.
    private func scheduleDebouncedFire() {
        let handler = self.onChange
        let logger = self.logger
        debouncer.schedule {
            logger.debug("Debounce window elapsed; firing onChange")
            Task { @MainActor in
                await handler()
            }
        }
    }
}

// MARK: - Debouncer

/// Coalesces rapid bursts of events into a single fire after `interval`
/// seconds of quiescence. Thread-safe.
final class Debouncer: @unchecked Sendable {
    private let interval: TimeInterval
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var pending: DispatchWorkItem?

    init(
        interval: TimeInterval,
        queue: DispatchQueue = DispatchQueue(label: "com.cubelite.debouncer", qos: .utility)
    ) {
        self.interval = interval
        self.queue = queue
    }

    /// Schedules `action` to run after `interval` seconds. Subsequent calls
    /// before the deadline cancel the previous schedule and start a new one,
    /// so only the most recent action fires.
    func schedule(_ action: @escaping @Sendable () -> Void) {
        lock.lock()
        pending?.cancel()
        let work = DispatchWorkItem(block: action)
        pending = work
        lock.unlock()
        queue.asyncAfter(deadline: .now() + interval, execute: work)
    }

    /// Cancels any pending action.
    func cancel() {
        lock.lock()
        pending?.cancel()
        pending = nil
        lock.unlock()
    }
}

import Foundation

/// Drives periodic execution of a refresh action.
///
/// The coordinator owns a single in-flight `Task`. Calling ``schedule(intervalSeconds:action:)``
/// cancels any previously scheduled task before starting a new one, so changing the
/// configured interval (e.g. when the user edits Preferences) atomically replaces the
/// running schedule. An interval of `0` is treated as "disabled" and clears any
/// pending task without starting a new one.
///
/// Each tick awaits the supplied action to completion before scheduling the next
/// sleep, so successive refreshes can never overlap even if a fetch runs longer
/// than the configured interval.
@MainActor
final class AutoRefreshCoordinator {

    private var task: Task<Void, Never>?

    /// Seconds between ticks for the currently active schedule, or `0` when disabled.
    private(set) var currentIntervalSeconds: Int = 0

    /// Number of times the scheduled action has completed. Primarily exposed for tests.
    private(set) var tickCount: Int = 0

    /// Whether a refresh task is currently running.
    var isActive: Bool {
        guard let task else { return false }
        return !task.isCancelled
    }

    /// Cancels any active schedule and, when `intervalSeconds > 0`, starts a new one
    /// that invokes `action` every `intervalSeconds` seconds.
    ///
    /// - Parameters:
    ///   - intervalSeconds: tick period in seconds. Values `<= 0` disable auto-refresh.
    ///   - action: work to perform on each tick. Runs on the main actor.
    func schedule(
        intervalSeconds: Int,
        action: @escaping @MainActor @Sendable () async -> Void
    ) {
        cancel()
        guard intervalSeconds > 0 else { return }

        currentIntervalSeconds = intervalSeconds
        let nanos = UInt64(intervalSeconds) * 1_000_000_000

        task = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(nanoseconds: nanos)
                } catch {
                    return
                }
                if Task.isCancelled { return }
                await action()
                self?.tickCount += 1
            }
        }
    }

    /// Cancels any active schedule. Safe to call when already idle.
    func cancel() {
        task?.cancel()
        task = nil
        currentIntervalSeconds = 0
    }
}

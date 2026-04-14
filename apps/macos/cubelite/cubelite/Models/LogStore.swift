import Foundation
import Observation

/// Maximum number of log entries retained before the oldest are dropped.
private let logCapacity = 500

/// Observable store for application log entries.
///
/// All mutations must happen on the main actor. Entries are kept newest-first.
/// The store caps at ``logCapacity`` entries, silently dropping the oldest when
/// exceeded.
@Observable
@MainActor
final class LogStore {

    // MARK: - Public state

    /// Log entries, newest first.
    private(set) var entries: [LogEntry] = []

    /// Number of error-severity entries appended since the last call to
    /// ``markErrorsRead()``.
    var unreadErrorCount: Int {
        let totalErrors = entries.filter { $0.severity == .error }.count
        return max(totalErrors - errorReadCount, 0)
    }

    // MARK: - Private

    private var errorReadCount: Int = 0

    // MARK: - Mutations

    /// Appends a new entry at the front of the list, enforcing the capacity cap.
    func append(_ entry: LogEntry) {
        entries.insert(entry, at: 0)
        if entries.count > logCapacity {
            entries.removeLast(entries.count - logCapacity)
        }
    }

    /// Removes all entries and resets the unread error counter.
    func clear() {
        entries.removeAll()
        errorReadCount = 0
    }

    /// Removes entries whose timestamp is older than `interval` seconds ago.
    func clearOlderThan(_ interval: TimeInterval) {
        let cutoff = Date().addingTimeInterval(-interval)
        entries.removeAll { $0.timestamp < cutoff }
    }

    /// Resets the unread error count. Call this when the user opens the logs panel.
    func markErrorsRead() {
        errorReadCount = entries.filter { $0.severity == .error }.count
    }
}

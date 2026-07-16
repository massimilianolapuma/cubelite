import Foundation
import Observation

/// Search state for the log panel: matched line IDs over the current
/// buffer, an active-match cursor, and an optional filter mode.
///
/// Matching is a case-insensitive substring test per line (match unit =
/// line). Recompute is debounced from keystrokes; highlight ranges are
/// computed per rendered row, never for the whole buffer.
@Observable @MainActor
final class LogSearchModel {

    var query = "" {
        didSet { if query.isEmpty { resetMatches() } }
    }
    var filterMode = false

    private(set) var matchingLineIDs: [Int] = []
    private(set) var activeMatchIndex: Int?

    private var debounceTask: Task<Void, Never>?

    var isActive: Bool { !query.isEmpty }

    var activeLineID: Int? {
        guard let activeMatchIndex, matchingLineIDs.indices.contains(activeMatchIndex)
        else { return nil }
        return matchingLineIDs[activeMatchIndex]
    }

    static func matches(_ line: LogLine, query: String) -> Bool {
        !query.isEmpty && line.message.range(of: query, options: .caseInsensitive) != nil
    }

    func recompute(over lines: [LogLine]) {
        guard isActive else { return resetMatches() }
        let previousActiveLine = activeLineID
        matchingLineIDs = lines.filter { Self.matches($0, query: query) }.map(\.id)
        if let previousActiveLine,
            let kept = matchingLineIDs.firstIndex(of: previousActiveLine)
        {
            activeMatchIndex = kept
        } else {
            activeMatchIndex = nil
        }
    }

    /// Debounced recompute for keystroke-driven updates (150 ms).
    func recomputeDebounced(over lines: [LogLine]) {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }
            self?.recompute(over: lines)
        }
    }

    func next() {
        guard !matchingLineIDs.isEmpty else { return }
        if let index = activeMatchIndex {
            activeMatchIndex = (index + 1) % matchingLineIDs.count
        } else {
            activeMatchIndex = 0
        }
    }

    func previous() {
        guard !matchingLineIDs.isEmpty else { return }
        if let index = activeMatchIndex {
            activeMatchIndex = (index - 1 + matchingLineIDs.count) % matchingLineIDs.count
        } else {
            activeMatchIndex = matchingLineIDs.count - 1
        }
    }

    func clear() {
        query = ""
    }

    func visibleLines(from lines: [LogLine]) -> [LogLine] {
        guard filterMode, isActive else { return lines }
        let ids = Set(matchingLineIDs)
        return lines.filter { ids.contains($0.id) }
    }

    private func resetMatches() {
        matchingLineIDs = []
        activeMatchIndex = nil
    }
}

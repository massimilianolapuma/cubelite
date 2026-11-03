import Foundation

/// One parsed pod-log line: kubelet RFC 3339 prefix split off, severity
/// detected from the message body.
struct LogLine: Identifiable, Equatable, Sendable {
    let id: Int
    let time: String?
    let level: Level
    let message: String
    /// Source container, set in merged "all containers" mode; nil otherwise.
    let container: String?
    /// Full kubelet RFC 3339 timestamp (`time` keeps only the time of day),
    /// used as the ECS `@timestamp` (#493).
    var timestamp: String? = nil
    /// Stored Elasticsearch `_source` (compact JSON) of a history line
    /// (#503); JSON and ECS modes render it instead of the message.
    var document: String? = nil

    /// What JSON and ECS modes parse: the stored document, else the message.
    var structuredText: String { document ?? message }

    enum Level: Equatable, Sendable {
        case debug, info, warn, error
    }

    /// Splits the kubelet RFC 3339 prefix and detects the severity.
    static func parse(_ raw: String, id: Int, container: String? = nil) -> LogLine {
        var time: String?
        var timestamp: String?
        var message = raw
        if let space = raw.firstIndex(of: " "),
            raw[raw.startIndex..<space].contains("T"),
            raw.hasPrefix("2")
        {
            timestamp = String(raw[raw.startIndex..<space])
            time = timestamp?.components(separatedBy: "T").last
            message = String(raw[raw.index(after: space)...])
        }
        return LogLine(
            id: id, time: time, level: detectLevel(message), message: message,
            container: container, timestamp: timestamp)
    }

    /// Severity guessed from keywords in the message.
    static func detectLevel(_ message: String) -> Level {
        let upper = message.uppercased()
        return upper.contains("ERROR") || upper.contains("FATAL") || upper.contains("PANIC")
            ? .error
            : upper.contains("WARN")
                ? .warn
                : upper.contains("DEBUG") || upper.contains("TRACE") ? .debug : .info
    }
}

/// Fixed-capacity append-only window over a log stream: keeps the newest
/// `cap` lines and counts everything ever appended.
struct LogRingBuffer: Sendable {
    private(set) var lines: [LogLine] = []
    private(set) var totalAppended = 0
    let cap: Int

    init(cap: Int = 5000) {
        self.cap = cap
    }

    mutating func append(_ line: LogLine) {
        lines.append(line)
        totalAppended += 1
        if lines.count > cap {
            lines.removeFirst(lines.count - cap)
        }
    }

    mutating func removeAll() {
        lines.removeAll()
    }
}

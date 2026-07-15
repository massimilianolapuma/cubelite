import Foundation

/// One parsed pod-log line: kubelet RFC 3339 prefix split off, severity
/// detected from the message body.
struct LogLine: Identifiable, Equatable, Sendable {
    let id: Int
    let time: String?
    let level: Level
    let message: String

    enum Level: Equatable, Sendable {
        case debug, info, warn, error
    }

    /// Splits the kubelet RFC 3339 prefix and detects the severity.
    static func parse(_ raw: String, id: Int) -> LogLine {
        var time: String?
        var message = raw
        if let space = raw.firstIndex(of: " "),
            raw[raw.startIndex..<space].contains("T"),
            raw.hasPrefix("2")
        {
            time = String(raw[raw.startIndex..<space]).components(separatedBy: "T").last
            message = String(raw[raw.index(after: space)...])
        }
        let upper = message.uppercased()
        let level: Level =
            upper.contains("ERROR") || upper.contains("FATAL") || upper.contains("PANIC")
            ? .error
            : upper.contains("WARN")
                ? .warn
                : upper.contains("DEBUG") || upper.contains("TRACE") ? .debug : .info
        return LogLine(id: id, time: time, level: level, message: message)
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

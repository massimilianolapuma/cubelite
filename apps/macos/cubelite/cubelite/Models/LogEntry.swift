import Foundation

/// Severity levels for a log entry.
enum LogSeverity: String, Sendable, CaseIterable, Identifiable, Codable {
    case error = "Error"
    case warning = "Warning"
    case info = "Info"

    /// Stable identifier used for `Identifiable` conformance.
    var id: String { rawValue }
}

/// A single log entry recorded by the app.
struct LogEntry: Identifiable, Sendable, Hashable {
    /// Unique identifier for this entry.
    let id: UUID
    /// When the entry was created.
    let timestamp: Date
    /// Severity of the event.
    let severity: LogSeverity
    /// Originating subsystem, e.g. `"KubeAPI"`, `"TLS"`, `"Config"`.
    let source: String
    /// Short human-readable message.
    let message: String
    /// Full error details suitable for display in a detail panel.
    let details: String?
    /// Brief hint guiding the user towards a fix.
    let suggestedAction: String?

    init(
        id: UUID = UUID(),
        timestamp: Date = Date(),
        severity: LogSeverity,
        source: String,
        message: String,
        details: String? = nil,
        suggestedAction: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.severity = severity
        self.source = source
        self.message = message
        self.details = details
        self.suggestedAction = suggestedAction
    }
}

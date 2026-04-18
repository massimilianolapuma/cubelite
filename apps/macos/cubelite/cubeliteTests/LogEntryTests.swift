import XCTest

@testable import cubelite

// MARK: - LogEntryTests

/// Unit tests for ``LogEntry`` model creation and properties.
final class LogEntryTests: XCTestCase {

    // MARK: - Identity

    func testInit_assignsUniqueIDs() {
        let e1 = LogEntry(severity: .info, source: "Test", message: "msg")
        let e2 = LogEntry(severity: .info, source: "Test", message: "msg")
        XCTAssertNotEqual(e1.id, e2.id, "Each LogEntry must have a unique UUID")
    }

    func testInit_preservesMessage() {
        let msg = "Connection refused to kube-api"
        let entry = LogEntry(severity: .error, source: "KubeAPIService", message: msg)
        XCTAssertEqual(entry.message, msg)
    }

    func testInit_preservesSource() {
        let source = "KubeconfigService"
        let entry = LogEntry(severity: .info, source: source, message: "ok")
        XCTAssertEqual(entry.source, source)
    }

    // MARK: - Severity Levels

    func testSeverity_info() {
        let entry = LogEntry(severity: .info, source: "Test", message: "msg")
        XCTAssertEqual(entry.severity, LogSeverity.info)
    }

    func testSeverity_warning() {
        let entry = LogEntry(severity: .warning, source: "Test", message: "msg")
        XCTAssertEqual(entry.severity, LogSeverity.warning)
    }

    func testSeverity_error() {
        let entry = LogEntry(severity: .error, source: "Test", message: "msg")
        XCTAssertEqual(entry.severity, LogSeverity.error)
    }

    // MARK: - Timestamp

    func testInit_timestampIsRecent() {
        let before = Date()
        let entry = LogEntry(severity: .info, source: "Test", message: "msg")
        let after = Date()
        XCTAssertGreaterThanOrEqual(entry.timestamp, before)
        XCTAssertLessThanOrEqual(entry.timestamp, after)
    }

    // MARK: - Identifiable

    func testIdentifiable_idIsStable() {
        let entry = LogEntry(severity: .warning, source: "Test", message: "something")
        let id1 = entry.id
        let id2 = entry.id
        XCTAssertEqual(id1, id2, "LogEntry.id must be stable across accesses")
    }

    // MARK: - LogSeverity distinctness

    func testSeverity_allCases_areDistinct() {
        // Validates that all severity levels are distinct from one another.
        XCTAssertNotEqual(LogSeverity.error, .warning)
        XCTAssertNotEqual(LogSeverity.error, .info)
        XCTAssertNotEqual(LogSeverity.warning, .info)
    }

    func testSeverity_rawValues_matchExpected() {
        XCTAssertEqual(LogSeverity.error.rawValue, "Error")
        XCTAssertEqual(LogSeverity.warning.rawValue, "Warning")
        XCTAssertEqual(LogSeverity.info.rawValue, "Info")
    }

    func testSeverity_identifiable_idEqualsRawValue() {
        for severity in LogSeverity.allCases {
            XCTAssertEqual(severity.id, severity.rawValue)
        }
    }

    func testLogEntry_details_defaultsToNil() {
        let entry = LogEntry(severity: .info, source: "Test", message: "msg")
        XCTAssertNil(entry.details)
    }

    func testLogEntry_suggestedAction_defaultsToNil() {
        let entry = LogEntry(severity: .info, source: "Test", message: "msg")
        XCTAssertNil(entry.suggestedAction)
    }

    func testLogEntry_withDetails_preservesDetails() {
        let entry = LogEntry(
            severity: .error,
            source: "TLS",
            message: "cert invalid",
            details: "certificate expired on 2024-01-01"
        )
        XCTAssertEqual(entry.details, "certificate expired on 2024-01-01")
    }

    func testLogEntry_withSuggestedAction_preservesAction() {
        let action = "Run: kubectl config view"
        let entry = LogEntry(
            severity: .warning,
            source: "Config",
            message: "context missing",
            suggestedAction: action
        )
        XCTAssertEqual(entry.suggestedAction, action)
    }
}

import XCTest
@testable import cubelite

@MainActor
final class LogStoreTests: XCTestCase {

    private var sut: LogStore!

    override func setUp() {
        super.setUp()
        sut = LogStore()
    }

    override func tearDown() {
        sut = nil
        super.tearDown()
    }

    // MARK: - append

    func testAppend_addsEntryToStore() {
        let entry = LogEntry(severity: .info, source: "Test", message: "Hello")
        sut.append(entry)
        XCTAssertEqual(sut.entries.count, 1)
        XCTAssertEqual(sut.entries.first?.id, entry.id)
    }

    func testAppend_multipleEntries_newestFirst() {
        let first = LogEntry(severity: .info, source: "Test", message: "First")
        let second = LogEntry(severity: .info, source: "Test", message: "Second")
        sut.append(first)
        sut.append(second)
        XCTAssertEqual(sut.entries[0].id, second.id)
        XCTAssertEqual(sut.entries[1].id, first.id)
    }

    // MARK: - clear

    func testClear_removesAllEntries() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "Err"))
        sut.append(LogEntry(severity: .info, source: "Test", message: "Info"))
        sut.clear()
        XCTAssertTrue(sut.entries.isEmpty)
    }

    func testClear_resetsUnreadErrorCount() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "Err"))
        sut.clear()
        XCTAssertEqual(sut.unreadErrorCount, 0)
    }

    // MARK: - capacity cap

    func testAppend_exceedsCapacity_dropsOldestEntries() {
        for i in 0..<501 {
            sut.append(LogEntry(severity: .info, source: "Test", message: "Entry \(i)"))
        }
        XCTAssertEqual(sut.entries.count, 500)
        XCTAssertEqual(sut.entries.first?.message, "Entry 500")
    }

    func testAppend_atExactCapacity_doesNotDrop() {
        for i in 0..<500 {
            sut.append(LogEntry(severity: .info, source: "Test", message: "Entry \(i)"))
        }
        XCTAssertEqual(sut.entries.count, 500)
    }

    // MARK: - unreadErrorCount

    func testUnreadErrorCount_initiallyZero() {
        XCTAssertEqual(sut.unreadErrorCount, 0)
    }

    func testUnreadErrorCount_incrementsForErrorsOnly() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "E1"))
        sut.append(LogEntry(severity: .warning, source: "Test", message: "W1"))
        sut.append(LogEntry(severity: .info, source: "Test", message: "I1"))
        XCTAssertEqual(sut.unreadErrorCount, 1)
    }

    func testUnreadErrorCount_zeroAfterMarkErrorsRead() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "E1"))
        sut.append(LogEntry(severity: .error, source: "Test", message: "E2"))
        sut.markErrorsRead()
        XCTAssertEqual(sut.unreadErrorCount, 0)
    }

    func testUnreadErrorCount_incrementsAfterMarkErrorsRead() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "E1"))
        sut.markErrorsRead()
        sut.append(LogEntry(severity: .error, source: "Test", message: "E2"))
        XCTAssertEqual(sut.unreadErrorCount, 1)
    }

    func testUnreadErrorCount_doesNotGoNegative() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "E1"))
        sut.markErrorsRead()
        sut.clear()
        XCTAssertEqual(sut.unreadErrorCount, 0)
    }

    // MARK: - clearOlderThan

    func testClearOlderThan_removesOldEntries() {
        let old = LogEntry(
            timestamp: Date(timeIntervalSinceNow: -120),
            severity: .info,
            source: "Test",
            message: "Old"
        )
        let recent = LogEntry(
            timestamp: Date(),
            severity: .info,
            source: "Test",
            message: "Recent"
        )
        sut.append(old)
        sut.append(recent)
        sut.clearOlderThan(60)
        XCTAssertEqual(sut.entries.count, 1)
        XCTAssertEqual(sut.entries.first?.message, "Recent")
    }

    func testClearOlderThan_keepsAllWhenNoneExpired() {
        sut.append(LogEntry(severity: .info, source: "Test", message: "Recent"))
        sut.clearOlderThan(60)
        XCTAssertEqual(sut.entries.count, 1)
    }

    func testClearOlderThan_removesAllWhenAllExpired() {
        sut.append(LogEntry(
            timestamp: Date(timeIntervalSinceNow: -200),
            severity: .info,
            source: "Test",
            message: "VeryOld"
        ))
        sut.clearOlderThan(60)
        XCTAssertTrue(sut.entries.isEmpty)
    }

    // MARK: - filter by severity

    func testFilterBySeverity_errorEntries() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "E"))
        sut.append(LogEntry(severity: .warning, source: "Test", message: "W"))
        sut.append(LogEntry(severity: .info, source: "Test", message: "I"))
        let errors = sut.entries.filter { $0.severity == .error }
        XCTAssertEqual(errors.count, 1)
        XCTAssertEqual(errors.first?.message, "E")
    }

    func testFilterBySeverity_warningEntries() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "E"))
        sut.append(LogEntry(severity: .warning, source: "Test", message: "W"))
        sut.append(LogEntry(severity: .info, source: "Test", message: "I"))
        let warnings = sut.entries.filter { $0.severity == .warning }
        XCTAssertEqual(warnings.count, 1)
        XCTAssertEqual(warnings.first?.message, "W")
    }

    func testFilterBySeverity_infoEntries() {
        sut.append(LogEntry(severity: .error, source: "Test", message: "E"))
        sut.append(LogEntry(severity: .info, source: "Test", message: "I"))
        let infoEntries = sut.entries.filter { $0.severity == .info }
        XCTAssertEqual(infoEntries.count, 1)
    }
}

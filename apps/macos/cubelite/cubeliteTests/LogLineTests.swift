import XCTest

@testable import cubelite

final class LogLineTests: XCTestCase {

    func testParse_rfc3339Prefix_splitsTimeAndMessage() {
        let line = LogLine.parse("2026-07-15T10:00:01.123456789Z hello world", id: 1)
        XCTAssertEqual(line.time, "10:00:01.123456789Z")
        XCTAssertEqual(line.message, "hello world")
    }

    func testParse_noTimestamp_keepsWholeMessage() {
        let line = LogLine.parse("plain line", id: 1)
        XCTAssertNil(line.time)
        XCTAssertEqual(line.message, "plain line")
    }

    func testParse_severityDetection() {
        XCTAssertEqual(LogLine.parse("ERROR boom", id: 1).level, .error)
        XCTAssertEqual(LogLine.parse("fatal: crash", id: 2).level, .error)
        XCTAssertEqual(LogLine.parse("WARN disk", id: 3).level, .warn)
        XCTAssertEqual(LogLine.parse("DEBUG verbose", id: 4).level, .debug)
        XCTAssertEqual(LogLine.parse("hello", id: 5).level, .info)
    }

    func testRingBuffer_capsAtLimit_keepsNewest() {
        var buffer = LogRingBuffer(cap: 3)
        for i in 0..<5 { buffer.append(LogLine.parse("line \(i)", id: i)) }
        XCTAssertEqual(buffer.lines.map(\.id), [2, 3, 4])
        XCTAssertEqual(buffer.totalAppended, 5)
    }

    func testRingBuffer_removeAll_resetsLinesNotTotal() {
        var buffer = LogRingBuffer(cap: 3)
        buffer.append(LogLine.parse("a", id: 0))
        buffer.removeAll()
        XCTAssertTrue(buffer.lines.isEmpty)
        XCTAssertEqual(buffer.totalAppended, 1)
    }
}

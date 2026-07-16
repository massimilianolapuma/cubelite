import XCTest

@testable import cubelite

@MainActor
final class LogSearchModelTests: XCTestCase {

    private func lines(_ messages: [String]) -> [LogLine] {
        messages.enumerated().map { LogLine.parse($0.element, id: $0.offset) }
    }

    func testRecompute_caseInsensitiveSubstring() {
        let model = LogSearchModel()
        model.query = "conn"
        model.recompute(over: lines(["DB CONNECTED", "idle", "connection lost"]))
        XCTAssertEqual(model.matchingLineIDs, [0, 2])
        XCTAssertTrue(model.isActive)
    }

    func testRecompute_emptyQuery_noMatches() {
        let model = LogSearchModel()
        model.query = ""
        model.recompute(over: lines(["a", "b"]))
        XCTAssertTrue(model.matchingLineIDs.isEmpty)
        XCTAssertFalse(model.isActive)
    }

    func testNext_advancesAndWraps() {
        let model = LogSearchModel()
        model.query = "x"
        model.recompute(over: lines(["x1", "y", "x2"]))
        model.next()
        XCTAssertEqual(model.activeLineID, 0)
        model.next()
        XCTAssertEqual(model.activeLineID, 2)
        model.next()
        XCTAssertEqual(model.activeLineID, 0)  // wraps
    }

    func testPrevious_wrapsBackwards() {
        let model = LogSearchModel()
        model.query = "x"
        model.recompute(over: lines(["x1", "y", "x2"]))
        model.previous()
        XCTAssertEqual(model.activeLineID, 2)  // wraps to last
    }

    func testRecompute_keepsActiveLineWhenStillMatching() {
        let model = LogSearchModel()
        model.query = "x"
        model.recompute(over: lines(["x1", "y", "x2"]))
        model.next()  // active = line 0
        model.recompute(over: lines(["x1", "y", "x2", "x3"]))
        XCTAssertEqual(model.activeLineID, 0)
    }

    func testVisibleLines_filterModeHidesNonMatching() {
        let model = LogSearchModel()
        model.query = "x"
        let all = lines(["x1", "y", "x2"])
        model.recompute(over: all)
        model.filterMode = true
        XCTAssertEqual(model.visibleLines(from: all).map(\.id), [0, 2])
        model.filterMode = false
        XCTAssertEqual(model.visibleLines(from: all).count, 3)
    }

    func testVisibleLines_filterWithEmptyQuery_showsAll() {
        let model = LogSearchModel()
        model.filterMode = true
        let all = lines(["a", "b"])
        model.recompute(over: all)
        XCTAssertEqual(model.visibleLines(from: all).count, 2)
    }

    func testClear_resetsQueryAndMatchesKeepsFilterFlag() {
        let model = LogSearchModel()
        model.query = "x"
        model.filterMode = true
        model.recompute(over: lines(["x"]))
        model.clear()
        XCTAssertEqual(model.query, "")
        XCTAssertTrue(model.matchingLineIDs.isEmpty)
        XCTAssertNil(model.activeMatchIndex)
        XCTAssertTrue(model.filterMode)
    }

    func testPerformance_recomputeOver5kLines() {
        let model = LogSearchModel()
        model.query = "error"
        let big = lines((0..<5000).map { "line \($0) some error text here" })
        measure { model.recompute(over: big) }
    }
}

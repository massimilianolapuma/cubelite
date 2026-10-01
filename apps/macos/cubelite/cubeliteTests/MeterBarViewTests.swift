import XCTest

@testable import cubelite

final class MeterBarViewTests: XCTestCase {

    func testLevelsFollowTheUnifiedThresholds() {
        XCTAssertEqual(MeterBarView.level(for: 0.0), .normal)
        XCTAssertEqual(MeterBarView.level(for: 0.59), .normal)
        XCTAssertEqual(MeterBarView.level(for: 0.6), .warn)
        XCTAssertEqual(MeterBarView.level(for: 0.749), .warn)
        XCTAssertEqual(MeterBarView.level(for: 0.75), .err)
        XCTAssertEqual(MeterBarView.level(for: 1.0), .err)
    }

    func testMissingFractionIsUnavailable() {
        XCTAssertEqual(MeterBarView.level(for: nil), .unavailable)
    }
}

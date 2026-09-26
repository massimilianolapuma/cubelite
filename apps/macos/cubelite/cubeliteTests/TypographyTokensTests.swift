import SwiftUI
import XCTest

@testable import cubelite

/// Guards the generated `DesignTokens.Typography` block against drift from
/// design/tokens.json (type scale v1.1).
final class TypographyTokensTests: XCTestCase {

    func testBody_isGeistMedium13() {
        let s = DesignTokens.Typography.body
        XCTAssertEqual(s.size, 13)
        XCTAssertEqual(s.weight, .medium)
        XCTAssertFalse(s.mono)
        XCTAssertFalse(s.uppercase)
        XCTAssertEqual(s.tracking, 0)
    }

    func testSection_isUppercaseTracked10() {
        let s = DesignTokens.Typography.section
        XCTAssertEqual(s.size, 10)
        XCTAssertEqual(s.weight, .semibold)
        XCTAssertTrue(s.uppercase)
        XCTAssertEqual(s.tracking, 0.07, accuracy: 0.0001)
    }

    func testStat_isMono22Semibold() {
        let s = DesignTokens.Typography.stat
        XCTAssertEqual(s.size, 22)
        XCTAssertEqual(s.weight, .semibold)
        XCTAssertTrue(s.mono)
    }

    func testAll_containsTwelveStylesNoneBelowTenPoints() {
        let all = DesignTokens.Typography.all
        XCTAssertEqual(all.count, 12)
        for entry in all {
            XCTAssertGreaterThanOrEqual(entry.style.size, 10, "\(entry.name) is below the HIG minimum")
        }
        XCTAssertEqual(all.map(\.name), [
            "display", "title", "subtitle", "body", "caption", "section",
            "colhead", "data", "dataSm", "log", "stat", "micro",
        ])
    }
}

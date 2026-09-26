import SwiftUI
import XCTest

@testable import cubelite

@MainActor
final class TypeStyleTests: XCTestCase {

    func testModifier_usesAnchorBucketOfTheStyleSize() {
        // body (13) → .title3 bucket, micro (10.5) → .body, section (10) → .caption
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.body).anchor, .title3)
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.micro).anchor, .body)
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.section).anchor, .caption)
    }

    func testModifier_keepsTokenSizeAtDefaultTextSize() {
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.stat).size, 22)
    }

    func testTrackingPoints_isEmTimesSize() {
        let m = TypeStyleModifier(style: DesignTokens.Typography.section)
        XCTAssertEqual(m.trackingPoints, 0.07 * 10, accuracy: 0.0001)
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.body).trackingPoints, 0)
    }

    func testTextCase_onlyForUppercaseStyles() {
        XCTAssertEqual(TypeStyleModifier(style: DesignTokens.Typography.colhead).textCase, .uppercase)
        XCTAssertNil(TypeStyleModifier(style: DesignTokens.Typography.body).textCase)
    }

    func testView_typeStyle_compiles() {
        _ = Text("x").typeStyle(DesignTokens.Typography.body)
        _ = Text("x").typeStyle(DesignTokens.Typography.stat, color: DesignTokens.textDataBright)
    }
}

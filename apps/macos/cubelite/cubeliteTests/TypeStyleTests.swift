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

    func testMonospacedKeepsEverythingButTheFamily() {
        let micro = DesignTokens.Typography.micro
        let mono = micro.monospaced
        XCTAssertTrue(mono.mono)
        XCTAssertEqual(mono.size, micro.size)
        XCTAssertEqual(mono.weight, micro.weight)
        XCTAssertEqual(mono.uppercase, micro.uppercase)
        XCTAssertEqual(mono.tracking, micro.tracking)
    }

    func testWeightedKeepsEverythingButTheWeight() {
        let bold = DesignTokens.Typography.micro.monospaced.weighted(.semibold)
        XCTAssertEqual(bold.weight, .semibold)
        XCTAssertTrue(bold.mono)
        XCTAssertEqual(bold.size, DesignTokens.Typography.micro.size)
    }

    func testIconTokensAreAscending() {
        let sizes = [DesignTokens.icon2xs, DesignTokens.iconXs, DesignTokens.iconSm, DesignTokens.iconMd]
        XCTAssertEqual(sizes, sizes.sorted())
    }

    func testViewIconSizeCompiles() {
        _ = Image(systemName: "chevron.down").iconSize(DesignTokens.iconXs)
        _ = Text("9").iconSize(DesignTokens.icon2xs, weight: .bold)
    }
}

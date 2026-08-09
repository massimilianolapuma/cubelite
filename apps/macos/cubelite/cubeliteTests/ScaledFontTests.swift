import SwiftUI
import XCTest

@testable import cubelite

// MARK: - ScaledFontModifier.anchor(for:) bucket mapping

@MainActor
final class ScaledFontTests: XCTestCase {

    // MARK: title3 bucket (>= 13)

    func testAnchor_size13_returnsTitle3() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 13), .title3)
    }

    func testAnchor_size14_returnsTitle3() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 14), .title3)
    }

    // MARK: body bucket (10.5...12.9)

    func testAnchor_size11_returnsBody() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 11), .body)
    }

    func testAnchor_size12_5_returnsBody() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 12.5), .body)
    }

    // MARK: caption bucket (<= 10.4)

    func testAnchor_size9_5_returnsCaption() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 9.5), .caption)
    }

    func testAnchor_size10_returnsCaption() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 10), .caption)
    }

    // MARK: boundaries

    func testAnchor_size10_4_returnsCaption() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 10.4), .caption)
    }

    func testAnchor_size10_5_returnsBody() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 10.5), .body)
    }

    func testAnchor_size12_9_returnsBody() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 12.9), .body)
    }

    func testAnchor_size13_0_returnsTitle3() {
        XCTAssertEqual(ScaledFontModifier.anchor(for: 13.0), .title3)
    }

    // MARK: init stores size/weight/design

    func testInit_storesWeightAndDesign() {
        let modifier = ScaledFontModifier(size: 11, weight: .semibold, design: .monospaced, relativeTo: .body)
        XCTAssertEqual(modifier.weight, .semibold)
        XCTAssertEqual(modifier.design, .monospaced)
    }

    func testInit_atDefaultTextSize_preservesInputSize() {
        // @ScaledMetric returns the wrapped value unchanged at the default
        // (unscaled) text size — pixel-identical to the fixed-size font this
        // modifier replaces.
        let modifier = ScaledFontModifier(size: 11, weight: .regular, design: .default, relativeTo: .body)
        XCTAssertEqual(modifier.size, 11, accuracy: 0.001)
    }

    func testInit_defaultSignature_matchesRelativeToBody() {
        let modifier = ScaledFontModifier(size: 14, weight: .bold, design: .rounded, relativeTo: .body)
        XCTAssertEqual(modifier.weight, .bold)
        XCTAssertEqual(modifier.design, .rounded)
        XCTAssertEqual(modifier.size, 14, accuracy: 0.001)
    }
}

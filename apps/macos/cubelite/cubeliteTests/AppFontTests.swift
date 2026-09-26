import AppKit
import SwiftUI
import XCTest

@testable import cubelite

final class AppFontTests: XCTestCase {

    // MARK: PostScript name mapping (three bundled weights per family)

    func testPostScriptName_sansRegular() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .regular), "Geist-Regular")
    }

    func testPostScriptName_sansMedium() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .medium), "Geist-Medium")
    }

    func testPostScriptName_sansSemibold() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .semibold), "Geist-SemiBold")
    }

    func testPostScriptName_boldClampsToSemibold() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .bold), "Geist-SemiBold")
        XCTAssertEqual(AppFont.postScriptName(mono: true, weight: .heavy), "GeistMono-SemiBold")
    }

    func testPostScriptName_lightClampsToRegular() {
        XCTAssertEqual(AppFont.postScriptName(mono: false, weight: .light), "Geist-Regular")
        XCTAssertEqual(AppFont.postScriptName(mono: true, weight: .thin), "GeistMono-Regular")
    }

    func testPostScriptName_mono() {
        XCTAssertEqual(AppFont.postScriptName(mono: true, weight: .medium), "GeistMono-Medium")
    }

    // MARK: Bundle registration (ATSApplicationFontsPath)

    func testBundledFonts_resolveThroughCoreText() {
        for name in [
            "Geist-Regular", "Geist-Medium", "Geist-SemiBold",
            "GeistMono-Regular", "GeistMono-Medium", "GeistMono-SemiBold",
        ] {
            XCTAssertNotNil(NSFont(name: name, size: 13), "\(name) is not registered — check Resources/Fonts and ATSApplicationFontsPath")
        }
        XCTAssertTrue(AppFont.isAvailable)
    }
}

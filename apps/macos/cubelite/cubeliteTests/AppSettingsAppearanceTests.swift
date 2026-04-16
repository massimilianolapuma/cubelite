import XCTest
import SwiftUI
@testable import cubelite

// MARK: - AppSettingsAppearanceTests

/// Tests that `AppSettings.colorScheme` maps each `AppearanceMode` correctly
/// and that the setting round-trips through `UserDefaults`.
@MainActor
final class AppSettingsAppearanceTests: XCTestCase {

    private let appearanceKey = "appearanceMode"

    override func tearDown() {
        super.tearDown()
        // Clean up UserDefaults after each test to avoid cross-test contamination.
        UserDefaults.standard.removeObject(forKey: appearanceKey)
    }

    // MARK: - colorScheme mapping

    func testColorScheme_system_returnsNil() {
        let sut = AppSettings()
        sut.appearanceMode = .system

        XCTAssertNil(sut.colorScheme)
    }

    func testColorScheme_light_returnsLight() {
        let sut = AppSettings()
        sut.appearanceMode = .light

        XCTAssertEqual(sut.colorScheme, .light)
    }

    func testColorScheme_dark_returnsDark() {
        let sut = AppSettings()
        sut.appearanceMode = .dark

        XCTAssertEqual(sut.colorScheme, .dark)
    }

    // MARK: - UserDefaults persistence

    func testAppearanceMode_persists_throughUserDefaults() {
        let sut = AppSettings()
        sut.appearanceMode = .dark

        // Re-create to simulate app restart reading saved value.
        let sut2 = AppSettings()

        XCTAssertEqual(sut2.appearanceMode, .dark)
        XCTAssertEqual(sut2.colorScheme, .dark)
    }

    func testAppearanceMode_light_persists_throughUserDefaults() {
        let sut = AppSettings()
        sut.appearanceMode = .light

        let sut2 = AppSettings()

        XCTAssertEqual(sut2.appearanceMode, .light)
        XCTAssertEqual(sut2.colorScheme, .light)
    }

    func testAppearanceMode_defaultsToSystem_whenNoSavedValue() {
        // Ensure no prior value exists.
        UserDefaults.standard.removeObject(forKey: appearanceKey)

        let sut = AppSettings()

        XCTAssertEqual(sut.appearanceMode, .system)
        XCTAssertNil(sut.colorScheme)
    }
}

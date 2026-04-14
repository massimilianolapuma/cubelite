import XCTest
@testable import cubelite

/// Unit tests for ``AppSettings``.
@MainActor
final class PreferencesTests: XCTestCase {

    // MARK: - Helpers

    /// Keys used by AppSettings in UserDefaults.
    private typealias Keys = AppSettings.Keys

    /// Removes all AppSettings keys from UserDefaults so each test starts clean.
    private func resetDefaults() {
        let d = UserDefaults.standard
        [Keys.autoRefreshInterval,
         Keys.launchAtLogin,
         Keys.showSystemNamespaces,
         Keys.appearanceMode,
         Keys.menuBarIconStyle,
         Keys.kubeconfigPath,
         Keys.apiTimeout,
         Keys.skipTLSVerification].forEach { d.removeObject(forKey: $0) }
    }

    override func setUp() async throws {
        try await super.setUp()
        resetDefaults()
    }

    override func tearDown() async throws {
        resetDefaults()
        try await super.tearDown()
    }

    // MARK: - Default Values

    func testDefaultAutoRefreshInterval() {
        let sut = AppSettings()
        XCTAssertEqual(sut.autoRefreshInterval, 30)
    }

    func testDefaultLaunchAtLogin() {
        let sut = AppSettings()
        XCTAssertFalse(sut.launchAtLogin)
    }

    func testDefaultShowSystemNamespaces() {
        let sut = AppSettings()
        XCTAssertFalse(sut.showSystemNamespaces)
    }

    func testDefaultAppearanceMode() {
        let sut = AppSettings()
        XCTAssertEqual(sut.appearanceMode, .system)
    }

    func testDefaultMenuBarIconStyle() {
        let sut = AppSettings()
        XCTAssertEqual(sut.menuBarIconStyle, .default)
    }

    func testDefaultKubeconfigPath() {
        let sut = AppSettings()
        XCTAssertEqual(sut.kubeconfigPath, "")
    }

    func testDefaultApiTimeout() {
        let sut = AppSettings()
        XCTAssertEqual(sut.apiTimeout, 30)
    }

    // MARK: - Persistence Round-Trip

    func testAutoRefreshIntervalPersists() {
        let sut = AppSettings()
        sut.autoRefreshInterval = 60
        let sut2 = AppSettings()
        XCTAssertEqual(sut2.autoRefreshInterval, 60)
    }

    func testLaunchAtLoginPersists() {
        let sut = AppSettings()
        sut.launchAtLogin = true
        let sut2 = AppSettings()
        XCTAssertTrue(sut2.launchAtLogin)
    }

    func testShowSystemNamespacesPersists() {
        let sut = AppSettings()
        sut.showSystemNamespaces = true
        let sut2 = AppSettings()
        XCTAssertTrue(sut2.showSystemNamespaces)
    }

    func testAppearanceModePersists() {
        let sut = AppSettings()
        sut.appearanceMode = .dark
        let sut2 = AppSettings()
        XCTAssertEqual(sut2.appearanceMode, .dark)
    }

    func testMenuBarIconStylePersists() {
        let sut = AppSettings()
        sut.menuBarIconStyle = .monochrome
        let sut2 = AppSettings()
        XCTAssertEqual(sut2.menuBarIconStyle, .monochrome)
    }

    func testKubeconfigPathPersists() {
        let sut = AppSettings()
        sut.kubeconfigPath = "/Users/test/.kube/custom-config"
        let sut2 = AppSettings()
        XCTAssertEqual(sut2.kubeconfigPath, "/Users/test/.kube/custom-config")
    }

    func testApiTimeoutPersists() {
        let sut = AppSettings()
        sut.apiTimeout = 45
        let sut2 = AppSettings()
        XCTAssertEqual(sut2.apiTimeout, 45)
    }

    // MARK: - Valid Refresh Intervals

    func testAllRefreshIntervalOptionsAreValid() {
        let validIntervals = [0, 15, 30, 60, 120]
        let sut = AppSettings()
        for interval in validIntervals {
            sut.autoRefreshInterval = interval
            XCTAssertEqual(sut.autoRefreshInterval, interval,
                           "Interval \(interval) should be stored as-is")
        }
    }

    // MARK: - API Timeout Range

    func testApiTimeoutBelowMinimumClampsOnLoad() {
        UserDefaults.standard.set(1, forKey: Keys.apiTimeout)
        let sut = AppSettings()
        XCTAssertGreaterThanOrEqual(sut.apiTimeout, 5,
                                    "Timeout below minimum should be clamped to 5 on load")
    }

    func testApiTimeoutAboveMaximumClampsOnLoad() {
        UserDefaults.standard.set(999, forKey: Keys.apiTimeout)
        let sut = AppSettings()
        XCTAssertLessThanOrEqual(sut.apiTimeout, 120,
                                  "Timeout above maximum should be clamped to 120 on load")
    }

    // MARK: - Skip TLS Verification

    func testSkipTLSVerificationDefault() {
        let sut = AppSettings()
        XCTAssertFalse(sut.skipTLSVerification)
    }

    func testSkipTLSVerificationPersistence() {
        let sut = AppSettings()
        sut.skipTLSVerification = true
        XCTAssertTrue(UserDefaults.standard.bool(forKey: Keys.skipTLSVerification))
    }

    func testSkipTLSVerificationLoadFromDefaults() {
        UserDefaults.standard.set(true, forKey: Keys.skipTLSVerification)
        let sut = AppSettings()
        XCTAssertTrue(sut.skipTLSVerification)
    }

    func testApiTimeoutAtBoundaries() {
        let sut = AppSettings()
        sut.apiTimeout = 5
        XCTAssertEqual(sut.apiTimeout, 5)
        sut.apiTimeout = 120
        XCTAssertEqual(sut.apiTimeout, 120)
    }

    // MARK: - Appearance Mode Cases

    func testAllAppearanceModesCoveredByLabel() {
        for mode in AppSettings.AppearanceMode.allCases {
            XCTAssertFalse(mode.label.isEmpty,
                           "AppearanceMode.\(mode.rawValue) must have a non-empty label")
        }
    }

    // MARK: - Menu Bar Icon Style Cases

    func testAllMenuBarIconStylesCoveredByLabel() {
        for style in AppSettings.MenuBarIconStyle.allCases {
            XCTAssertFalse(style.label.isEmpty,
                           "MenuBarIconStyle.\(style.rawValue) must have a non-empty label")
        }
    }
}

import XCTest

@testable import cubelite

/// Unit tests for ``AppSettings``.
@MainActor
final class PreferencesTests: XCTestCase {

    /// A domain of its own, emptied for each test (#482).
    private lazy var defaults = TestDefaults.fresh(for: Self.self)

    // MARK: - Helpers

    /// Keys used by AppSettings in UserDefaults.
    private typealias Keys = AppSettings.Keys

    /// Removes all AppSettings keys from UserDefaults so each test starts clean.
    private func resetDefaults() {
        let d = defaults
        [
            Keys.autoRefreshInterval,
            Keys.launchAtLogin,
            Keys.showSystemNamespaces,
            Keys.appearanceMode,
            Keys.menuBarIconStyle,
            Keys.kubeconfigPath,
            Keys.kubeconfigPaths,
            Keys.apiTimeout,
            Keys.skipTLSVerification,
            Keys.contextNamespaces,
        ].forEach { d.removeObject(forKey: $0) }
    }

    override func setUp() async throws {
        resetDefaults()
    }

    override func tearDown() async throws {
        resetDefaults()
    }

    // MARK: - Default Values

    func testDefaultAutoRefreshInterval() {
        let sut = AppSettings(defaults: defaults)
        XCTAssertEqual(sut.autoRefreshInterval, 30)
    }

    func testDefaultLaunchAtLogin() {
        let sut = AppSettings(defaults: defaults)
        XCTAssertFalse(sut.launchAtLogin)
    }

    func testDefaultShowSystemNamespaces() {
        let sut = AppSettings(defaults: defaults)
        XCTAssertFalse(sut.showSystemNamespaces)
    }

    func testDefaultAppearanceMode() {
        let sut = AppSettings(defaults: defaults)
        XCTAssertEqual(sut.appearanceMode, .system)
    }

    func testDefaultMenuBarIconStyle() {
        let sut = AppSettings(defaults: defaults)
        XCTAssertEqual(sut.menuBarIconStyle, .standard)
    }

    func testDefaultKubeconfigPaths() {
        let sut = AppSettings(defaults: defaults)
        XCTAssertTrue(sut.kubeconfigPaths.isEmpty)
    }

    func testDefaultApiTimeout() {
        let sut = AppSettings(defaults: defaults)
        XCTAssertEqual(sut.apiTimeout, 30)
    }

    // MARK: - Persistence Round-Trip

    func testAutoRefreshIntervalPersists() {
        let sut = AppSettings(defaults: defaults)
        sut.autoRefreshInterval = 60
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertEqual(sut2.autoRefreshInterval, 60)
    }

    func testLaunchAtLoginPersists() {
        let sut = AppSettings(defaults: defaults)
        sut.launchAtLogin = true
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertTrue(sut2.launchAtLogin)
    }

    func testShowSystemNamespacesPersists() {
        let sut = AppSettings(defaults: defaults)
        sut.showSystemNamespaces = true
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertTrue(sut2.showSystemNamespaces)
    }

    func testAppearanceModePersists() {
        let sut = AppSettings(defaults: defaults)
        sut.appearanceMode = .dark
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertEqual(sut2.appearanceMode, .dark)
    }

    func testMenuBarIconStylePersists() {
        let sut = AppSettings(defaults: defaults)
        sut.menuBarIconStyle = .monochrome
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertEqual(sut2.menuBarIconStyle, .monochrome)
    }

    func testKubeconfigPathsPersists() {
        let sut = AppSettings(defaults: defaults)
        sut.kubeconfigPaths = ["/Users/test/.kube/custom-config", "/tmp/extra-config"]
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertEqual(
            sut2.kubeconfigPaths, ["/Users/test/.kube/custom-config", "/tmp/extra-config"])
    }

    func testKubeconfigPathLegacyMigration() {
        defaults.set("/Users/test/.kube/legacy-config", forKey: Keys.kubeconfigPath)
        let sut = AppSettings(defaults: defaults)
        XCTAssertEqual(sut.kubeconfigPaths, ["/Users/test/.kube/legacy-config"])
        XCTAssertNil(
            defaults.string(forKey: Keys.kubeconfigPath),
            "Legacy key should be removed after migration")
    }

    func testApiTimeoutPersists() {
        let sut = AppSettings(defaults: defaults)
        sut.apiTimeout = 45
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertEqual(sut2.apiTimeout, 45)
    }

    // MARK: - Shared instance semantics (regression: issue #105)

    /// Mutations to `contextNamespaces` on one instance must be visible to a
    /// freshly-loaded instance backed by the same UserDefaults. This guards
    /// against regressing to per-callsite throwaway `AppSettings(defaults: defaults)` objects
    /// that previously discarded namespace edits made from `MainView`.
    func testContextNamespacesPersistsAcrossInstances() {
        let sut = AppSettings(defaults: defaults)
        sut.contextNamespaces["prod"] = ["team-a", "team-b"]
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertEqual(sut2.contextNamespaces["prod"], ["team-a", "team-b"])
    }

    func testContextNamespacesAppendIsPersisted() {
        let sut = AppSettings(defaults: defaults)
        sut.contextNamespaces["staging"] = ["default"]
        // Simulate `addManualNamespace` reading + writing through the shared
        // instance: read, append, write back.
        var saved = sut.contextNamespaces["staging"] ?? []
        saved.append("qa")
        sut.contextNamespaces["staging"] = saved

        let reloaded = AppSettings(defaults: defaults)
        XCTAssertEqual(reloaded.contextNamespaces["staging"], ["default", "qa"])
    }

    // MARK: - Valid Refresh Intervals

    func testAllRefreshIntervalOptionsAreValid() {
        let validIntervals = [0, 15, 30, 60, 120]
        let sut = AppSettings(defaults: defaults)
        for interval in validIntervals {
            sut.autoRefreshInterval = interval
            XCTAssertEqual(
                sut.autoRefreshInterval, interval,
                "Interval \(interval) should be stored as-is")
        }
    }

    // MARK: - API Timeout Range

    func testApiTimeoutBelowMinimumClampsOnLoad() {
        defaults.set(1, forKey: Keys.apiTimeout)
        let sut = AppSettings(defaults: defaults)
        XCTAssertGreaterThanOrEqual(
            sut.apiTimeout, 5,
            "Timeout below minimum should be clamped to 5 on load")
    }

    func testApiTimeoutAboveMaximumClampsOnLoad() {
        defaults.set(999, forKey: Keys.apiTimeout)
        let sut = AppSettings(defaults: defaults)
        XCTAssertLessThanOrEqual(
            sut.apiTimeout, 120,
            "Timeout above maximum should be clamped to 120 on load")
    }

    // MARK: - Skip TLS Verification

    func testSkipTLSVerificationDefault() {
        let sut = AppSettings(defaults: defaults)
        XCTAssertFalse(sut.skipTLSVerification)
    }

    func testSkipTLSVerificationPersistence() {
        let sut = AppSettings(defaults: defaults)
        sut.skipTLSVerification = true
        XCTAssertTrue(defaults.bool(forKey: Keys.skipTLSVerification))
    }

    func testSkipTLSVerificationLoadFromDefaults() {
        defaults.set(true, forKey: Keys.skipTLSVerification)
        let sut = AppSettings(defaults: defaults)
        XCTAssertTrue(sut.skipTLSVerification)
    }

    func testApiTimeoutAtBoundaries() {
        let sut = AppSettings(defaults: defaults)
        sut.apiTimeout = 5
        XCTAssertEqual(sut.apiTimeout, 5)
        sut.apiTimeout = 120
        XCTAssertEqual(sut.apiTimeout, 120)
    }

    // MARK: - Appearance Mode Cases

    func testAllAppearanceModesCoveredByLabel() {
        for mode in AppSettings.AppearanceMode.allCases {
            XCTAssertFalse(
                mode.label.isEmpty,
                "AppearanceMode.\(mode.rawValue) must have a non-empty label")
        }
    }

    // MARK: - Menu Bar Icon Style Cases

    func testAllMenuBarIconStylesCoveredByLabel() {
        for style in AppSettings.MenuBarIconStyle.allCases {
            XCTAssertFalse(
                style.label.isEmpty,
                "MenuBarIconStyle.\(style.rawValue) must have a non-empty label")
        }
    }
}

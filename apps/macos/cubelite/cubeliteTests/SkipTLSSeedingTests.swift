import XCTest

@testable import cubelite

/// #309 — the TLS-skip flag must reach the session factory even when no
/// MainView lifecycle hook ever fires (Settings-only toggle, startup race).
final class SkipTLSSeedingTests: XCTestCase {

    /// Fresh suite per call so the non-Sendable instance can be sent into
    /// the actor init (region isolation) without crossing this test class.
    private static func makeDefaults(skip: Bool?) -> UserDefaults {
        let defaults = UserDefaults(suiteName: "SkipTLSSeedingTests")!
        defaults.removePersistentDomain(forName: "SkipTLSSeedingTests")
        if let skip {
            defaults.set(skip, forKey: AppSettings.Keys.skipTLSVerification)
        }
        return defaults
    }

    func testInit_seedsSkipFlagFromPersistedSetting() async {
        let defaults = Self.makeDefaults(skip: true)
        let service = KubeAPIService(
            kubeconfigService: KubeconfigService(), defaults: defaults)
        let skipping = await service.isSkippingTLSVerification
        XCTAssertTrue(skipping)
    }

    func testInit_defaultsToStrictVerification() async {
        let defaults = Self.makeDefaults(skip: nil)
        let service = KubeAPIService(
            kubeconfigService: KubeconfigService(), defaults: defaults)
        let skipping = await service.isSkippingTLSVerification
        XCTAssertFalse(skipping)
    }

    func testUpdateSkipTLS_overridesSeededValue() async {
        let defaults = Self.makeDefaults(skip: true)
        let service = KubeAPIService(
            kubeconfigService: KubeconfigService(), defaults: defaults)
        await service.updateSkipTLS(false)
        let skipping = await service.isSkippingTLSVerification
        XCTAssertFalse(skipping)
    }
}

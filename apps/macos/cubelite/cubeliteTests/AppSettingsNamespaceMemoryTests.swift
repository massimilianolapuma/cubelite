import XCTest

@testable import cubelite

// MARK: - AppSettingsNamespaceMemoryTests

/// Tests that the last-selected namespace per context is remembered,
/// recalled, and persisted through `UserDefaults`.
@MainActor
final class AppSettingsNamespaceMemoryTests: XCTestCase {

    private let lastNamespacesKey = "lastNamespaces"

    override func tearDown() {
        super.tearDown()
        UserDefaults.standard.removeObject(forKey: lastNamespacesKey)
    }

    func testRecall_withoutRecord_returnsNone() {
        let sut = AppSettings()

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .none)
    }

    func testRemember_namedNamespace_isRecalled() {
        let sut = AppSettings()
        sut.rememberNamespace("monitoring", for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .named("monitoring"))
    }

    func testRemember_nil_isRecalledAsAllNamespaces() {
        let sut = AppSettings()
        sut.rememberNamespace(nil, for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .all)
    }

    func testRemember_isScopedPerContext() {
        let sut = AppSettings()
        sut.rememberNamespace("monitoring", for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "staging"), .none)
    }

    func testRemember_persists_throughUserDefaults() {
        let sut = AppSettings()
        sut.rememberNamespace("kube-system", for: "dev")
        sut.rememberNamespace(nil, for: "prod")

        // Re-create to simulate app restart reading saved values.
        let sut2 = AppSettings()
        XCTAssertEqual(sut2.recallNamespace(for: "dev"), .named("kube-system"))
        XCTAssertEqual(sut2.recallNamespace(for: "prod"), .all)
    }
}

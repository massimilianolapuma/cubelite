import XCTest

@testable import cubelite

// MARK: - AppSettingsNamespaceMemoryTests

/// Tests that the last-selected namespace per context is remembered,
/// recalled, and persisted through `UserDefaults`.
@MainActor
final class AppSettingsNamespaceMemoryTests: XCTestCase {

    /// A domain of its own, emptied for each test (#482).
    private lazy var defaults = TestDefaults.fresh(for: Self.self)

    private let lastNamespacesKey = "lastNamespaces"


    func testRecall_withoutRecord_returnsNone() {
        let sut = AppSettings(defaults: defaults)

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .none)
    }

    func testRemember_namedNamespace_isRecalled() {
        let sut = AppSettings(defaults: defaults)
        sut.rememberNamespace("monitoring", for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .named("monitoring"))
    }

    func testRemember_nil_isRecalledAsAllNamespaces() {
        let sut = AppSettings(defaults: defaults)
        sut.rememberNamespace(nil, for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "prod"), .all)
    }

    func testRemember_isScopedPerContext() {
        let sut = AppSettings(defaults: defaults)
        sut.rememberNamespace("monitoring", for: "prod")

        XCTAssertEqual(sut.recallNamespace(for: "staging"), .none)
    }

    func testRemember_persists_throughUserDefaults() {
        let sut = AppSettings(defaults: defaults)
        sut.rememberNamespace("kube-system", for: "dev")
        sut.rememberNamespace(nil, for: "prod")

        // Re-create to simulate app restart reading saved values.
        let sut2 = AppSettings(defaults: defaults)
        XCTAssertEqual(sut2.recallNamespace(for: "dev"), .named("kube-system"))
        XCTAssertEqual(sut2.recallNamespace(for: "prod"), .all)
    }
}

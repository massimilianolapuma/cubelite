import XCTest

@testable import cubelite

// MARK: - MainViewErrorMappingTests

/// Tests for ``MainView/mapResourceFatalError(_:)`` — the safe error-to-UI
/// mapping that replaced a force cast (`error as! CubeliteError`).
///
/// Guards against regressions of #104: passing a non-`CubeliteError`
/// (e.g. `URLError`, decoding error) must NOT crash and must fall back to a
/// generic error log entry.
@MainActor
final class MainViewErrorMappingTests: XCTestCase {

    // MARK: - Fallback path (non-CubeliteError)

    func testMapResourceFatalError_URLError_doesNotCrash_andFallsBack() {
        let urlError = URLError(.notConnectedToInternet)

        let mapping = MainView.mapResourceFatalError(urlError)

        XCTAssertEqual(mapping.severity, .error)
        XCTAssertEqual(mapping.message, urlError.localizedDescription)
        XCTAssertNil(
            mapping.clusterReachable,
            "Non-CubeliteError must not toggle the cluster reachability flag")
        XCTAssertNil(mapping.suggestedAction)
        XCTAssertNotNil(mapping.details)
    }

    func testMapResourceFatalError_NSError_fallsBackToGenericMapping() {
        let nsError = NSError(
            domain: "Test", code: 42,
            userInfo: [NSLocalizedDescriptionKey: "boom"])

        let mapping = MainView.mapResourceFatalError(nsError)

        XCTAssertEqual(mapping.severity, .error)
        XCTAssertEqual(mapping.message, "boom")
        XCTAssertNil(mapping.clusterReachable)
    }

    struct ArbitraryError: Error {}

    func testMapResourceFatalError_arbitrarySwiftError_doesNotCrash() {
        let mapping = MainView.mapResourceFatalError(ArbitraryError())

        XCTAssertEqual(mapping.severity, .error)
        XCTAssertNil(mapping.clusterReachable)
    }

    // MARK: - CubeliteError paths

    func testMapResourceFatalError_clusterUnreachable_marksUnreachable_withSuggestedAction() {
        let mapping = MainView.mapResourceFatalError(CubeliteError.clusterUnreachable)

        XCTAssertEqual(mapping.severity, .warning)
        XCTAssertEqual(mapping.clusterReachable, false)
        XCTAssertNotNil(mapping.suggestedAction)
        XCTAssertNil(mapping.details)
    }

    func testMapResourceFatalError_tlsError_marksUnreachable_withDetails() {
        let mapping = MainView.mapResourceFatalError(
            CubeliteError.tlsError(reason: "self-signed cert"))

        XCTAssertEqual(mapping.severity, .error)
        XCTAssertEqual(mapping.clusterReachable, false)
        XCTAssertNil(mapping.suggestedAction)
        XCTAssertNotNil(mapping.details)
    }

    func testMapResourceFatalError_genericCubeliteError_leavesReachabilityUntouched() {
        let mapping = MainView.mapResourceFatalError(
            CubeliteError.clientError(reason: "HTTP 500"))

        XCTAssertEqual(mapping.severity, .error)
        XCTAssertNil(
            mapping.clusterReachable,
            "Generic CubeliteError variants must not toggle reachability")
        XCTAssertNotNil(mapping.details)
    }
}

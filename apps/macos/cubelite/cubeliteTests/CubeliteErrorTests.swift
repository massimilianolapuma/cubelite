import XCTest

@testable import cubelite

// MARK: - CubeliteErrorDetailedTests

/// Extended tests for all ``CubeliteError`` cases, verifying per-case
/// reason strings, the two cases not covered by the baseline suite
/// (`clusterUnreachable` and `tlsError`), and the full nine-case inventory.
final class CubeliteErrorDetailedTests: XCTestCase {

    // MARK: - fileNotFound

    func testFileNotFound_errorDescription_containsPath() {
        let error = CubeliteError.fileNotFound(path: "/tmp/missing.yaml")
        XCTAssertNotNil(error.errorDescription)
        XCTAssertTrue(
            error.errorDescription?.contains("/tmp/missing.yaml") == true,
            "errorDescription should include the path"
        )
    }

    func testFileNotFound_errorDescription_isNonEmpty() {
        let error = CubeliteError.fileNotFound(path: "/some/path")
        XCTAssertFalse(error.errorDescription?.isEmpty == true)
    }

    // MARK: - parseError

    func testParseError_errorDescription_containsReason() {
        let reason = "unexpected YAML key 'foo'"
        let error = CubeliteError.parseError(reason: reason)
        XCTAssertTrue(
            error.errorDescription?.contains(reason) == true,
            "errorDescription should include the parse reason"
        )
    }

    // MARK: - contextNotFound

    func testContextNotFound_errorDescription_containsName() {
        let name = "missing-ctx"
        let error = CubeliteError.contextNotFound(name: name)
        XCTAssertTrue(
            error.errorDescription?.contains(name) == true,
            "errorDescription should include the context name"
        )
    }

    // MARK: - mergeError

    func testMergeError_errorDescription_containsReason() {
        let reason = "conflicting cluster definitions"
        let error = CubeliteError.mergeError(reason: reason)
        XCTAssertTrue(
            error.errorDescription?.contains(reason) == true,
            "errorDescription should include the merge reason"
        )
    }

    // MARK: - clientError

    func testClientError_errorDescription_containsReason() {
        let reason = "HTTP 403 Forbidden"
        let error = CubeliteError.clientError(reason: reason)
        XCTAssertTrue(
            error.errorDescription?.contains(reason) == true,
            "errorDescription should include the client error reason"
        )
    }

    // MARK: - ioError

    func testIOError_errorDescription_containsReason() {
        let reason = "permission denied"
        let error = CubeliteError.ioError(reason: reason)
        XCTAssertTrue(
            error.errorDescription?.contains(reason) == true,
            "errorDescription should include the I/O reason"
        )
    }

    // MARK: - keychainError

    func testKeychainError_errorDescription_containsReason() {
        let reason = "errSecItemNotFound"
        let error = CubeliteError.keychainError(reason: reason)
        XCTAssertTrue(
            error.errorDescription?.contains(reason) == true,
            "errorDescription should include the keychain reason"
        )
    }

    // MARK: - clusterUnreachable

    func testClusterUnreachable_errorDescription_isNonEmpty() {
        let error = CubeliteError.clusterUnreachable
        XCTAssertNotNil(error.errorDescription)
        XCTAssertFalse(error.errorDescription?.isEmpty == true)
    }

    func testClusterUnreachable_errorDescription_mentionsReachability() {
        let error = CubeliteError.clusterUnreachable
        // The description should communicate the cluster is not reachable.
        let desc = error.errorDescription?.lowercased() ?? ""
        XCTAssertTrue(
            desc.contains("reachable") || desc.contains("cluster"),
            "errorDescription should mention cluster reachability, got: '\(desc)'"
        )
    }

    // MARK: - tlsError

    func testTLSError_errorDescription_containsReason() {
        let reason = "certificate has expired"
        let error = CubeliteError.tlsError(reason: reason)
        XCTAssertTrue(
            error.errorDescription?.contains(reason) == true,
            "errorDescription should include the TLS reason"
        )
    }

    func testTLSError_errorDescription_mentionsTLS() {
        let error = CubeliteError.tlsError(reason: "untrusted issuer")
        let desc = error.errorDescription?.lowercased() ?? ""
        XCTAssertTrue(
            desc.contains("tls") || desc.contains("certificate"),
            "errorDescription should mention TLS/certificate, got: '\(desc)'"
        )
    }

    // MARK: - forbidden

    func testForbidden_errorDescription_containsResource() {
        let error = CubeliteError.forbidden(resource: "pods", reason: "RBAC denied")
        XCTAssertTrue(
            error.errorDescription?.contains("pods") == true,
            "errorDescription should include the forbidden resource"
        )
    }

    func testForbidden_errorDescription_mentionsPermissions() {
        let error = CubeliteError.forbidden(resource: "pods", reason: "RBAC denied")
        let desc = error.errorDescription?.lowercased() ?? ""
        XCTAssertTrue(
            desc.contains("permission") || desc.contains("denied") || desc.contains("access"),
            "errorDescription should mention permissions, got: '\(desc)'"
        )
    }

    func testForbidden_errorDescription_suggestsNamespace() {
        let error = CubeliteError.forbidden(resource: "pods", reason: "RBAC denied")
        let desc = error.errorDescription?.lowercased() ?? ""
        XCTAssertTrue(
            desc.contains("namespace"),
            "errorDescription should suggest selecting a namespace, got: '\(desc)'"
        )
    }

    // MARK: - LocalizedError conformance

    func testAllCases_errorDescription_areNonNil() {
        let allErrors: [CubeliteError] = [
            .fileNotFound(path: "/test"),
            .parseError(reason: "r"),
            .contextNotFound(name: "ctx"),
            .mergeError(reason: "r"),
            .clientError(reason: "r"),
            .ioError(reason: "r"),
            .keychainError(reason: "r"),
            .clusterUnreachable,
            .tlsError(reason: "r"),
            .forbidden(resource: "pods", reason: "r"),
        ]
        for error in allErrors {
            XCTAssertNotNil(
                error.errorDescription,
                "errorDescription must never be nil for \(error)"
            )
        }
    }
}

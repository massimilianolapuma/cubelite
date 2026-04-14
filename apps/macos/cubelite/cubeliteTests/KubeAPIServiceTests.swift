import XCTest
@testable import cubelite

// MARK: - KubeAPIService Tests
//
// Tests for the SSL/TLS helpers in KubeAPIService:
//   - pemToDER:             PEM stripping and base64 decoding
//   - loadCACertificate:    cert loading from inline base64 and file path
//   - isTLSError:           TLS error code classification
//   - isConnectionError:    connection error code classification
//   - CubeliteError.tlsError: error description

// MARK: - pemToDER Tests

final class PemToDERTests: XCTestCase {

    // MARK: Valid PEM

    func testPemToDER_validPEM_returnsCorrectDER() throws {
        // Use known bytes, encode as base64, wrap in PEM markers,
        // then verify pemToDER strips headers and returns the original bytes.
        let knownBytes: [UInt8] = [0x30, 0x82, 0x01, 0xAA, 0xFF, 0x00, 0x12]
        let base64 = Data(knownBytes).base64EncodedString()
        let pem = "-----BEGIN CERTIFICATE-----\n\(base64)\n-----END CERTIFICATE-----\n"

        let result = try KubeAPIService.pemToDER(Data(pem.utf8))

        XCTAssertEqual(Array(result), knownBytes)
    }

    func testPemToDER_pemWithWindowsLineEndings_stripsHeadersCorrectly() throws {
        let knownBytes: [UInt8] = [0xDE, 0xAD, 0xBE, 0xEF]
        let base64 = Data(knownBytes).base64EncodedString()
        let pem = "-----BEGIN CERTIFICATE-----\r\n\(base64)\r\n-----END CERTIFICATE-----\r\n"

        let result = try KubeAPIService.pemToDER(Data(pem.utf8))

        XCTAssertEqual(Array(result), knownBytes)
    }

    func testPemToDER_validCertificatePEM_returnsDERUsableBySecCertificate() throws {
        // This test uses a real self-signed test certificate generated for this test suite.
        // The PEM was generated with: openssl req -x509 -newkey rsa:2048 -days 36500 -nodes -subj '/CN=CubeLite Test CA'
        let pemString = """
        -----BEGIN CERTIFICATE-----
        MIICtDCCAZwCCQDkh6vhWkfH9zANBgkqhkiG9w0BAQsFADAbMRkwFwYDVQQDDBBD
        dWJlTGl0ZSBUZXN0IENBMCAXDTI2MDQxNDE3NDMyMFoYDzIxMjYwMzIxMTc0MzIw
        WjAbMRkwFwYDVQQDDBBDdWJlTGl0ZSBUZXN0IENBMIIBIjANBgkqhkiG9w0BAQEF
        AAOCAQ8AMIIBCgKCAQEA11mwQJCp09PhtrVNUe0QDftklf7sAfCwDpKx0wsT04gX
        EZkaKIdnl3XIKjpqCu2BY5SWRu7yCtfMyVK46E6Wfe/HA/q/RA2oIz3iz5PImSF4
        4e/TIQaOuTBSOMmg7OraOHT50HM0b6vlzphDqWSHnsCnkjhL3athyyTcwJKGgQnj
        YhO97WWM5DDG2C6NViKDXE4p6Me0PmZHbG/bnI5ZbD1pvcnKos5PY+Q9k0ixV7qG
        Zck+dxy5FDMteBp7zDweSlKbsN1O3AJdEIjgMywGuVUbx4szsho/adBT1v4QMgIV
        DWP+iKfDYArZrexVfJwvDhNrOg1dLw1RPj8SOMx2rQIDAQABMA0GCSqGSIb3DQEB
        CwUAA4IBAQAYpCSSUJYmYYxDtYCRD7j/ukJuogW2ZzwrO+HV/KtKZDTkBzYRy/lU
        aNjoq5RG7sj+jiAim8H+e/QlXu6Wc0QQiRCoL0n7M720kbSUZP9I048wBimLMPbl
        J+/Feubt9NCxVD+HCw+S1OAA9su4tYWj2iVZ+VdSB5xy0uzSNvfdhUa9l9uNU61F
        mYFfxePXwUH6Wm4Jw3QLlbIXDBo9VOgQbMA4U0CyQ0LRrvdaaN6BaPex4Ofx3BCU
        AchgiojvOyMgLQ+ORgQk8BXnq+pZ1enpQYmaS+6nytdr9d491dhL1CsVWtB0bSGV
        gqza/S8l+R8G0r3CFIZk1edLnbpEGjv+
        -----END CERTIFICATE-----
        """

        let derData = try KubeAPIService.pemToDER(Data(pemString.utf8))

        // Verify the DER is a valid certificate (not nil)
        let cert = SecCertificateCreateWithData(nil, derData as CFData)
        XCTAssertNotNil(cert, "pemToDER output must produce a valid SecCertificate")
    }

    // MARK: Invalid PEM

    func testPemToDER_invalidBase64Content_throws() throws {
        let pem = "-----BEGIN CERTIFICATE-----\n!!!not-valid-base64!!!\n-----END CERTIFICATE-----\n"

        XCTAssertThrowsError(try KubeAPIService.pemToDER(Data(pem.utf8))) { error in
            guard let cubeliteError = error as? CubeliteError,
                  case .clientError(let reason) = cubeliteError else {
                XCTFail("Expected CubeliteError.clientError, got \(error)")
                return
            }
            XCTAssertTrue(reason.contains("decode PEM"), "Reason was: \(reason)")
        }
    }

    func testPemToDER_invalidUTF8Data_throws() throws {
        // Non-UTF8 bytes
        let invalidData = Data([0xFF, 0xFE, 0x00, 0x01])

        XCTAssertThrowsError(try KubeAPIService.pemToDER(invalidData)) { error in
            guard let cubeliteError = error as? CubeliteError,
                  case .clientError(let reason) = cubeliteError else {
                XCTFail("Expected CubeliteError.clientError, got \(error)")
                return
            }
            XCTAssertTrue(reason.contains("UTF-8"), "Reason was: \(reason)")
        }
    }
}

// MARK: - loadCACertificate Tests

final class LoadCACertificateTests: XCTestCase {

    // Inline DER base64 for the test self-signed certificate above.
    private let testCertDERBase64 = "MIICtDCCAZwCCQDkh6vhWkfH9zANBgkqhkiG9w0BAQsFADAbMRkwFwYDVQQDDBBDdWJlTGl0ZSBUZXN0IENBMCAXDTI2MDQxNDE3NDMyMFoYDzIxMjYwMzIxMTc0MzIwWjAbMRkwFwYDVQQDDBBDdWJlTGl0ZSBUZXN0IENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA11mwQJCp09PhtrVNUe0QDftklf7sAfCwDpKx0wsT04gXEZkaKIdnl3XIKjpqCu2BY5SWRu7yCtfMyVK46E6Wfe/HA/q/RA2oIz3iz5PImSF44e/TIQaOuTBSOMmg7OraOHT50HM0b6vlzphDqWSHnsCnkjhL3athyyTcwJKGgQnjYhO97WWM5DDG2C6NViKDXE4p6Me0PmZHbG/bnI5ZbD1pvcnKos5PY+Q9k0ixV7qGZck+dxy5FDMteBp7zDweSlKbsN1O3AJdEIjgMywGuVUbx4szsho/adBT1v4QMgIVDWP+iKfDYArZrexVfJwvDhNrOg1dLw1RPj8SOMx2rQIDAQABMA0GCSqGSIb3DQEBCwUAA4IBAQAYpCSSUJYmYYxDtYCRD7j/ukJuogW2ZzwrO+HV/KtKZDTkBzYRy/lUaNjoq5RG7sj+jiAim8H+e/QlXu6Wc0QQiRCoL0n7M720kbSUZP9I048wBimLMPblJ+/Feubt9NCxVD+HCw+S1OAA9su4tYWj2iVZ+VdSB5xy0uzSNvfdhUa9l9uNU61FmYFfxePXwUH6Wm4Jw3QLlbIXDBo9VOgQbMA4U0CyQ0LRrvdaaN6BaPex4Ofx3BCUAchgiojvOyMgLQ+ORgQk8BXnq+pZ1enpQYmaS+6nytdr9d491dhL1CsVWtB0bSGVgqza/S8l+R8G0r3CFIZk1edLnbpEGjv+"

    // MARK: Nil / Empty → nil

    func testLoadCACertificate_nilBothFields_returnsNil() throws {
        let details = ClusterDetails(
            server: "https://example.com",
            certificateAuthorityData: nil,
            certificateAuthority: nil,
            insecureSkipTlsVerify: nil
        )
        let result = try KubeAPIService.loadCACertificate(from: details)
        XCTAssertNil(result)
    }

    func testLoadCACertificate_emptyBothFields_returnsNil() throws {
        let details = ClusterDetails(
            server: "https://example.com",
            certificateAuthorityData: "",
            certificateAuthority: "",
            insecureSkipTlsVerify: nil
        )
        let result = try KubeAPIService.loadCACertificate(from: details)
        XCTAssertNil(result)
    }

    // MARK: Inline base64

    func testLoadCACertificate_validInlineBase64_returnsNonNilCertificate() throws {
        let details = ClusterDetails(
            server: "https://example.com",
            certificateAuthorityData: testCertDERBase64,
            certificateAuthority: nil,
            insecureSkipTlsVerify: nil
        )
        let cert = try KubeAPIService.loadCACertificate(from: details)
        XCTAssertNotNil(cert)
    }

    func testLoadCACertificate_invalidBase64InlineData_throws() throws {
        let details = ClusterDetails(
            server: "https://example.com",
            certificateAuthorityData: "!!!invalid-base64!!!",
            certificateAuthority: nil,
            insecureSkipTlsVerify: nil
        )
        XCTAssertThrowsError(try KubeAPIService.loadCACertificate(from: details)) { error in
            guard let cubeliteError = error as? CubeliteError,
                  case .clientError = cubeliteError else {
                XCTFail("Expected CubeliteError.clientError, got \(error)")
                return
            }
        }
    }

    func testLoadCACertificate_base64PrefersOverFilePath() throws {
        // When certificateAuthorityData is non-empty, it must take priority
        // over certificateAuthority (even if the path is non-existent).
        let details = ClusterDetails(
            server: "https://example.com",
            certificateAuthorityData: testCertDERBase64,
            certificateAuthority: "/nonexistent/ca.crt",
            insecureSkipTlsVerify: nil
        )
        let cert = try KubeAPIService.loadCACertificate(from: details)
        XCTAssertNotNil(cert, "Inline certificateAuthorityData must be used; file path must be ignored")
    }

    // MARK: File path

    func testLoadCACertificate_validPEMFilePath_returnsNonNilCertificate() throws {
        let pemContent = """
        -----BEGIN CERTIFICATE-----
        MIICtDCCAZwCCQDkh6vhWkfH9zANBgkqhkiG9w0BAQsFADAbMRkwFwYDVQQDDBBD
        dWJlTGl0ZSBUZXN0IENBMCAXDTI2MDQxNDE3NDMyMFoYDzIxMjYwMzIxMTc0MzIw
        WjAbMRkwFwYDVQQDDBBDdWJlTGl0ZSBUZXN0IENBMIIBIjANBgkqhkiG9w0BAQEF
        AAOCAQ8AMIIBCgKCAQEA11mwQJCp09PhtrVNUe0QDftklf7sAfCwDpKx0wsT04gX
        EZkaKIdnl3XIKjpqCu2BY5SWRu7yCtfMyVK46E6Wfe/HA/q/RA2oIz3iz5PImSF4
        4e/TIQaOuTBSOMmg7OraOHT50HM0b6vlzphDqWSHnsCnkjhL3athyyTcwJKGgQnj
        YhO97WWM5DDG2C6NViKDXE4p6Me0PmZHbG/bnI5ZbD1pvcnKos5PY+Q9k0ixV7qG
        Zck+dxy5FDMteBp7zDweSlKbsN1O3AJdEIjgMywGuVUbx4szsho/adBT1v4QMgIV
        DWP+iKfDYArZrexVfJwvDhNrOg1dLw1RPj8SOMx2rQIDAQABMA0GCSqGSIb3DQEB
        CwUAA4IBAQAYpCSSUJYmYYxDtYCRD7j/ukJuogW2ZzwrO+HV/KtKZDTkBzYRy/lU
        aNjoq5RG7sj+jiAim8H+e/QlXu6Wc0QQiRCoL0n7M720kbSUZP9I048wBimLMPbl
        J+/Feubt9NCxVD+HCw+S1OAA9su4tYWj2iVZ+VdSB5xy0uzSNvfdhUa9l9uNU61F
        mYFfxePXwUH6Wm4Jw3QLlbIXDBo9VOgQbMA4U0CyQ0LRrvdaaN6BaPex4Ofx3BCU
        AchgiojvOyMgLQ+ORgQk8BXnq+pZ1enpQYmaS+6nytdr9d491dhL1CsVWtB0bSGV
        gqza/S8l+R8G0r3CFIZk1edLnbpEGjv+
        -----END CERTIFICATE-----
        """
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-test-ca-\(UUID().uuidString).crt")
        try pemContent.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let details = ClusterDetails(
            server: "https://example.com",
            certificateAuthorityData: nil,
            certificateAuthority: url.path,
            insecureSkipTlsVerify: nil
        )
        let cert = try KubeAPIService.loadCACertificate(from: details)
        XCTAssertNotNil(cert)
    }

    func testLoadCACertificate_nonExistentFilePath_throws() throws {
        let details = ClusterDetails(
            server: "https://example.com",
            certificateAuthorityData: nil,
            certificateAuthority: "/nonexistent/path/ca.crt",
            insecureSkipTlsVerify: nil
        )
        XCTAssertThrowsError(try KubeAPIService.loadCACertificate(from: details)) { error in
            guard let cubeliteError = error as? CubeliteError,
                  case .clientError(let reason) = cubeliteError else {
                XCTFail("Expected CubeliteError.clientError, got \(error)")
                return
            }
            XCTAssertTrue(reason.contains("Cannot read CA certificate file"), "Reason was: \(reason)")
        }
    }
}

// MARK: - CubeliteError.tlsError Tests

final class TLSErrorDescriptionTests: XCTestCase {

    func testTlsError_hasCorrectDescription() {
        let error = CubeliteError.tlsError(reason: "self-signed cert not trusted")
        XCTAssertEqual(
            error.errorDescription,
            "TLS certificate error: self-signed cert not trusted"
        )
    }

    func testTlsError_differentFromClientError() {
        let tls = CubeliteError.tlsError(reason: "expired")
        let client = CubeliteError.clientError(reason: "expired")
        XCTAssertNotEqual(tls.errorDescription, client.errorDescription)
    }
}

// MARK: - isTLSError Tests

final class IsTLSErrorTests: XCTestCase {

    func testIsTLSError_serverCertificateUntrusted_returnsTrue() {
        let error = URLError(.serverCertificateUntrusted)
        XCTAssertTrue(KubeAPIService.isTLSError(error))
    }

    func testIsTLSError_serverCertificateHasBadDate_returnsTrue() {
        let error = URLError(.serverCertificateHasBadDate)
        XCTAssertTrue(KubeAPIService.isTLSError(error))
    }

    func testIsTLSError_serverCertificateHasUnknownRoot_returnsTrue() {
        let error = URLError(.serverCertificateHasUnknownRoot)
        XCTAssertTrue(KubeAPIService.isTLSError(error))
    }

    func testIsTLSError_serverCertificateNotYetValid_returnsTrue() {
        let error = URLError(.serverCertificateNotYetValid)
        XCTAssertTrue(KubeAPIService.isTLSError(error))
    }

    func testIsTLSError_clientCertificateRejected_returnsTrue() {
        let error = URLError(.clientCertificateRejected)
        XCTAssertTrue(KubeAPIService.isTLSError(error))
    }

    func testIsTLSError_cannotConnectToHost_returnsFalse() {
        let error = URLError(.cannotConnectToHost)
        XCTAssertFalse(KubeAPIService.isTLSError(error))
    }

    func testIsTLSError_timedOut_returnsFalse() {
        let error = URLError(.timedOut)
        XCTAssertFalse(KubeAPIService.isTLSError(error))
    }

    func testIsTLSError_networkConnectionLost_returnsFalse() {
        let error = URLError(.networkConnectionLost)
        XCTAssertFalse(KubeAPIService.isTLSError(error))
    }
}

// MARK: - isConnectionError Tests

final class IsConnectionErrorTests: XCTestCase {

    func testIsConnectionError_cannotConnectToHost_returnsTrue() {
        XCTAssertTrue(KubeAPIService.isConnectionError(URLError(.cannotConnectToHost)))
    }

    func testIsConnectionError_timedOut_returnsTrue() {
        XCTAssertTrue(KubeAPIService.isConnectionError(URLError(.timedOut)))
    }

    func testIsConnectionError_cannotFindHost_returnsTrue() {
        XCTAssertTrue(KubeAPIService.isConnectionError(URLError(.cannotFindHost)))
    }

    // Bug 4 regression: SSL codes must NOT be classified as connection errors
    // (they are classified as tlsError instead via isTLSError).

    func testIsConnectionError_serverCertificateUntrusted_returnsFalse() {
        XCTAssertFalse(KubeAPIService.isConnectionError(URLError(.serverCertificateUntrusted)))
    }

    func testIsConnectionError_serverCertificateHasUnknownRoot_returnsFalse() {
        XCTAssertFalse(KubeAPIService.isConnectionError(URLError(.serverCertificateHasUnknownRoot)))
    }

    func testIsConnectionError_serverCertificateHasBadDate_returnsFalse() {
        XCTAssertFalse(KubeAPIService.isConnectionError(URLError(.serverCertificateHasBadDate)))
    }

    func testIsConnectionError_clientCertificateRejected_returnsFalse() {
        XCTAssertFalse(KubeAPIService.isConnectionError(URLError(.clientCertificateRejected)))
    }
}

import XCTest

@testable import cubelite

// MARK: - KubeconfigCredentialMigrationTests

/// Tests for the load-time bearer-token migration: tokens found in kubeconfig
/// files are imported into the Keychain (keyed by cluster server URL) and
/// stripped from the in-memory model, while `save(_:)` leaves the on-disk
/// credentials untouched.
final class KubeconfigCredentialMigrationTests: XCTestCase {

    private let sut = KubeconfigService()
    private let keychain = KeychainService()
    private var cleanupAccounts: [String] = []
    private var tempFiles: [URL] = []

    override func tearDown() async throws {
        for account in cleanupAccounts {
            try? await keychain.delete(tag: .bearerToken, account: account)
        }
        for url in tempFiles {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Import

    func testLoad_importsTokenIntoKeychain_keyedByServer() async throws {
        let server = uniqueServer()
        let url = try temporaryFile(contents: yaml(server: server, token: "file-token"))

        _ = try await sut.loadFromPaths([url])

        let stored = try await keychain.retrieveString(tag: .bearerToken, account: server)
        XCTAssertEqual(stored, "file-token")
    }

    func testLoad_serverWithTrailingSlash_importsUnderTrimmedAccount() async throws {
        let base = uniqueServer()
        let url = try temporaryFile(contents: yaml(server: base + "/", token: "slash-token"))

        _ = try await sut.loadFromPaths([url])

        let stored = try await keychain.retrieveString(tag: .bearerToken, account: base)
        XCTAssertEqual(stored, "slash-token")
    }

    func testLoad_existingKeychainEntry_winsOverFileToken() async throws {
        let server = uniqueServer()
        try await keychain.storeString("keychain-token", tag: .bearerToken, account: server)
        let url = try temporaryFile(contents: yaml(server: server, token: "file-token"))

        _ = try await sut.loadFromPaths([url])

        let stored = try await keychain.retrieveString(tag: .bearerToken, account: server)
        XCTAssertEqual(stored, "keychain-token")
    }

    func testLoad_userWithoutToken_createsNoKeychainEntry() async throws {
        let server = uniqueServer()
        let url = try temporaryFile(contents: yaml(server: server, token: nil))

        _ = try await sut.loadFromPaths([url])

        let stored = try await keychain.retrieveString(tag: .bearerToken, account: server)
        XCTAssertNil(stored)
    }

    // MARK: - Redaction

    func testLoad_redactsTokenFromInMemoryModel() async throws {
        let server = uniqueServer()
        let url = try temporaryFile(contents: yaml(server: server, token: "file-token"))

        let config = try await sut.loadFromPaths([url])

        for named in config.raw.users ?? [] {
            XCTAssertNil(named.user?.token, "Token must not survive load for user \(named.name)")
        }
    }

    func testLoad_redaction_keepsClientCertificateFields() async throws {
        let server = uniqueServer()
        let url = try temporaryFile(
            contents: """
                apiVersion: v1
                kind: Config
                current-context: ctx
                contexts:
                - name: ctx
                  context:
                    cluster: cl
                    user: u
                clusters:
                - name: cl
                  cluster:
                    server: \(server)
                users:
                - name: u
                  user:
                    token: file-token
                    client-certificate-data: Y2VydA==
                    client-key-data: a2V5
                """)

        let config = try await sut.loadFromPaths([url])

        let user = config.raw.users?.first?.user
        XCTAssertNil(user?.token)
        XCTAssertEqual(user?.clientCertificateData, "Y2VydA==")
        XCTAssertEqual(user?.clientKeyData, "a2V5")
    }

    // MARK: - Save preserves file credentials

    func testSave_afterRedactedLoad_keepsTokenOnDisk() async throws {
        let server = uniqueServer()
        let url = try temporaryFile(contents: yaml(server: server, token: "file-token"))

        let config = try await sut.loadFromPaths([url])
        try await sut.save(config)

        let saved = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(
            saved.contains("file-token"),
            "save must not strip credentials from the on-disk kubeconfig")
    }

    func testSave_afterSetActiveContext_updatesContextAndKeepsToken() async throws {
        let server = uniqueServer()
        let contents = """
            apiVersion: v1
            kind: Config
            current-context: ctx-a
            contexts:
            - name: ctx-a
              context:
                cluster: cl
                user: u
            - name: ctx-b
              context:
                cluster: cl
                user: u
            clusters:
            - name: cl
              cluster:
                server: \(server)
            users:
            - name: u
              user:
                token: file-token
            """
        let url = try temporaryFile(contents: contents)

        var config = try await sut.loadFromPaths([url])
        try await sut.setActiveContext("ctx-b", in: &config)
        try await sut.save(config)

        let saved = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(saved.contains("current-context: ctx-b"))
        XCTAssertTrue(saved.contains("file-token"))
    }

    func testSave_multipleSourcePaths_doesNotMergeOtherFilesIntoFirst() async throws {
        let serverA = uniqueServer()
        let serverB = uniqueServer()
        let urlA = try temporaryFile(contents: yaml(server: serverA, token: "token-a", name: "a"))
        let urlB = try temporaryFile(contents: yaml(server: serverB, token: "token-b", name: "b"))

        let config = try await sut.loadFromPaths([urlA, urlB])
        try await sut.save(config)

        let savedFirst = try String(contentsOf: urlA, encoding: .utf8)
        XCTAssertFalse(
            savedFirst.contains("ctx-b"),
            "save must only rewrite current-context, not merge other files into the first")
        XCTAssertTrue(savedFirst.contains("token-a"))
    }

    // MARK: - Helpers

    /// Unique fake server per test so Keychain entries never collide across runs.
    private func uniqueServer() -> String {
        let server = "https://migrate-\(UUID().uuidString).example"
        cleanupAccounts.append(server)
        return server
    }

    private func temporaryFile(contents: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-migration-test-\(UUID().uuidString).yaml")
        try contents.write(to: url, atomically: true, encoding: .utf8)
        tempFiles.append(url)
        return url
    }

    private func yaml(server: String, token: String?, name: String = "a") -> String {
        let tokenLine = token.map { "\n        token: \($0)" } ?? ""
        return """
            apiVersion: v1
            kind: Config
            current-context: ctx-\(name)
            contexts:
            - name: ctx-\(name)
              context:
                cluster: cluster-\(name)
                user: user-\(name)
            clusters:
            - name: cluster-\(name)
              cluster:
                server: \(server)
            users:
            - name: user-\(name)
              user:\(tokenLine.isEmpty ? " {}" : tokenLine)
            """
    }
}

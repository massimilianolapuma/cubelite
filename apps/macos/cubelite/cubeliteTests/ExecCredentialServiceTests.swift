import XCTest

@testable import cubelite

// MARK: - ExecCredentialServiceTests

/// Tests for the exec credential plugin runner using mock shell scripts as
/// plugins — no real cloud CLIs involved.
final class ExecCredentialServiceTests: XCTestCase {

    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-exec-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    /// Writes an executable mock plugin script and returns its path.
    private func mockPlugin(_ body: String) throws -> String {
        let url = scratch.appendingPathComponent("plugin-\(UUID().uuidString).sh")
        try "#!/bin/sh\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url.path
    }

    private func execConfig(command: String, env: [ExecEnvVar]? = nil) -> ExecConfig {
        ExecConfig(
            apiVersion: "client.authentication.k8s.io/v1",
            command: command, args: nil, env: env,
            interactiveMode: "Never", provideClusterInfo: nil)
    }

    // MARK: - Happy path

    func testCredentials_tokenPlugin_returnsToken() async throws {
        let plugin = try mockPlugin(
            """
            echo '{"kind":"ExecCredential","apiVersion":"client.authentication.k8s.io/v1","status":{"token":"exec-token-1"}}'
            """)
        let sut = ExecCredentialService()

        let result = try await sut.credentials(
            for: execConfig(command: plugin), cacheKey: "https://exec-a.example")

        XCTAssertEqual(result.token, "exec-token-1")
        XCTAssertNil(result.clientCertificatePEM)
    }

    func testCredentials_pluginEnvVars_arePassedThrough() async throws {
        let plugin = try mockPlugin(
            """
            echo "{\\"status\\":{\\"token\\":\\"$CUBELITE_TEST_VALUE\\"}}"
            """)
        let sut = ExecCredentialService()

        let result = try await sut.credentials(
            for: execConfig(
                command: plugin,
                env: [ExecEnvVar(name: "CUBELITE_TEST_VALUE", value: "from-env")]),
            cacheKey: "https://exec-env.example")

        XCTAssertEqual(result.token, "from-env")
    }

    // MARK: - Caching

    func testCredentials_secondCall_servedFromCache() async throws {
        let counter = scratch.appendingPathComponent("count")
        let plugin = try mockPlugin(
            """
            echo x >> "\(counter.path)"
            echo '{"status":{"token":"cached-token"}}'
            """)
        let sut = ExecCredentialService()
        let key = "https://exec-cache.example"

        _ = try await sut.credentials(for: execConfig(command: plugin), cacheKey: key)
        _ = try await sut.credentials(for: execConfig(command: plugin), cacheKey: key)

        let runs = (try? String(contentsOf: counter, encoding: .utf8))?
            .split(separator: "\n").count ?? 0
        XCTAssertEqual(runs, 1, "Second call must not re-run the plugin")
    }

    func testCredentials_expiredResult_rerunsPlugin() async throws {
        let counter = scratch.appendingPathComponent("count")
        let plugin = try mockPlugin(
            """
            echo x >> "\(counter.path)"
            echo '{"status":{"token":"short-lived","expirationTimestamp":"2020-01-01T00:00:00Z"}}'
            """)
        let sut = ExecCredentialService()
        let key = "https://exec-expired.example"

        _ = try await sut.credentials(for: execConfig(command: plugin), cacheKey: key)
        _ = try await sut.credentials(for: execConfig(command: plugin), cacheKey: key)

        let runs = (try? String(contentsOf: counter, encoding: .utf8))?
            .split(separator: "\n").count ?? 0
        XCTAssertEqual(runs, 2, "Expired credential must trigger a fresh plugin run")
    }

    func testInvalidateCache_forcesRerun() async throws {
        let counter = scratch.appendingPathComponent("count")
        let plugin = try mockPlugin(
            """
            echo x >> "\(counter.path)"
            echo '{"status":{"token":"t"}}'
            """)
        let sut = ExecCredentialService()
        let key = "https://exec-reset.example"

        _ = try await sut.credentials(for: execConfig(command: plugin), cacheKey: key)
        await sut.invalidateCache()
        _ = try await sut.credentials(for: execConfig(command: plugin), cacheKey: key)

        let runs = (try? String(contentsOf: counter, encoding: .utf8))?
            .split(separator: "\n").count ?? 0
        XCTAssertEqual(runs, 2)
    }

    // MARK: - Failures

    func testCredentials_missingBinary_throwsNotFound() async {
        let sut = ExecCredentialService()
        do {
            _ = try await sut.credentials(
                for: execConfig(command: "cubelite-definitely-absent-plugin"),
                cacheKey: "https://exec-missing.example")
            XCTFail("Expected clientError for missing plugin binary")
        } catch let error as CubeliteError {
            guard case .clientError(let reason) = error else {
                return XCTFail("Expected clientError, got \(error)")
            }
            XCTAssertTrue(reason.contains("not found"), reason)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testCredentials_nonzeroExit_surfacesStderr() async throws {
        let plugin = try mockPlugin(
            """
            echo "boom: credentials expired" >&2
            exit 3
            """)
        let sut = ExecCredentialService()
        do {
            _ = try await sut.credentials(
                for: execConfig(command: plugin), cacheKey: "https://exec-fail.example")
            XCTFail("Expected clientError for failing plugin")
        } catch let error as CubeliteError {
            guard case .clientError(let reason) = error else {
                return XCTFail("Expected clientError, got \(error)")
            }
            XCTAssertTrue(reason.contains("status 3"), reason)
            XCTAssertTrue(reason.contains("boom"), reason)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testCredentials_interactiveAlways_throws() async {
        let sut = ExecCredentialService()
        let config = ExecConfig(
            apiVersion: nil, command: "/bin/echo", args: nil, env: nil,
            interactiveMode: "Always", provideClusterInfo: nil)
        do {
            _ = try await sut.credentials(for: config, cacheKey: "https://exec-tty.example")
            XCTFail("Expected clientError for interactive plugin")
        } catch let error as CubeliteError {
            guard case .clientError(let reason) = error else {
                return XCTFail("Expected clientError, got \(error)")
            }
            XCTAssertTrue(reason.contains("interactive"), reason)
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    // MARK: - Parsing

    func testParse_invalidJSON_throws() {
        XCTAssertThrowsError(
            try ExecCredentialService.parseExecCredential(
                Data("not-json".utf8), command: "x"))
    }

    func testParse_missingStatus_throws() {
        XCTAssertThrowsError(
            try ExecCredentialService.parseExecCredential(
                Data(#"{"kind":"ExecCredential"}"#.utf8), command: "x"))
    }

    func testParse_certificatePair_andFractionalExpiry() throws {
        let json = """
            {"status":{"clientCertificateData":"-----BEGIN CERTIFICATE-----\\nAAA\\n-----END CERTIFICATE-----",
                       "clientKeyData":"-----BEGIN EC PRIVATE KEY-----\\nBBB\\n-----END EC PRIVATE KEY-----",
                       "expirationTimestamp":"2030-06-01T12:00:00.500Z"}}
            """
        let result = try ExecCredentialService.parseExecCredential(Data(json.utf8), command: "x")
        XCTAssertNil(result.token)
        XCTAssertTrue(result.clientCertificatePEM?.contains("BEGIN CERTIFICATE") ?? false)
        XCTAssertTrue(result.clientKeyPEM?.contains("EC PRIVATE KEY") ?? false)
        XCTAssertNotNil(result.expirationTimestamp)
    }

    // MARK: - Executable resolution

    func testResolveExecutable_absolutePath() {
        XCTAssertNotNil(ExecCredentialService.resolveExecutable("/bin/sh"))
        XCTAssertNil(ExecCredentialService.resolveExecutable("/bin/absent-binary-xyz"))
    }

    func testResolveExecutable_bareName_foundOnPath() {
        XCTAssertNotNil(ExecCredentialService.resolveExecutable("sh"))
    }
}

// MARK: - KubeconfigExecParsingTests

/// Exec / auth-provider blocks must survive the kubeconfig parse and the
/// save round-trip (save re-encodes the on-disk model).
final class KubeconfigExecParsingTests: XCTestCase {

    func testLoad_execUser_parsesExecConfig() async throws {
        let yaml = """
            apiVersion: v1
            kind: Config
            current-context: eks
            contexts:
            - name: eks
              context: {cluster: c, user: u}
            clusters:
            - name: c
              cluster: {server: "https://exec-parse.example"}
            users:
            - name: u
              user:
                exec:
                  apiVersion: client.authentication.k8s.io/v1beta1
                  command: aws
                  args: ["eks", "get-token", "--cluster-name", "prod"]
                  env:
                  - name: AWS_PROFILE
                    value: staging
                  interactiveMode: IfAvailable
            """
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-exec-parse-\(UUID().uuidString).yaml")
        try yaml.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try await KubeconfigService().loadFromPaths([url])

        let exec = config.raw.users?.first?.user?.exec
        XCTAssertEqual(exec?.command, "aws")
        XCTAssertEqual(exec?.args, ["eks", "get-token", "--cluster-name", "prod"])
        XCTAssertEqual(exec?.env?.first?.name, "AWS_PROFILE")
        XCTAssertEqual(exec?.interactiveMode, "IfAvailable")
    }

    func testSave_execUser_preservesExecBlockOnDisk() async throws {
        let yaml = """
            apiVersion: v1
            kind: Config
            current-context: gke
            contexts:
            - name: gke
              context: {cluster: c, user: u}
            clusters:
            - name: c
              cluster: {server: "https://exec-save.example"}
            users:
            - name: u
              user:
                exec:
                  command: gke-gcloud-auth-plugin
            """
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-exec-save-\(UUID().uuidString).yaml")
        try yaml.write(to: url, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: url) }

        let service = KubeconfigService()
        let config = try await service.loadFromPaths([url])
        try await service.save(config)

        let saved = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(saved.contains("gke-gcloud-auth-plugin"),
            "save must not drop the exec block from the kubeconfig")
    }
}

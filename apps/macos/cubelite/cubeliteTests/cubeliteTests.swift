import XCTest
@testable import cubelite

// MARK: - KubeconfigService Tests

final class KubeconfigServiceTests: XCTestCase {

    private let sut = KubeconfigService()

    // MARK: loadFromPaths

    func testLoadFromPaths_validKubeconfig_returnsExpectedConfig() async throws {
        let yaml = minimalYAML(context: "test-ctx", cluster: "test-cluster", server: "https://127.0.0.1:6443") // NOSONAR — test fixture
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try await sut.loadFromPaths([url])

        XCTAssertEqual(config.currentContext, "test-ctx")
        XCTAssertEqual(config.contexts, ["test-ctx"])
        XCTAssertEqual(config.raw.clusters?.first?.cluster?.server, "https://127.0.0.1:6443") // NOSONAR
        XCTAssertEqual(config.paths.count, 1)
    }

    func testLoadFromPaths_emptyArray_throwsFileNotFound() async throws {
        do {
            _ = try await sut.loadFromPaths([])
            XCTFail("Expected fileNotFound error")
        } catch let error as CubeliteError {
            guard case .fileNotFound = error else {
                XCTFail("Unexpected CubeliteError: \(error)")
                return
            }
        }
    }

    func testLoadFromPaths_nonExistentFile_throwsFileNotFound() async throws {
        let url = URL(fileURLWithPath: "/tmp/cubelite-test-nonexistent-\(UUID().uuidString).yaml")
        do {
            _ = try await sut.loadFromPaths([url])
            XCTFail("Expected fileNotFound error")
        } catch let error as CubeliteError {
            guard case .fileNotFound = error else {
                XCTFail("Unexpected CubeliteError: \(error)")
                return
            }
        }
    }

    func testLoadFromPaths_multipleFiles_mergesContextsAndFirstCurrentContextWins() async throws {
        let yaml1 = minimalYAML(context: "ctx-a", cluster: "cluster-a", server: "https://k8s-test-a.example")
        let yaml2 = minimalYAML(context: "ctx-b", cluster: "cluster-b", server: "https://k8s-test-b.example")

        let url1 = try temporaryFile(contents: yaml1)
        let url2 = try temporaryFile(contents: yaml2)
        defer {
            try? FileManager.default.removeItem(at: url1)
            try? FileManager.default.removeItem(at: url2)
        }

        let config = try await sut.loadFromPaths([url1, url2])

        XCTAssertEqual(config.currentContext, "ctx-a", "First file's current-context must win")
        XCTAssertTrue(config.contexts.contains("ctx-a"))
        XCTAssertTrue(config.contexts.contains("ctx-b"))
        XCTAssertEqual(config.contexts.count, 2)
    }

    func testLoadFromPaths_duplicateContextNames_deduplicates() async throws {
        let yaml = minimalYAML(context: "shared-ctx", cluster: "cluster-a", server: "https://k8s-test-a.example")
        let url1 = try temporaryFile(contents: yaml)
        let url2 = try temporaryFile(contents: yaml)
        defer {
            try? FileManager.default.removeItem(at: url1)
            try? FileManager.default.removeItem(at: url2)
        }

        let config = try await sut.loadFromPaths([url1, url2])

        XCTAssertEqual(
            config.contexts.filter { $0 == "shared-ctx" }.count, 1,
            "Duplicate context names should be deduplicated"
        )
    }

    // MARK: setActiveContext

    func testSetActiveContext_validName_updatesCurrentContext() async throws {
        let yaml = twoContextYAML()
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        var config = try await sut.loadFromPaths([url])
        XCTAssertEqual(config.currentContext, "ctx-a")

        try await sut.setActiveContext("ctx-b", in: &config)

        XCTAssertEqual(config.currentContext, "ctx-b")
        XCTAssertEqual(config.raw.currentContext, "ctx-b")
    }

    func testSetActiveContext_unknownName_throwsContextNotFound() async throws {
        let yaml = minimalYAML(context: "ctx-a", cluster: "cluster-a", server: "https://k8s-test-a.example")
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        var config = try await sut.loadFromPaths([url])

        do {
            try await sut.setActiveContext("does-not-exist", in: &config)
            XCTFail("Expected contextNotFound error")
        } catch let error as CubeliteError {
            if case .contextNotFound(let name) = error {
                XCTAssertEqual(name, "does-not-exist")
            } else {
                XCTFail("Unexpected CubeliteError: \(error)")
            }
        }
    }

    // MARK: - Path Resolution

    func testResolveKubeconfigPaths_fallsBackToDefaultPath() {
        // Temporarily clear KUBECONFIG env (not settable in tests, so just verify the logic)
        let paths = KubeconfigService.resolveKubeconfigPaths()
        XCTAssertFalse(paths.isEmpty, "Must return at least one path")
        // In the absence of KUBECONFIG env var, should return ~/.kube/config
        if ProcessInfo.processInfo.environment["KUBECONFIG"] == nil {
            XCTAssertTrue(
                paths.first?.path.hasSuffix(".kube/config") == true,
                "Default path should be ~/.kube/config"
            )
        }
    }

    // MARK: - Helpers

    private func temporaryFile(contents: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-test-\(UUID().uuidString).yaml")
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func minimalYAML(context: String, cluster: String, server: String) -> String {
        """
        apiVersion: v1
        kind: Config
        current-context: \(context)
        contexts:
        - name: \(context)
          context:
            cluster: \(cluster)
            user: user-\(context)
            namespace: default
        clusters:
        - name: \(cluster)
          cluster:
            server: \(server)
        users:
        - name: user-\(context)
          user:
            token: token-for-\(context)
        """
    }

    private func twoContextYAML() -> String {
        """
        apiVersion: v1
        kind: Config
        current-context: ctx-a
        contexts:
        - name: ctx-a
          context:
            cluster: cluster-a
            user: user-a
        - name: ctx-b
          context:
            cluster: cluster-b
            user: user-b
        clusters:
        - name: cluster-a
          cluster:
            server: https://k8s-test-a.example
        - name: cluster-b
          cluster:
            server: https://k8s-test-b.example
        users:
        - name: user-a
          user:
            token: token-a
        - name: user-b
          user:
            token: token-b
        """
    }
}

// MARK: - KeychainService Tests

final class KeychainServiceTests: XCTestCase {

    private let sut = KeychainService()
    // Unique account per test run to avoid Keychain collisions.
    private lazy var testAccount = "cubelite-test-\(UUID().uuidString)"

    override func tearDown() async throws {
        for tag: KeychainService.CredentialTag in [.bearerToken, .clientCertificate, .clientKey] {
            try? await sut.delete(tag: tag, account: testAccount)
        }
    }

    func testStoreAndRetrieve_bearerToken_roundTrips() async throws {
        let token = "test-bearer-value-not-a-real-credential"

        try await sut.storeString(token, tag: .bearerToken, account: testAccount)
        let retrieved = try await sut.retrieveString(tag: .bearerToken, account: testAccount)

        XCTAssertEqual(retrieved, token)
    }

    func testRetrieve_nonExistent_returnsNil() async throws {
        let result = try await sut.retrieve(
            tag: .bearerToken,
            account: "cubelite-definitely-not-here-\(UUID())"
        )
        XCTAssertNil(result)
    }

    func testStore_updateExisting_returnsUpdatedValue() async throws {
        let initial = "initial-token"
        let updated = "updated-token"

        try await sut.storeString(initial, tag: .bearerToken, account: testAccount)
        try await sut.storeString(updated, tag: .bearerToken, account: testAccount)

        let retrieved = try await sut.retrieveString(tag: .bearerToken, account: testAccount)
        XCTAssertEqual(retrieved, updated)
    }

    func testDelete_existing_removesItem() async throws {
        try await sut.storeString("to-delete", tag: .bearerToken, account: testAccount)
        try await sut.delete(tag: .bearerToken, account: testAccount)

        let result = try await sut.retrieve(tag: .bearerToken, account: testAccount)
        XCTAssertNil(result)
    }

    func testDelete_nonExistent_doesNotThrow() async throws {
        // Must not throw — silent success on missing items.
        try await sut.delete(tag: .bearerToken, account: "cubelite-absent-\(UUID())")
    }

    func testStoreAndRetrieve_rawBinaryData_roundTrips() async throws {
        let data = Data([0x00, 0x01, 0xAB, 0xCD, 0xFF])

        try await sut.store(data, tag: .clientCertificate, account: testAccount)
        let retrieved = try await sut.retrieve(tag: .clientCertificate, account: testAccount)

        XCTAssertEqual(retrieved, data)
    }

    func testMultipleTags_sameAccount_storeIndependently() async throws {
        let tokenValue = "my-bearer-token"
        let certData = Data([0xDE, 0xAD, 0xBE, 0xEF])

        try await sut.storeString(tokenValue, tag: .bearerToken, account: testAccount)
        try await sut.store(certData, tag: .clientCertificate, account: testAccount)

        let retrievedToken = try await sut.retrieveString(tag: .bearerToken, account: testAccount)
        let retrievedCert = try await sut.retrieve(tag: .clientCertificate, account: testAccount)

        XCTAssertEqual(retrievedToken, tokenValue)
        XCTAssertEqual(retrievedCert, certData)
    }
}

// MARK: - Resource Model Tests

final class ResourceModelTests: XCTestCase {

    func testK8sPod_toPodInfo_allContainersReady() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "nginx-abc", namespace: "production", creationTimestamp: nil),
            status: K8sPodStatus(
                phase: "Running",
                containerStatuses: [
                    K8sContainerStatus(ready: true, restartCount: 2),
                    K8sContainerStatus(ready: true, restartCount: 0)
                ]
            )
        )

        let info = pod.toPodInfo()

        XCTAssertEqual(info.name, "nginx-abc")
        XCTAssertEqual(info.namespace, "production")
        XCTAssertEqual(info.phase, "Running")
        XCTAssertTrue(info.ready)
        XCTAssertEqual(info.restarts, 2)
    }

    func testK8sPod_toPodInfo_oneContainerNotReady_isNotReady() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "app", namespace: "default", creationTimestamp: nil),
            status: K8sPodStatus(
                phase: "Running",
                containerStatuses: [
                    K8sContainerStatus(ready: true, restartCount: 0),
                    K8sContainerStatus(ready: false, restartCount: 3)
                ]
            )
        )

        let info = pod.toPodInfo()

        XCTAssertFalse(info.ready)
        XCTAssertEqual(info.restarts, 3)
    }

    func testK8sPod_toPodInfo_noContainers_isNotReady() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "pending", namespace: "kube-system", creationTimestamp: nil),
            status: K8sPodStatus(phase: "Pending", containerStatuses: [])
        )

        let info = pod.toPodInfo()

        XCTAssertFalse(info.ready)
        XCTAssertEqual(info.restarts, 0)
    }

    func testK8sPod_toPodInfo_nilMetadata_usesEmptyStrings() {
        let pod = K8sPod(metadata: nil, status: nil)
        let info = pod.toPodInfo()

        XCTAssertEqual(info.name, "")
        XCTAssertEqual(info.namespace, "")
    }

    func testK8sNamespace_toNamespaceInfo_mapsCorrectly() {
        let ns = K8sNamespace(
            metadata: K8sObjectMeta(name: "kube-system", namespace: nil, creationTimestamp: nil),
            status: K8sNamespaceStatus(phase: "Active")
        )

        let info = ns.toNamespaceInfo()

        XCTAssertEqual(info.name, "kube-system")
        XCTAssertEqual(info.phase, "Active")
        XCTAssertEqual(info.id, "kube-system")
    }

    func testPodInfo_id_combinesNamespaceAndName() {
        let pod = PodInfo(name: "my-app", namespace: "staging", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil)
        XCTAssertEqual(pod.id, "staging/my-app")
    }

    func testDeploymentInfo_id_combinesNamespaceAndName() {
        let d = DeploymentInfo(name: "frontend", namespace: "prod", replicas: 3, readyReplicas: 3)
        XCTAssertEqual(d.id, "prod/frontend")
    }

    func testNamespaceInfo_id_isName() {
        let ns = NamespaceInfo(name: "default", phase: "Active")
        XCTAssertEqual(ns.id, "default")
    }
}

// MARK: - CubeliteError Tests

final class CubeliteErrorTests: XCTestCase {

    func testAllCases_haveNonNilErrorDescription() {
        let cases: [CubeliteError] = [
            .fileNotFound(path: "/test/path"),
            .parseError(reason: "bad YAML"),
            .contextNotFound(name: "missing-ctx"),
            .mergeError(reason: "conflict"),
            .clientError(reason: "timeout"),
            .ioError(reason: "permission denied"),
            .keychainError(reason: "item not found")
        ]

        for error in cases {
            XCTAssertNotNil(
                error.errorDescription,
                "errorDescription must not be nil for \(error)"
            )
            XCTAssertFalse(
                error.errorDescription?.isEmpty == true,
                "errorDescription must not be empty for \(error)"
            )
        }
    }

    func testFileNotFound_descriptionContainsPath() {
        let error = CubeliteError.fileNotFound(path: "/home/user/.kube/config")
        XCTAssertTrue(error.errorDescription?.contains("/home/user/.kube/config") == true)
    }

    func testContextNotFound_descriptionContainsName() {
        let error = CubeliteError.contextNotFound(name: "prod-cluster")
        XCTAssertTrue(error.errorDescription?.contains("prod-cluster") == true)
    }
}


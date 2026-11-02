import XCTest

@testable import cubelite

// MARK: - Kubeconfig Auto-Discovery Tests
//
// Tests for automatic discovery of kubeconfig files in ~/.kube/.
// Uses temporary directories with synthetic kubeconfig files.

final class KubeconfigAutoDiscoveryTests: XCTestCase {

    private let fm = FileManager.default
    private let sut = KubeconfigService()
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = fm.temporaryDirectory.appendingPathComponent(
            "cubelite-discovery-\(UUID().uuidString)"
        )
        try? fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? fm.removeItem(at: tempDir)
        super.tearDown()
    }

    // MARK: - Helpers

    private func writeFile(_ name: String, contents: String) throws -> URL {
        let url = tempDir.appendingPathComponent(name)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func minimalKubeconfig(context: String, server: String) -> String {
        """
        apiVersion: v1
        kind: Config
        current-context: \(context)
        contexts:
        - name: \(context)
          context:
            cluster: \(context)
            user: user-\(context)
        clusters:
        - name: \(context)
          cluster:
            server: \(server)
        users:
        - name: user-\(context)
          user:
            token: test-token-\(context)
        """
    }

    // MARK: - loadFromPaths merges discovered files

    func testLoadFromPaths_mergesMultipleKubeconfigs() async throws {
        let config1 = try writeFile("config", contents: minimalKubeconfig(
            context: "default-ctx", server: "https://k8s-default.example"
        ))
        let config2 = try writeFile("kub3-dev", contents: minimalKubeconfig(
            context: "kub3-dev", server: "https://kub3.example/k8s/clusters/local"
        ))

        let config = try await sut.loadFromPaths([config1, config2])

        XCTAssertEqual(config.contexts.count, 2)
        XCTAssertTrue(config.contexts.contains("default-ctx"))
        XCTAssertTrue(config.contexts.contains("kub3-dev"))
        // First file's current-context wins
        XCTAssertEqual(config.currentContext, "default-ctx")
    }

    func testLoadFromPaths_duplicateContextNames_firstWins() async throws {
        let config1 = try writeFile("config", contents: minimalKubeconfig(
            context: "shared", server: "https://server-a.example"
        ))
        let config2 = try writeFile("extra", contents: minimalKubeconfig(
            context: "shared", server: "https://server-b.example"
        ))

        let config = try await sut.loadFromPaths([config1, config2])

        XCTAssertEqual(config.contexts.count, 1)
        XCTAssertEqual(
            config.raw.clusters?.first?.cluster?.server,
            "https://server-a.example"
        )
    }

    // MARK: - Rancher-style kubeconfig without namespace

    func testLoadFromPaths_rancherKubeconfig_noNamespace_loadsSuccessfully() async throws {
        let rancherYAML = """
            apiVersion: v1
            kind: Config
            current-context: kub3-dev
            contexts:
            - name: kub3-dev
              context:
                cluster: kub3-dev
                user: kub3-dev
            clusters:
            - name: kub3-dev
              cluster:
                server: "https://kub3.ors.it/k8s/clusters/local"
                certificate-authority-data: "dGVzdA=="
            users:
            - name: kub3-dev
              user:
                token: test-token
            """
        let url = try writeFile("kub3-dev", contents: rancherYAML)

        let config = try await sut.loadFromPaths([url])

        XCTAssertEqual(config.contexts, ["kub3-dev"])
    }

    func testLoadFromPaths_rancherPlusDefault_mergesContexts() async throws {
        let defaultConfig = try writeFile("config", contents: minimalKubeconfig(
            context: "minikube", server: "https://127.0.0.1:8443" // NOSONAR — test fixture
        ))
        let rancherConfig = try writeFile("kub3-dev", contents: minimalKubeconfig(
            context: "kub3-dev", server: "https://kub3.ors.it/k8s/clusters/local"
        ))

        let config = try await sut.loadFromPaths([defaultConfig, rancherConfig])

        XCTAssertEqual(config.contexts.sorted(), ["kub3-dev", "minikube"])
        XCTAssertEqual(config.currentContext, "minikube")
    }

    // MARK: - discoverKubeconfigFiles

    private func discover() -> [String] {
        KubeconfigService.discoverKubeconfigFiles(
            in: tempDir, excluding: tempDir.appendingPathComponent("config")
        ).map(\.lastPathComponent)
    }

    func testDiscoverKubeconfigFiles_skipsDirectories() throws {
        _ = try writeFile("config", contents: minimalKubeconfig(
            context: "main", server: "https://main.example"
        ))
        let subDir = tempDir.appendingPathComponent("cache")
        try fm.createDirectory(at: subDir, withIntermediateDirectories: true)
        try minimalKubeconfig(context: "nested", server: "https://nested.example").write(
            to: subDir.appendingPathComponent("nested"), atomically: true, encoding: .utf8
        )

        XCTAssertEqual(discover(), [])
    }

    func testDiscoverKubeconfigFiles_skipsNonKubeconfigs() throws {
        _ = try writeFile("config", contents: minimalKubeconfig(
            context: "main", server: "https://main.example"
        ))
        _ = try writeFile("notes.txt", contents: "this is not a kubeconfig")
        _ = try writeFile("other.yaml", contents: """
            apiVersion: v1
            kind: Pod
            metadata:
              name: test
            """)
        _ = try writeFile("blob.json", contents: #"{"name":"not a kubeconfig"}"#)

        XCTAssertEqual(discover(), [])
    }

    func testDiscoverKubeconfigFiles_findsExtraKubeconfigsSortedExcludingDefault() throws {
        _ = try writeFile("config", contents: minimalKubeconfig(
            context: "main", server: "https://main.example"
        ))
        _ = try writeFile("staging-cluster", contents: minimalKubeconfig(
            context: "staging", server: "https://staging.example"
        ))
        _ = try writeFile("kub3-dev", contents: minimalKubeconfig(
            context: "kub3-dev", server: "https://kub3.example"
        ))
        _ = try writeFile("notes.txt", contents: "not a kubeconfig at all")

        XCTAssertEqual(discover(), ["kub3-dev", "staging-cluster"])
    }

    /// kubectl sorts keys, so with inline CA data `kind: Config` sits far past
    /// the 512-byte header the old heuristic read (#473).
    func testDiscoverKubeconfigFiles_findsKubectlOrderedFileWithLongCertificateData() throws {
        let caData = String(repeating: "QUJD", count: 2_000)
        _ = try writeFile("kubectl-generated", contents: """
            apiVersion: v1
            clusters:
            - cluster:
                certificate-authority-data: \(caData)
                server: https://prod.example:6443
              name: prod
            contexts:
            - context:
                cluster: prod
                user: prod-admin
              name: prod
            current-context: prod
            kind: Config
            preferences: {}
            users:
            - name: prod-admin
              user:
                token: test-token
            """)

        XCTAssertEqual(discover(), ["kubectl-generated"])
    }

    func testDiscoverKubeconfigFiles_followsSymlinksToFilesOnly() throws {
        let target = fm.temporaryDirectory.appendingPathComponent(
            "cubelite-link-target-\(UUID().uuidString)"
        )
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: target) }
        let real = target.appendingPathComponent("real")
        try minimalKubeconfig(context: "linked", server: "https://linked.example").write(
            to: real, atomically: true, encoding: .utf8
        )
        try fm.createSymbolicLink(
            at: tempDir.appendingPathComponent("linked"), withDestinationURL: real)
        try fm.createSymbolicLink(
            at: tempDir.appendingPathComponent("dir-link"), withDestinationURL: target)
        try fm.createSymbolicLink(
            at: tempDir.appendingPathComponent("dangling"),
            withDestinationURL: target.appendingPathComponent("absent"))

        XCTAssertEqual(discover(), ["linked"])
    }
}

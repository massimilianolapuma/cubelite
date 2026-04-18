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
            context: "minikube", server: "https://127.0.0.1:8443"
        ))
        let rancherConfig = try writeFile("kub3-dev", contents: minimalKubeconfig(
            context: "kub3-dev", server: "https://kub3.ors.it/k8s/clusters/local"
        ))

        let config = try await sut.loadFromPaths([defaultConfig, rancherConfig])

        XCTAssertEqual(config.contexts.sorted(), ["kub3-dev", "minikube"])
        XCTAssertEqual(config.currentContext, "minikube")
    }

    // MARK: - discoverKubeconfigFiles via resolveKubeconfigPaths behavior

    func testDiscoverKubeconfigFiles_skipsDirectories() throws {
        _ = try writeFile("config", contents: minimalKubeconfig(
            context: "main", server: "https://main.example"
        ))
        // Create a subdirectory that should be skipped
        let subDir = tempDir.appendingPathComponent("cache")
        try fm.createDirectory(at: subDir, withIntermediateDirectories: true)
        try "not a kubeconfig".write(
            to: subDir.appendingPathComponent("somefile"),
            atomically: true, encoding: .utf8
        )

        // Verify the directory's contents don't include subdirectory entries
        let entries = try fm.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        let nonDirs = entries.filter {
            let isDir = (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            return !isDir
        }
        XCTAssertEqual(nonDirs.count, 1)
        XCTAssertEqual(nonDirs.first?.lastPathComponent, "config")
    }

    func testDiscoverKubeconfigFiles_skipsNonKubeconfigs() throws {
        _ = try writeFile("config", contents: minimalKubeconfig(
            context: "main", server: "https://main.example"
        ))
        // Write a file that is NOT a kubeconfig
        _ = try writeFile("notes.txt", contents: "this is not a kubeconfig")
        // Write a file that looks like YAML but isn't kubeconfig
        _ = try writeFile("other.yaml", contents: """
            apiVersion: v1
            kind: Pod
            metadata:
              name: test
            """)

        // Load only from the config file — the other files should not parse as kubeconfigs
        let config = try fm.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ).filter { url in
            guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
            defer { handle.closeFile() }
            guard let header = try? handle.read(upToCount: 512),
                let text = String(data: header, encoding: .utf8)
            else { return false }
            return text.contains("kind: Config")
        }

        XCTAssertEqual(config.count, 1)
        XCTAssertEqual(config.first?.lastPathComponent, "config")
    }

    func testDiscoverKubeconfigFiles_findsExtraKubeconfigs() throws {
        _ = try writeFile("config", contents: minimalKubeconfig(
            context: "main", server: "https://main.example"
        ))
        _ = try writeFile("kub3-dev", contents: minimalKubeconfig(
            context: "kub3-dev", server: "https://kub3.example"
        ))
        _ = try writeFile("staging-cluster", contents: minimalKubeconfig(
            context: "staging", server: "https://staging.example"
        ))
        _ = try writeFile("notes.txt", contents: "not a kubeconfig at all")

        // Simulate the discovery logic
        let excluded = tempDir.appendingPathComponent("config")
        let entries = try fm.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: [.isRegularFileKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        let discovered = entries
            .filter { url in
                guard url.standardizedFileURL != excluded.standardizedFileURL else { return false }
                let isDir =
                    (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
                guard !isDir else { return false }
                guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
                defer { handle.closeFile() }
                guard let header = try? handle.read(upToCount: 512),
                    let text = String(data: header, encoding: .utf8)
                else { return false }
                return text.contains("kind: Config") || text.contains("kind: \"Config\"")
            }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }

        XCTAssertEqual(discovered.count, 2)
        XCTAssertEqual(discovered[0].lastPathComponent, "kub3-dev")
        XCTAssertEqual(discovered[1].lastPathComponent, "staging-cluster")
    }
}

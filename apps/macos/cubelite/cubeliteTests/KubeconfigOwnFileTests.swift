import XCTest

@testable import cubelite

// MARK: - KubeconfigOwnFileTests

/// A context resolves its cluster and user against the kubeconfig file that
/// defines it, not against a stale same-named entry of an earlier file (#543).
final class KubeconfigOwnFileTests: XCTestCase {

    private let sut = KubeconfigService()
    private let keychain = KeychainService()
    private var cleanupAccounts: [String] = []
    private var tempDir: URL?
    /// The earlier file's cluster that only a cross-file reference uses.
    private let onlyStaleServer =
        "https://only-stale-\(UUID().uuidString.prefix(8).lowercased()).test:6443"

    override func tearDown() async throws {
        for account in cleanupAccounts + [onlyStaleServer] {
            try? await keychain.delete(tag: .bearerToken, account: account)
        }
        if let tempDir {
            try? FileManager.default.removeItem(at: tempDir)
        }
    }

    // MARK: - Load + session resolution

    func testClash_contextUsesClusterAndUserOfItsOwnFile() async throws {
        let (oldServer, newServer) = (uniqueServer(), uniqueServer())
        let stale = try write("config", staleYAML(server: oldServer))
        let own = try write("dolomiti", ownYAML(server: newServer, crossCluster: "only-stale"))

        let config = try await sut.loadFromPaths([stale, own])

        XCTAssertEqual(config.serverURL(for: "aks-prod"), newServer)
        XCTAssertEqual(config.cluster(forContext: "aks-prod")?.cluster?.server, newServer)
        let user = config.user(forContext: "aks-prod")?.user
        XCTAssertEqual(user?.exec?.command, "kubelogin")
        XCTAssertNil(user?.token, "Own-file tokens are redacted like merged ones")
        // The token the session will use was imported under the new server.
        let stored = try await keychain.retrieveString(tag: .bearerToken, account: newServer)
        XCTAssertEqual(stored, "new-token")
        // Names are unchanged: nothing synthetic leaks into the model.
        XCTAssertEqual(config.contexts, ["aks-prod", "cross"])
        XCTAssertEqual(config.raw.clusters?.map(\.name), ["aks-prod", "only-stale"])
        // current-context resolves the same way.
        XCTAssertEqual(config.currentContext, "aks-prod")
        XCTAssertEqual(
            config.currentContext.flatMap { config.cluster(forContext: $0)?.cluster?.server },
            newServer)
    }

    func testCrossFileReference_fallsBackToEarlierFile() async throws {
        let (oldServer, newServer) = (uniqueServer(), uniqueServer())
        let stale = try write("config", staleYAML(server: oldServer))
        let own = try write("dolomiti", ownYAML(server: newServer, crossCluster: "only-stale"))

        let config = try await sut.loadFromPaths([stale, own])

        XCTAssertEqual(config.serverURL(for: "cross"), onlyStaleServer)
        // The user is still the context file's own.
        XCTAssertEqual(config.user(forContext: "cross")?.user?.exec?.command, "kubelogin")
    }

    func testNoClash_resolutionUnchanged() async throws {
        let newServer = uniqueServer()
        let own = try write("dolomiti", ownYAML(server: newServer, crossCluster: "aks-prod"))
        let stale = try write("config", staleYAML(server: uniqueServer()))

        // Context file first: its entries win either way.
        let config = try await sut.loadFromPaths([own, stale])

        XCTAssertEqual(config.serverURL(for: "aks-prod"), newServer)
        XCTAssertEqual(config.user(forContext: "aks-prod")?.user?.exec?.command, "kubelogin")
    }

    func testModelWithoutOwnEntries_usesMergedLookup() {
        let raw = RawKubeConfig(
            contexts: [
                NamedContext(
                    name: "dev", context: ContextDetails(cluster: "c", user: "u", namespace: nil))
            ],
            clusters: [NamedCluster(name: "c", cluster: cluster("https://c.example"))],
            users: [NamedUser(name: "u", user: UserDetails(clientCertificateData: "Y2VydA=="))]
        )
        let config = KubeConfig(contexts: ["dev"], currentContext: "dev", raw: raw, paths: [])

        XCTAssertEqual(config.cluster(forContext: "dev")?.cluster?.server, "https://c.example")
        XCTAssertEqual(config.user(forContext: "dev")?.user?.clientCertificateData, "Y2VydA==")
        XCTAssertNil(config.cluster(forContext: "missing"))
    }

    // MARK: - Redefinitions (Preferences)

    func testRedefinitions_reportDifferentEntriesOnly() throws {
        let stale = try write("config", staleYAML(server: "https://old.example:6443"))
        let own = try write(
            "dolomiti", ownYAML(server: "https://new.example:6443", crossCluster: "only-stale"))

        let found = KubeconfigService.redefinitions(in: [stale, own])

        XCTAssertEqual(
            found,
            [KubeconfigRedefinition(path: own.path, clusters: ["aks-prod"], users: ["aks-user"])])
        XCTAssertEqual(
            found.first?.summary,
            "Also defined differently in an earlier file: cluster aks-prod, user aks-user."
                + " Contexts in this file use this file's definition.")
    }

    func testRedefinitions_identicalDuplicatesAreNotReported() throws {
        let yaml = ownYAML(server: "https://same.example:6443", crossCluster: "aks-prod")
        let first = try write("a", yaml)
        let second = try write("b", yaml)
        let missing = (tempDir ?? first).appendingPathComponent("missing")

        XCTAssertEqual(KubeconfigService.redefinitions(in: [first, missing, second]), [])
    }

    func testMerge_caChangeCountsAsRedefinition() {
        let a = RawKubeConfig(clusters: [
            NamedCluster(name: "c", cluster: cluster("https://c.example", ca: "T0xE"))
        ])
        let b = RawKubeConfig(clusters: [
            NamedCluster(name: "c", cluster: cluster("https://c.example", ca: "TkVX"))
        ])

        let merge = KubeconfigMerge(files: [
            (URL(fileURLWithPath: "/a"), a), (URL(fileURLWithPath: "/b"), b),
        ])

        XCTAssertEqual(merge.redefinitions.map(\.clusters), [["c"]])
        XCTAssertEqual(merge.clusters.first?.cluster?.certificateAuthorityData, "T0xE")
    }

    // MARK: - Helpers

    private func cluster(_ server: String, ca: String? = nil) -> ClusterDetails {
        ClusterDetails(
            server: server, certificateAuthorityData: ca, certificateAuthority: nil,
            insecureSkipTlsVerify: nil)
    }

    private func uniqueServer() -> String {
        let server = "https://own-file-\(UUID().uuidString.prefix(8).lowercased()).test:6443"
        cleanupAccounts.append(server)
        return server
    }

    private func write(_ name: String, _ contents: String) throws -> URL {
        let dir: URL
        if let tempDir {
            dir = tempDir
        } else {
            dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("own-file-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            tempDir = dir
        }
        let url = dir.appendingPathComponent(name)
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    /// Earlier file: stale `aks-prod` cluster/user no context of its own uses.
    private func staleYAML(server: String) -> String {
        """
        apiVersion: v1
        kind: Config
        clusters:
        - name: aks-prod
          cluster:
            server: \(server)
        - name: only-stale
          cluster:
            server: \(onlyStaleServer)
        users:
        - name: aks-user
          user:
            token: old-token
        """
    }

    /// Later file defining its contexts with their own cluster and user.
    private func ownYAML(server: String, crossCluster: String) -> String {
        """
        apiVersion: v1
        kind: Config
        current-context: aks-prod
        contexts:
        - name: aks-prod
          context:
            cluster: aks-prod
            user: aks-user
        - name: cross
          context:
            cluster: \(crossCluster)
            user: aks-user
        clusters:
        - name: aks-prod
          cluster:
            server: \(server)
        users:
        - name: aks-user
          user:
            token: new-token
            exec:
              apiVersion: client.authentication.k8s.io/v1beta1
              command: kubelogin
        """
    }
}

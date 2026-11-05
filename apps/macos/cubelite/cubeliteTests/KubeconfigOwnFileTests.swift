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
        // Nothing (in particular the stale token) lands under the old server.
        let underOld = try await keychain.retrieveString(tag: .bearerToken, account: oldServer)
        XCTAssertNil(underOld)
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

    // MARK: - Stale Keychain imports

    /// Same server in both files, token rotated: builds before #543 imported
    /// the earlier file's token; loading now replaces it.
    func testSameServer_staleImportedToken_isReplacedByOwnFileToken() async throws {
        let server = uniqueServer()
        try await keychain.storeString("old-token", tag: .bearerToken, account: server)
        let stale = try write("config", staleYAML(server: server))
        let own = try write("dolomiti", ownYAML(server: server, crossCluster: "aks-prod"))

        _ = try await sut.loadFromPaths([stale, own])

        let stored = try await keychain.retrieveString(tag: .bearerToken, account: server)
        XCTAssertEqual(stored, "new-token")
    }

    func testSameServer_userEnteredToken_isKept() async throws {
        let server = uniqueServer()
        try await keychain.storeString("typed-by-user", tag: .bearerToken, account: server)
        let stale = try write("config", staleYAML(server: server))
        let own = try write("dolomiti", ownYAML(server: server, crossCluster: "aks-prod"))

        _ = try await sut.loadFromPaths([stale, own])

        let stored = try await keychain.retrieveString(tag: .bearerToken, account: server)
        XCTAssertEqual(stored, "typed-by-user")
    }

    func testResetStoredCredentials_deletesOwnFileServerTokens() async throws {
        let (oldServer, newServer) = (uniqueServer(), uniqueServer())
        let stale = try write("config", staleYAML(server: oldServer))
        let own = try write("dolomiti", ownYAML(server: newServer, crossCluster: "only-stale"))
        await sut.configure(paths: [stale, own])
        _ = try await sut.load()
        let imported = try await keychain.retrieveString(tag: .bearerToken, account: newServer)
        XCTAssertEqual(imported, "new-token")

        await KubeAPIService(kubeconfigService: sut).resetStoredCredentials()

        let left = try await keychain.retrieveString(tag: .bearerToken, account: newServer)
        XCTAssertNil(left)
    }

    // MARK: - Connection caches

    func testConnectionCacheKey_separatesDifferentEntriesOnOneServer() {
        let base = "https://shared.example:6443"
        let target = cluster(base)
        let first = UserDetails(clientCertificateData: "QQ==")
        let second = UserDetails(clientCertificateData: "Qg==")

        XCTAssertNotEqual(
            KubeAPIService.connectionCacheKey(base: base, cluster: target, user: first),
            KubeAPIService.connectionCacheKey(base: base, cluster: target, user: second))
        XCTAssertNotEqual(
            KubeAPIService.connectionCacheKey(base: base, cluster: target, user: first),
            KubeAPIService.connectionCacheKey(
                base: base, cluster: cluster(base, ca: "Q0E="), user: first))
        XCTAssertEqual(
            KubeAPIService.connectionCacheKey(base: base, cluster: target, user: first),
            KubeAPIService.connectionCacheKey(base: base, cluster: cluster(base), user: first))
        XCTAssertTrue(
            KubeAPIService.connectionCacheKey(base: base, cluster: target, user: first)
                .hasPrefix(base + "#"))
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

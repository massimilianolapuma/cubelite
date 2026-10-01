import XCTest

@testable import cubelite

final class KubeConfigServerURLTests: XCTestCase {

    private func config(server: String?) -> KubeConfig {
        let raw = RawKubeConfig(
            contexts: [
                NamedContext(
                    name: "dev", context: ContextDetails(cluster: "dev-cluster", user: "me", namespace: nil)),
                NamedContext(
                    name: "orphan", context: ContextDetails(cluster: "missing", user: "me", namespace: nil)),
            ],
            clusters: [
                NamedCluster(
                    name: "dev-cluster",
                    cluster: ClusterDetails(
                        server: server, certificateAuthorityData: nil, certificateAuthority: nil,
                        insecureSkipTlsVerify: nil))
            ])
        return KubeConfig(contexts: ["dev", "orphan"], currentContext: "dev", raw: raw, paths: [])
    }

    func testServerURLResolvesThroughTheContextCluster() {
        XCTAssertEqual(config(server: "10.0.0.1:6443").serverURL(for: "dev"), "10.0.0.1:6443")
    }

    func testServerURLIsNilForUnknownOrIncompleteEntries() {
        let cfg = config(server: "10.0.0.1:6443")
        XCTAssertNil(cfg.serverURL(for: "nope"))
        XCTAssertNil(cfg.serverURL(for: "orphan"))
        XCTAssertNil(config(server: "").serverURL(for: "dev"))
        XCTAssertNil(config(server: nil).serverURL(for: "dev"))
    }
}

import XCTest

@testable import cubelite

final class IdentityHelpersTests: XCTestCase {

    func testProviderMatchesManagedClouds() {
        XCTAssertEqual(
            ClusterIdentity.provider(name: "prod", server: "prod-dns.hcp.westeurope.azmk8s.io:443"),
            "AKS")
        XCTAssertEqual(ClusterIdentity.provider(name: "aks-eu", server: nil), "AKS")
        XCTAssertEqual(
            ClusterIdentity.provider(
                name: "arn:aws:eks:eu-west-1:1:cluster/api",
                server: "abc.gr7.eu-west-1.eks.amazonaws.com"),
            "EKS")
        XCTAssertEqual(ClusterIdentity.provider(name: "gke_proj_europe-west1_main", server: nil), "GKE")
    }

    func testProviderMatchesLocalDistributions() {
        XCTAssertEqual(ClusterIdentity.provider(name: "k3d-dev", server: nil), "K3S")
        XCTAssertEqual(ClusterIdentity.provider(name: "kind-kind", server: nil), "KIND")
        XCTAssertEqual(ClusterIdentity.provider(name: "minikube", server: nil), "LOCAL")
        XCTAssertEqual(ClusterIdentity.provider(name: "docker-desktop", server: nil), "LOCAL")
        XCTAssertEqual(ClusterIdentity.provider(name: "dev", server: "127.0.0.1:6443"), "LOCAL")
    }

    func testProviderFallsBackToK8s() {
        XCTAssertEqual(ClusterIdentity.provider(name: "prod", server: "10.0.0.1:6443"), "K8S")
        XCTAssertEqual(ClusterIdentity.provider(name: "", server: nil), "K8S")
    }

    func testProviderIsCaseInsensitive() {
        XCTAssertEqual(ClusterIdentity.provider(name: "Prod-EKS", server: nil), "EKS")
    }
}

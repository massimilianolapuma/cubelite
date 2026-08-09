import XCTest

@testable import cubelite

final class ContainerIdentityTests: XCTestCase {

    private func makeInfo(name: String, isInit: Bool) -> ContainerInfo {
        ContainerInfo(
            name: name,
            isInit: isInit,
            isSidecar: false,
            restarts: 0,
            ready: true,
            state: .running,
            lastTerminatedReason: nil,
            lastTerminatedAt: nil)
    }

    private var containers: [ContainerInfo] {
        [
            makeInfo(name: "worker", isInit: false),
            makeInfo(name: "envoy", isInit: false),
            makeInfo(name: "extra", isInit: false),
            makeInfo(name: "init-migrate", isInit: true),
        ]
    }

    func testInitAlwaysAmber() {
        XCTAssertEqual(
            ContainerIdentity.color(for: "init-migrate", in: containers), DesignTokens.clusterAmber)
    }

    func testRegularsCycleBlueTeal() {
        XCTAssertEqual(ContainerIdentity.color(for: "worker", in: containers), DesignTokens.clusterBlue)
        XCTAssertEqual(ContainerIdentity.color(for: "envoy", in: containers), DesignTokens.clusterTeal)
        XCTAssertEqual(ContainerIdentity.color(for: "extra", in: containers), DesignTokens.clusterBlue)
    }

    func testUnknownFallsBackToBlue() {
        XCTAssertEqual(ContainerIdentity.color(for: "ghost", in: containers), DesignTokens.clusterBlue)
    }
}

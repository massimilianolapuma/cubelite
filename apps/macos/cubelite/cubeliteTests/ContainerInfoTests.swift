import XCTest

@testable import cubelite

final class ContainerInfoTests: XCTestCase {

    /// Pod with an app container, a native sidecar init container, and a
    /// plain init container — mirroring the design-handoff example pod.
    private func makePod() -> K8sPod {
        K8sPod(
            metadata: K8sObjectMeta(name: "web-1", namespace: "default"),
            spec: K8sPodSpec(
                containers: [K8sContainer(name: "worker")],
                initContainers: [
                    K8sContainer(name: "envoy", restartPolicy: "Always"),
                    K8sContainer(name: "init-migrate"),
                ]
            ),
            status: K8sPodStatus(
                containerStatuses: [
                    K8sContainerStatus(
                        name: "worker",
                        ready: false,
                        restartCount: 7,
                        state: K8sContainerState(
                            waiting: K8sContainerStateWaiting(reason: "CrashLoopBackOff")),
                        lastState: K8sContainerState(
                            terminated: K8sContainerStateTerminated(
                                reason: "OOMKilled", finishedAt: "2026-07-15T10:00:00Z"))
                    )
                ],
                initContainerStatuses: [
                    K8sContainerStatus(
                        name: "envoy", ready: true, restartCount: 0,
                        state: K8sContainerState(
                            running: K8sContainerStateRunning(startedAt: "2026-07-15T09:00:00Z"))),
                    K8sContainerStatus(
                        name: "init-migrate", ready: false, restartCount: 0,
                        state: K8sContainerState(
                            terminated: K8sContainerStateTerminated(reason: "Completed"))),
                ]
            )
        )
    }

    func testToContainerInfos_ordersAppThenSidecarThenInit() {
        let infos = makePod().toContainerInfos()
        XCTAssertEqual(infos.map(\.name), ["worker", "envoy", "init-migrate"])
    }

    func testToContainerInfos_sidecarDetection_initWithRestartPolicyAlways() {
        let infos = makePod().toContainerInfos()
        let envoy = infos.first { $0.name == "envoy" }
        XCTAssertEqual(envoy?.isSidecar, true)
        XCTAssertEqual(envoy?.isInit, false)
        let initMigrate = infos.first { $0.name == "init-migrate" }
        XCTAssertEqual(initMigrate?.isSidecar, false)
        XCTAssertEqual(initMigrate?.isInit, true)
    }

    func testToContainerInfos_mapsStatusRestartsAndState() {
        let worker = makePod().toContainerInfos().first { $0.name == "worker" }
        XCTAssertEqual(worker?.restarts, 7)
        XCTAssertEqual(worker?.state, .waiting(reason: "CrashLoopBackOff"))
        XCTAssertEqual(worker?.lastTerminatedReason, "OOMKilled")
        XCTAssertEqual(worker?.lastTerminatedAt, "2026-07-15T10:00:00Z")
    }

    func testToContainerInfos_missingStatus_defaultsToWaitingZeroRestarts() {
        let pod = K8sPod(
            metadata: K8sObjectMeta(name: "p", namespace: "ns"),
            spec: K8sPodSpec(containers: [K8sContainer(name: "app")]))
        let infos = pod.toContainerInfos()
        XCTAssertEqual(infos.count, 1)
        XCTAssertEqual(infos[0].restarts, 0)
        XCTAssertEqual(infos[0].state, .waiting(reason: nil))
        XCTAssertEqual(infos[0].ready, false)
    }
}

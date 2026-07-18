import XCTest

@testable import cubelite

// MARK: - MetricsAndEventsMappingTests

/// Tests DTO → display-model mappings for node metrics, node allocatable
/// capacity, and Warning events.
final class MetricsAndEventsMappingTests: XCTestCase {

    // MARK: - Node metrics

    func testToNodeMetricsInfo_parsesUsageQuantities() {
        let dto = K8sNodeMetrics(
            metadata: K8sObjectMeta(name: "node-a"),
            usage: K8sNodeMetrics.Usage(cpu: "250m", memory: "1024Ki")
        )

        let info = dto.toNodeMetricsInfo()

        XCTAssertEqual(info.name, "node-a")
        XCTAssertEqual(info.cpuCores, 0.25)
        XCTAssertEqual(info.memoryBytes, 1024 * 1024.0)
    }

    func testToNodeMetricsInfo_missingUsage_isNil() {
        let dto = K8sNodeMetrics(metadata: K8sObjectMeta(name: "node-a"), usage: nil)

        let info = dto.toNodeMetricsInfo()

        XCTAssertNil(info.cpuCores)
        XCTAssertNil(info.memoryBytes)
    }

    // MARK: - Node allocatable

    func testToNodeInfo_parsesAllocatable() {
        let node = K8sNode(
            metadata: K8sObjectMeta(name: "node-a"),
            status: K8sNodeStatus(
                conditions: [K8sNodeCondition(type: "Ready", status: "True")],
                nodeInfo: nil,
                allocatable: ["cpu": "7910m", "memory": "16Gi"]
            )
        )

        let info = node.toNodeInfo()

        XCTAssertEqual(info.allocatableCPUCores!, 7.91, accuracy: 1e-9)
        XCTAssertEqual(info.allocatableMemoryBytes, 16 * 1_073_741_824.0)
    }

    func testToNodeInfo_missingAllocatable_isNil() {
        let node = K8sNode(
            metadata: K8sObjectMeta(name: "node-a"),
            status: K8sNodeStatus(conditions: nil, nodeInfo: nil, allocatable: nil)
        )

        let info = node.toNodeInfo()

        XCTAssertNil(info.allocatableCPUCores)
        XCTAssertNil(info.allocatableMemoryBytes)
    }

    // MARK: - Events

    func testToEventInfo_mapsInvolvedObject() {
        let dto = K8sEvent(
            metadata: K8sObjectMeta(name: "evt-1", namespace: "default"),
            reason: "BackOff",
            message: "Back-off restarting failed container",
            type: "Warning",
            count: 12,
            lastTimestamp: "2026-07-18T10:00:00Z",
            involvedObject: K8sEvent.InvolvedObject(kind: "Pod", name: "api-1")
        )

        let info = dto.toEventInfo()

        XCTAssertEqual(info.name, "evt-1")
        XCTAssertEqual(info.namespace, "default")
        XCTAssertEqual(info.reason, "BackOff")
        XCTAssertEqual(info.objectKind, "Pod")
        XCTAssertEqual(info.objectName, "api-1")
        XCTAssertEqual(info.count, 12)
        XCTAssertEqual(info.lastTimestamp, "2026-07-18T10:00:00Z")
    }

    func testSortedMostRecentFirst_ordersByLastTimestamp() {
        let older = EventInfo(
            name: "old", namespace: "a", reason: nil, message: nil,
            objectKind: nil, objectName: nil, count: nil,
            lastTimestamp: "2026-07-18T09:00:00Z")
        let newer = EventInfo(
            name: "new", namespace: "a", reason: nil, message: nil,
            objectKind: nil, objectName: nil, count: nil,
            lastTimestamp: "2026-07-18T11:00:00Z")
        let dateless = EventInfo(
            name: "none", namespace: "a", reason: nil, message: nil,
            objectKind: nil, objectName: nil, count: nil, lastTimestamp: nil)

        let sorted = [older, dateless, newer].sortedMostRecentFirst()

        XCTAssertEqual(sorted.map(\.name), ["new", "old", "none"])
    }
}

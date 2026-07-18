import XCTest

@testable import cubelite

// MARK: - ClusterCapacityTests

/// Tests aggregation of node allocatable capacity vs live usage.
final class ClusterCapacityTests: XCTestCase {

    private func node(_ name: String, cpu: Double?, mem: Double?) -> NodeInfo {
        var n = NodeInfo(
            name: name, status: "Ready", roles: [], version: nil, creationTimestamp: nil)
        n.allocatableCPUCores = cpu
        n.allocatableMemoryBytes = mem
        return n
    }

    func testFrom_sumsUsageAndAllocatable() {
        let nodes = [node("a", cpu: 4, mem: 8_000), node("b", cpu: 4, mem: 8_000)]
        let metrics = [
            NodeMetricsInfo(name: "a", cpuCores: 1, memoryBytes: 2_000),
            NodeMetricsInfo(name: "b", cpuCores: 3, memoryBytes: 6_000),
        ]

        let capacity = ClusterCapacity.from(nodes: nodes, metrics: metrics)

        XCTAssertEqual(capacity?.cpuUsedCores, 4)
        XCTAssertEqual(capacity?.cpuAllocatableCores, 8)
        XCTAssertEqual(capacity?.memUsedBytes, 8_000)
        XCTAssertEqual(capacity?.memAllocatableBytes, 16_000)
        XCTAssertEqual(capacity?.cpuFraction, 0.5)
        XCTAssertEqual(capacity?.memFraction, 0.5)
    }

    func testFrom_emptyMetrics_isNil() {
        XCTAssertNil(ClusterCapacity.from(nodes: [node("a", cpu: 4, mem: 8)], metrics: []))
    }

    func testFraction_zeroAllocatable_isNil() {
        let capacity = ClusterCapacity(
            cpuUsedCores: 1, cpuAllocatableCores: 0, memUsedBytes: 1, memAllocatableBytes: 0)

        XCTAssertNil(capacity.cpuFraction)
        XCTAssertNil(capacity.memFraction)
    }

    func testFraction_overCommit_clampsToOne() {
        let capacity = ClusterCapacity(
            cpuUsedCores: 12, cpuAllocatableCores: 8, memUsedBytes: 20, memAllocatableBytes: 10)

        XCTAssertEqual(capacity.cpuFraction, 1.0)
        XCTAssertEqual(capacity.memFraction, 1.0)
    }
}

import Foundation

/// Aggregated cluster capacity: live usage (metrics-server) vs node
/// allocatable totals. `nil` fractions mean the denominator is unknown.
struct ClusterCapacity: Sendable, Equatable {

    let cpuUsedCores: Double
    let cpuAllocatableCores: Double
    let memUsedBytes: Double
    let memAllocatableBytes: Double

    /// CPU usage fraction (0...1), nil when allocatable is unknown/zero.
    var cpuFraction: Double? {
        cpuAllocatableCores > 0 ? min(cpuUsedCores / cpuAllocatableCores, 1) : nil
    }

    /// Memory usage fraction (0...1), nil when allocatable is unknown/zero.
    var memFraction: Double? {
        memAllocatableBytes > 0 ? min(memUsedBytes / memAllocatableBytes, 1) : nil
    }

    /// Sums node allocatable capacity and live usage. Returns nil when no
    /// metrics are available (metrics-server absent) so callers can render
    /// an "unavailable" state.
    static func from(nodes: [NodeInfo], metrics: [NodeMetricsInfo]) -> ClusterCapacity? {
        guard !metrics.isEmpty else { return nil }
        return ClusterCapacity(
            cpuUsedCores: metrics.compactMap(\.cpuCores).reduce(0, +),
            cpuAllocatableCores: nodes.compactMap(\.allocatableCPUCores).reduce(0, +),
            memUsedBytes: metrics.compactMap(\.memoryBytes).reduce(0, +),
            memAllocatableBytes: nodes.compactMap(\.allocatableMemoryBytes).reduce(0, +)
        )
    }
}

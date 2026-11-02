import Foundation

/// The four tiles in the Overview stat row and the view each one opens
/// (#464, parity with the desktop #463).
enum OverviewStatTile: String, CaseIterable, Identifiable {
    case nodes
    case pods
    case deployments
    case warnings

    var id: String { rawValue }

    /// Tile caption.
    var title: String {
        switch self {
        case .nodes: "Nodes"
        case .pods: "Pods running"
        case .deployments: "Deploys healthy"
        case .warnings: "Warnings"
        }
    }

    /// SF Symbol shown before the caption.
    var icon: String {
        switch self {
        case .nodes: "server.rack"
        case .pods: "cube.box"
        case .deployments: "square.stack.3d.up"
        case .warnings: "exclamationmark.triangle"
        }
    }

    /// The resource view that lists what the tile counts.
    var target: ResourceType {
        switch self {
        case .nodes: .nodes
        case .pods: .pods
        case .deployments: .deployments
        case .warnings: .events
        }
    }

    /// VoiceOver hint describing where activating the tile leads.
    var accessibilityHint: String { "Opens \(target.rawValue)" }
}

import Foundation

/// Which trailing detail panel the resource browser shows (#530). On Nodes a
/// selected node wins, so a pod or deployment selected earlier never keeps
/// its panel next to the node list; elsewhere the pod or deployment shows.
enum DetailPanelChoice {
    case resource(SelectedResource)
    case node(String)
    case none

    static func choose(resourceType: ResourceType?, nodeName: String?, resource: SelectedResource?)
        -> DetailPanelChoice
    {
        if resourceType == .nodes, let nodeName { return .node(nodeName) }
        if let resource { return .resource(resource) }
        return .none
    }
}

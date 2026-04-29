import SwiftUI

// MARK: - MainView Content Column
//
// Middle column of the three-pane split: a list of resource types for the
// currently selected cluster/namespace. Extracted from `MainView` with no
// behavior change.
extension MainView {

    /// Middle column: resource type browser for the selected cluster/namespace.
    @ViewBuilder
    var resourceTypeList: some View {
        if showAllClusters {
            ContentUnavailableView {
                Label("All Clusters", systemImage: "rectangle.stack")
            } description: {
                Text("Select a cluster to browse its resources.")
            }
        } else if sidebarSelection != nil {
            List(selection: $selectedResourceType) {
                ForEach(ResourceType.allCases) { type in
                    Label(type.rawValue, systemImage: type.systemImage)
                        .font(.body)
                        .tag(type)
                }
            }
            .listStyle(.sidebar)
        } else {
            ContentUnavailableView {
                Label("Select a Namespace", systemImage: "tray.2")
            } description: {
                Text("Choose a cluster and namespace from the sidebar.")
            }
        }
    }
}

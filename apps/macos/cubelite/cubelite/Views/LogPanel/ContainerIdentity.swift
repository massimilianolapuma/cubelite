import SwiftUI

/// Identity palette for the merged log view source column (spec §UI):
/// init containers always amber; regular containers (sidecars included)
/// cycle blue → teal by fetch order. Identity, never status colors.
enum ContainerIdentity {
    private static let cycle: [Color] = [DesignTokens.clusterBlue, DesignTokens.clusterTeal]

    static func color(for name: String, in containers: [ContainerInfo]) -> Color {
        if containers.first(where: { $0.name == name })?.isInit == true {
            return DesignTokens.clusterAmber
        }
        let regulars = containers.filter { !$0.isInit }
        let index = regulars.firstIndex { $0.name == name } ?? 0
        return cycle[index % cycle.count]
    }
}

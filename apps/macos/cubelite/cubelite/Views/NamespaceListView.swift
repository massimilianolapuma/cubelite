import SwiftUI

// MARK: - Sidebar Selection

/// Identifies a (context, namespace) pair selected in the sidebar.
struct SidebarSelection: Hashable, Sendable {
    /// The kubeconfig context being browsed.
    let context: String
    /// Selected namespace, or `nil` for all namespaces.
    let namespace: String?
}

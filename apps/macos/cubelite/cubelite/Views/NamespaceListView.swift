import SwiftUI

// MARK: - Sidebar Selection

/// Identifies a (context, namespace) pair selected in the sidebar.
struct SidebarSelection: Hashable, Sendable {
    /// The kubeconfig context being browsed.
    let context: String
    /// Selected namespace, or `nil` for all namespaces.
    let namespace: String?
}

// MARK: - NamespaceListView

/// Displays an expandable list of namespaces for a single kubeconfig context
/// inside the main sidebar.
///
/// Shows a "All Namespaces" catch-all row followed by individual namespace rows.
/// Loading and error states are handled inline.
struct NamespaceListView: View {

    let contextName: String
    let namespaces: [NamespaceInfo]
    let isLoading: Bool
    let error: String?

    @Binding var selection: SidebarSelection?

    var body: some View {
        Group {
            if isLoading {
                loadingRow
            } else if let error {
                errorRow(error)
            } else {
                allNamespacesRow
                ForEach(namespaces) { ns in
                    namespaceRow(ns.name)
                }
            }
        }
    }

    // MARK: - Rows

    private var loadingRow: some View {
        HStack(spacing: 6) {
            ProgressView()
                .controlSize(.small)
            Text("Loading namespaces…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 3)
        .padding(.leading, 4)
    }

    private func errorRow(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.caption)
            .foregroundStyle(.orange)
            .lineLimit(2)
            .padding(.vertical, 3)
            .padding(.leading, 4)
    }

    private var allNamespacesRow: some View {
        namespaceRowView(namespace: nil, label: "All Namespaces", icon: "tray.2")
    }

    private func namespaceRow(_ name: String) -> some View {
        namespaceRowView(namespace: name, label: name, icon: "square.dashed")
    }

    @ViewBuilder
    private func namespaceRowView(namespace: String?, label: String, icon: String) -> some View {
        let item = SidebarSelection(context: contextName, namespace: namespace)
        let isSelected = selection == item

        Button {
            selection = item
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .imageScale(.small)
                    .frame(width: 14)
                Text(label)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 2)
        .padding(.horizontal, 4)
        .background(
            isSelected
                ? RoundedRectangle(cornerRadius: 5).fill(Color.accentColor.opacity(0.18))
                : nil
        )
        .foregroundStyle(isSelected ? Color.primary : Color.secondary)
    }
}

// MARK: - Preview

#Preview {
    @Previewable @State var selection: SidebarSelection? = SidebarSelection(context: "my-cluster", namespace: "default")
    let state = ClusterState()
    state.namespaces = [
        NamespaceInfo(name: "default", phase: "Active"),
        NamespaceInfo(name: "kube-system", phase: "Active"),
        NamespaceInfo(name: "monitoring", phase: "Active"),
    ]
    return List {
        NamespaceListView(
            contextName: "my-cluster",
            namespaces: state.namespaces,
            isLoading: false,
            error: nil,
            selection: $selection
        )
    }
    .listStyle(.sidebar)
    .frame(width: 220, height: 300)
    .environment(state)
}

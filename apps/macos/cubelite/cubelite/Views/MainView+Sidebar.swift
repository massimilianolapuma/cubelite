import SwiftUI

// MARK: - MainView Sidebar
//
// Left-column sidebar: kubeconfig contexts, namespace browser, and the
// All Clusters entry point. Extracted from `MainView` for readability —
// behavior is unchanged.
extension MainView {

    @ViewBuilder
    var sidebar: some View {
        if clusterState.noConfig {
            noConfigSidebar
        } else if isSidebarCollapsed {
            compactSidebar
        } else {
            sidebarContent
        }
    }

    private var noConfigSidebar: some View {
        VStack(spacing: 16) {
            Image(systemName: "doc.badge.questionmark")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text("No kubeconfig found")
                .font(.headline)
                .multilineTextAlignment(.center)
            Text("Place your config at\n~/.kube/config\nor set KUBECONFIG.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("CubeLite")
    }

    /// Narrow icon-only sidebar strip shown when the sidebar is in collapsed mode.
    private var compactSidebar: some View {
        VStack(spacing: 4) {
            Button {
                showAllClusters = true
                selectedContext = nil
                sidebarSelection = nil
                Task { await loadCrossClusterData() }
            } label: {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 16))
                    .foregroundStyle(showAllClusters ? Color.accentColor : .secondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .background(
                showAllClusters
                    ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15))
                    : nil
            )
            .help("All Clusters")
            .padding(.top, 8)

            Divider()
                .padding(.vertical, 4)

            ForEach(clusterState.contexts, id: \.self) { context in
                Button {
                    showAllClusters = false
                    selectedContext = context
                } label: {
                    Image(systemName: "server.rack")
                        .font(.system(size: 14))
                        .foregroundStyle(
                            (context == selectedContext && !showAllClusters)
                                ? Color.accentColor : .secondary
                        )
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(
                    (context == selectedContext && !showAllClusters)
                        ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15))
                        : nil
                )
                .help(context)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 8)
        .navigationTitle("CubeLite")
    }

    private var sidebarContent: some View {
        List {
            allClustersRow
            ForEach(clusterState.contexts, id: \.self) { context in
                Section {
                    // "All Namespaces" row — tap selects context and toggles namespace list
                    sidebarNamespaceRow(
                        context: context,
                        namespace: nil,
                        label: "All Namespaces",
                        icon: "square.grid.2x2",
                        count: context == selectedContext
                            ? clusterState.namespacePodCounts.values.reduce(0, +)
                            : nil,
                        additionalAction: {
                            withAnimation(.easeInOut(duration: 0.2)) { namespacesExpanded.toggle() }
                        }
                    )
                    .fontWeight(.medium)

                    // Collapsible namespace children under All Namespaces
                    if context == selectedContext, namespacesExpanded {
                        if isLoadingNamespaces {
                            HStack(spacing: 6) {
                                ProgressView().controlSize(.small)
                                Text("Loading\u{2026}")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.leading, 8)
                            .padding(.vertical, 2)
                        } else if let error = namespaceError {
                            Label(error, systemImage: "exclamationmark.triangle")
                                .font(.subheadline)
                                .foregroundStyle(.orange)
                                .lineLimit(2)
                                .padding(.leading, 8)
                            // Show existing fallback namespaces if any
                            ForEach(clusterState.namespaces) { ns in
                                sidebarNamespaceRow(
                                    context: context,
                                    namespace: ns.name,
                                    label: ns.name,
                                    icon: "folder",
                                    count: clusterState.namespacePodCounts[ns.name]
                                )
                                .padding(.leading, 8)
                            }
                            // Inline namespace entry
                            HStack(spacing: 4) {
                                TextField("Add namespace…", text: $manualNamespaceInput)
                                    .textFieldStyle(.roundedBorder)
                                    .font(.subheadline)
                                    .onSubmit {
                                        addManualNamespace(for: context)
                                    }
                                Button {
                                    addManualNamespace(for: context)
                                } label: {
                                    Image(systemName: "plus.circle.fill")
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.borderless)
                                .disabled(manualNamespaceInput.trimmingCharacters(
                                    in: .whitespaces
                                ).isEmpty)
                            }
                            .padding(.leading, 8)
                            .padding(.trailing, 4)
                        } else {
                            ForEach(clusterState.namespaces) { ns in
                                sidebarNamespaceRow(
                                    context: context,
                                    namespace: ns.name,
                                    label: ns.name,
                                    icon: "folder",
                                    count: clusterState.namespacePodCounts[ns.name]
                                )
                                .padding(.leading, 8)
                            }
                        }
                    }
                } header: {
                    clusterHeader(for: context)
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("CubeLite")
    }

    /// Sidebar row for the aggregated cross-cluster dashboard.
    private var allClustersRow: some View {
        Button {
            showAllClusters = true
            selectedContext = nil
            sidebarSelection = nil
            Task { await loadCrossClusterData() }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "rectangle.stack")
                    .font(.system(size: 14))
                    .frame(width: 20, height: 20)
                    .foregroundStyle(showAllClusters ? Color.accentColor : .secondary)
                Text("All Clusters")
                    .font(.body)
                Spacer(minLength: 0)
                if !clusterState.contexts.isEmpty {
                    Text("\(clusterState.contexts.count)")
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.6), in: Capsule())
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            showAllClusters
                ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15))
                : nil
        )
    }

    private func clusterHeader(for context: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "server.rack")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(context == selectedContext ? Color.accentColor : .secondary)
            Text(context)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.middle)
            if context == clusterState.currentContext {
                Circle()
                    .fill(clusterState.clusterReachable == true ? Color.green : Color.secondary)
                    .frame(width: 8, height: 8)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            selectedContext = context
        }
    }

    private func sidebarNamespaceRow(
        context: String,
        namespace: String?,
        label: String,
        icon: String,
        count: Int?,
        additionalAction: (() -> Void)? = nil
    ) -> some View {
        let item = SidebarSelection(context: context, namespace: namespace)
        let isSelected = sidebarSelection == item

        return Button {
            selectedContext = context
            sidebarSelection = item
            additionalAction?()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .frame(width: 20, height: 20)
                    .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                Text(label)
                    .font(.body)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                if additionalAction != nil, context == selectedContext {
                    Image(systemName: namespacesExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .animation(.easeInOut(duration: 0.2), value: namespacesExpanded)
                }
                if let count, count > 0 {
                    Text("\(count)")
                        .font(.caption)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.secondary.opacity(0.6), in: Capsule())
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            isSelected
                ? RoundedRectangle(cornerRadius: 6).fill(Color.accentColor.opacity(0.15))
                : nil
        )
        .foregroundStyle(isSelected ? Color.primary : .primary)
    }
}

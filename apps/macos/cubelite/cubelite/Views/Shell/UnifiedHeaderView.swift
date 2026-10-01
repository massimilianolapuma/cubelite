import SwiftUI

/// 42pt unified header bar (Design System v1, parity v2 §3): active-cluster
/// identity dot, name, provider chip and connection state on the left; the
/// "Search & switch…" palette button and the namespace dropdown on the
/// right — the desktop `Titlebar`. Refresh lives on ⌘R and diagnostics on
/// ⇧⌘D / the status bar.
struct UnifiedHeaderView: View {

    let contexts: [String]
    let selectedContext: String?
    /// API server URL of the active cluster (provider detection).
    let serverURL: String?
    let clusterReachable: Bool?
    let namespaces: [NamespaceInfo]
    /// Pod count per namespace (populated while browsing all namespaces).
    let namespacePodCounts: [String: Int]
    let selectedNamespace: String?
    let onSelectNamespace: (String?) -> Void
    let onOpenPalette: () -> Void

    @State private var showingNamespaces = false

    var body: some View {
        HStack(spacing: 12) {
            if let context = selectedContext {
                let identity = ClusterIdentity.color(for: context, in: contexts)
                HStack(spacing: 8) {
                    Circle().fill(identity).frame(width: 8, height: 8)
                        .accessibilityHidden(true)
                    Text(context)
                        .typeStyle(DesignTokens.Typography.subtitle, color: DesignTokens.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(ClusterIdentity.provider(name: context, server: serverURL))
                        .typeStyle(DesignTokens.Typography.micro.monospaced, color: identity)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(
                            identity.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: DesignTokens.radiusSm))
                        .fixedSize()
                        .accessibilityIdentifier("header.provider")
                    connectionBadge
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("header.context")
            } else {
                Text("All Clusters")
                    .typeStyle(DesignTokens.Typography.subtitle, color: DesignTokens.textPrimary)
            }

            Spacer(minLength: 8)

            searchButton

            if selectedContext != nil {
                namespaceButton
            }
        }
        // Inset for the macOS traffic lights (hidden-title-bar window).
        .padding(.leading, 78)
        .padding(.trailing, 12)
        .frame(minHeight: 42)
        .background(DesignTokens.surfaceSurface)
        .overlay(alignment: .bottom) {
            Rectangle().fill(DesignTokens.borderDefault).frame(height: 1)
        }
    }

    @ViewBuilder
    private var connectionBadge: some View {
        let (color, label): (Color, String) =
            switch clusterReachable {
            case .some(true): (DesignTokens.statusOk, "Connected")
            case .some(false): (DesignTokens.statusErr, "Unreachable")
            case .none: (DesignTokens.textTertiary, "—")
            }
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
                .accessibilityHidden(true)
            Text(label)
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textTertiary)
                .fixedSize()
        }
    }

    // MARK: - Search

    private var searchButton: some View {
        Button(action: onOpenPalette) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .iconSize(DesignTokens.iconSm)
                    .foregroundStyle(DesignTokens.textTertiary)
                    .accessibilityHidden(true)
                Text("Search & switch…")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textDisabled)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text("⌘K")
                    .typeStyle(DesignTokens.Typography.micro.monospaced, color: DesignTokens.textDisabled)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(
                        DesignTokens.surfaceRaised,
                        in: RoundedRectangle(cornerRadius: DesignTokens.radiusSm))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 10)
            .frame(width: 240, height: 28)
            .background(
                DesignTokens.surfaceWindow,
                in: RoundedRectangle(cornerRadius: DesignTokens.radiusMd))
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.radiusMd)
                    .strokeBorder(DesignTokens.borderDefault))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Search clusters, views and actions (⌘K)")
        .accessibilityLabel("Search and switch")
        .accessibilityIdentifier("header.search")
    }

    // MARK: - Namespaces

    private var namespaceButton: some View {
        Button {
            showingNamespaces.toggle()
        } label: {
            HStack(spacing: 5) {
                Text("namespace:")
                    .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textSecondary)
                Text(selectedNamespace ?? "all")
                    .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textPrimary)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .iconSize(DesignTokens.iconXs)
                    .foregroundStyle(DesignTokens.textTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 28)
            .background(
                DesignTokens.surfaceRaised,
                in: RoundedRectangle(cornerRadius: DesignTokens.radiusMd))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityLabel("Namespace")
        .accessibilityValue(selectedNamespace ?? "All namespaces")
        .accessibilityIdentifier("header.namespace")
        .popover(isPresented: $showingNamespaces, arrowEdge: .bottom) {
            namespaceList
        }
    }

    private var namespaceList: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                namespaceRow(
                    label: "All namespaces", value: nil,
                    count: namespacePodCounts.isEmpty
                        ? nil : namespacePodCounts.values.reduce(0, +))
                if !namespaces.isEmpty {
                    Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
                        .padding(.vertical, 3)
                    ForEach(namespaces) { ns in
                        namespaceRow(label: ns.name, value: ns.name, count: namespacePodCounts[ns.name])
                    }
                }
            }
            .padding(5)
        }
        .frame(width: 240)
        .frame(maxHeight: 360)
        .background(DesignTokens.surfaceOverlay)
    }

    private func namespaceRow(label: String, value: String?, count: Int?) -> some View {
        let isActive = selectedNamespace == value
        return Button {
            onSelectNamespace(value)
            showingNamespaces = false
        } label: {
            HStack(spacing: 8) {
                Text(label)
                    .typeStyle(
                        value == nil ? DesignTokens.Typography.caption : DesignTokens.Typography.dataSm,
                        color: isActive ? DesignTokens.textPrimary : DesignTokens.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                if let count {
                    Text("\(count)")
                        .typeStyle(DesignTokens.Typography.micro.monospaced, color: DesignTokens.textTertiary)
                }
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 26)
            .background(
                isActive ? DesignTokens.accentDefault.opacity(0.14) : Color.clear,
                in: RoundedRectangle(cornerRadius: DesignTokens.radiusSm))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? .isSelected : [])
        .accessibilityIdentifier("header.namespace-\(value ?? "all")")
    }
}

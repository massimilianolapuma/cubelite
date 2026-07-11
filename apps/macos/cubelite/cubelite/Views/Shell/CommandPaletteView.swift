import SwiftUI

/// Cmd+K command palette (Design System v1): fixed overlay with a 580pt
/// panel, "Switch cluster" and "Actions" sections, text filtering and full
/// keyboard driving (up/down/return/escape).
struct CommandPaletteView: View {

    let contexts: [String]
    let activeContext: String?
    let onSelectContext: (String) -> Void
    let onSelectAllClusters: () -> Void
    let onSelectResource: (ResourceType) -> Void
    let onClose: () -> Void

    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var inputFocused: Bool

    // MARK: - Items

    private enum Item: Identifiable {
        case cluster(String, shortcut: Int?)
        case allClusters
        case resource(ResourceType)

        var id: String {
            switch self {
            case .cluster(let name, _): "cluster-\(name)"
            case .allClusters: "all-clusters"
            case .resource(let type): "resource-\(type.rawValue)"
            }
        }

        var label: String {
            switch self {
            case .cluster(let name, _): name
            case .allClusters: "All Clusters dashboard"
            case .resource(let type): "Go to \(type.rawValue)"
            }
        }
    }

    private var clusterItems: [Item] {
        contexts.enumerated()
            .map { Item.cluster($0.element, shortcut: $0.offset < 5 ? $0.offset + 1 : nil) }
            .filter { query.isEmpty || $0.label.localizedCaseInsensitiveContains(query) }
    }

    private var actionItems: [Item] {
        ([Item.allClusters] + ResourceType.allCases.map { Item.resource($0) })
            .filter { query.isEmpty || $0.label.localizedCaseInsensitiveContains(query) }
    }

    private var flatItems: [Item] { clusterItems + actionItems }

    // MARK: - Body

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.45)
                .ignoresSafeArea()
                .onTapGesture { onClose() }

            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    TextField("Search clusters, views, actions…", text: $query)
                        .textFieldStyle(.plain)
                        .font(.system(size: 13.5))
                        .focused($inputFocused)
                        .onKeyPress(.downArrow) {
                            highlighted = min(highlighted + 1, max(flatItems.count - 1, 0))
                            return .handled
                        }
                        .onKeyPress(.upArrow) {
                            highlighted = max(highlighted - 1, 0)
                            return .handled
                        }
                        .onKeyPress(.return) {
                            runHighlighted()
                            return .handled
                        }
                    Text("esc")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(DesignTokens.textDisabled)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(
                            DesignTokens.surfaceRaised,
                            in: RoundedRectangle(cornerRadius: DesignTokens.radiusSm))
                }
                .padding(.horizontal, 14)
                .frame(height: 44)

                Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)

                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        if !clusterItems.isEmpty {
                            sectionHeader("Switch cluster")
                            ForEach(clusterItems) { item in
                                row(item)
                            }
                        }
                        if !actionItems.isEmpty {
                            sectionHeader("Actions")
                            ForEach(actionItems) { item in
                                row(item)
                            }
                        }
                        if flatItems.isEmpty {
                            Text("No results.")
                                .font(.system(size: 12))
                                .foregroundStyle(DesignTokens.textDisabled)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 24)
                        }
                    }
                    .padding(6)
                }
                .frame(maxHeight: 320)
            }
            .frame(width: 580)
            .background(
                DesignTokens.surfaceOverlay,
                in: RoundedRectangle(cornerRadius: DesignTokens.radius2xl)
            )
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.radius2xl)
                    .strokeBorder(DesignTokens.borderStrong)
            )
            .shadow(color: .black.opacity(0.5), radius: 40, y: 24)
            .padding(.top, 110)
        }
        .onAppear { inputFocused = true }
        .onChange(of: query) { _, _ in highlighted = 0 }
        .onExitCommand { onClose() }
    }

    // MARK: - Rows

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 9.5, weight: .semibold))
            .kerning(0.7)
            .foregroundStyle(DesignTokens.textTertiary)
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 3)
    }

    private func row(_ item: Item) -> some View {
        let index = flatItems.firstIndex(where: { $0.id == item.id }) ?? 0
        let isHighlighted = index == highlighted
        return Button {
            run(item)
        } label: {
            HStack(spacing: 10) {
                switch item {
                case .cluster(let name, let shortcut):
                    Circle()
                        .fill(ClusterIdentity.color(for: name, in: contexts))
                        .frame(width: 8, height: 8)
                    Text(name)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(DesignTokens.textPrimary)
                    if name == activeContext {
                        Circle().fill(DesignTokens.statusOk).frame(width: 6, height: 6)
                    }
                    Spacer(minLength: 0)
                    if let shortcut {
                        kbd("⌘\(shortcut)")
                    }
                case .allClusters:
                    Image(systemName: "house")
                        .font(.system(size: 11))
                        .foregroundStyle(DesignTokens.textTertiary)
                        .frame(width: 14)
                    Text(item.label)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(DesignTokens.textSecondary)
                    Spacer(minLength: 0)
                case .resource(let type):
                    Image(systemName: type.systemImage)
                        .font(.system(size: 11))
                        .foregroundStyle(DesignTokens.textTertiary)
                        .frame(width: 14)
                    Text(item.label)
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundStyle(DesignTokens.textSecondary)
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                isHighlighted
                    ? AnyShapeStyle(DesignTokens.accentDefault.opacity(0.14))
                    : AnyShapeStyle(.clear),
                in: RoundedRectangle(cornerRadius: DesignTokens.radiusLg)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func kbd(_ label: String) -> some View {
        Text(label)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(DesignTokens.textDisabled)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(
                DesignTokens.surfaceRaised,
                in: RoundedRectangle(cornerRadius: DesignTokens.radiusSm))
    }

    // MARK: - Actions

    private func runHighlighted() {
        guard flatItems.indices.contains(highlighted) else { return }
        run(flatItems[highlighted])
    }

    private func run(_ item: Item) {
        switch item {
        case .cluster(let name, _):
            onSelectContext(name)
        case .allClusters:
            onSelectAllClusters()
        case .resource(let type):
            onSelectResource(type)
        }
        onClose()
    }
}

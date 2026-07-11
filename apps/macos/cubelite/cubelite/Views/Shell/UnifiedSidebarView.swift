import SwiftUI

/// 198pt grouped navigation sidebar (Design System v1): sections with
/// group-color dots and live counts, replacing the middle resource-type
/// column of the old three-pane layout.
struct UnifiedSidebarView: View {

    @Binding var selection: ResourceType?
    let podCount: Int
    let deploymentCount: Int

    private struct Section {
        let label: String
        let dot: Color
        let items: [ResourceType]
    }

    private var sections: [Section] {
        [
            Section(label: "Cluster", dot: DesignTokens.accentDefault, items: [.dashboard]),
            Section(
                label: "Workloads", dot: DesignTokens.clusterBlue,
                items: [.pods, .deployments, .helmReleases]),
            Section(
                label: "Network", dot: DesignTokens.clusterViolet,
                items: [.services, .ingresses]),
            Section(
                label: "Config", dot: DesignTokens.statusWarn,
                items: [.configMaps, .secrets]),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(sections, id: \.label) { section in
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.label.uppercased())
                        .font(.system(size: 9.5, weight: .semibold))
                        .kerning(0.7)
                        .foregroundStyle(DesignTokens.textTertiary)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 2)
                    ForEach(section.items) { item in
                        row(for: item, dot: section.dot)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 12)
        .frame(width: 198)
        .background(DesignTokens.surfacePanel)
    }

    private func count(for item: ResourceType) -> Int? {
        switch item {
        case .pods: podCount
        case .deployments: deploymentCount
        default: nil
        }
    }

    private func row(for item: ResourceType, dot: Color) -> some View {
        let isActive = selection == item
        return Button {
            selection = item
        } label: {
            HStack(spacing: 8) {
                Circle().fill(dot).frame(width: 6, height: 6)
                Text(item.rawValue)
                    .font(.system(size: 12.5, weight: .medium))
                    .foregroundStyle(
                        isActive ? DesignTokens.textPrimary : DesignTokens.textSecondary)
                Spacer(minLength: 0)
                if let count = count(for: item) {
                    Text("\(count)")
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(DesignTokens.textTertiary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                isActive
                    ? AnyShapeStyle(DesignTokens.accentDefault.opacity(0.14))
                    : AnyShapeStyle(.clear),
                in: RoundedRectangle(cornerRadius: DesignTokens.radiusMd)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

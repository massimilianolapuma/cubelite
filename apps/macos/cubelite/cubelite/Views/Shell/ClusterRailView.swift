import SwiftUI

/// Persistent 58pt vertical rail of cluster avatars (Design System v1):
/// All-Clusters home on top, one identity avatar per kubeconfig context,
/// Preferences gear at the bottom.
struct ClusterRailView: View {

    let contexts: [String]
    let selectedContext: String?
    let showAllClusters: Bool
    let onSelectAllClusters: () -> Void
    let onSelectContext: (String) -> Void

    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(spacing: 8) {
            Button(action: onSelectAllClusters) {
                Image(systemName: "house")
                    .font(.system(size: 14, weight: .medium))
                    .frame(width: 38, height: 38)
                    .background(
                        showAllClusters
                            ? AnyShapeStyle(DesignTokens.accentDefault.opacity(0.14))
                            : AnyShapeStyle(DesignTokens.surfaceRaised),
                        in: RoundedRectangle(cornerRadius: DesignTokens.radiusXl)
                    )
                    .foregroundStyle(
                        showAllClusters ? DesignTokens.textPrimary : DesignTokens.textSecondary)
            }
            .buttonStyle(.plain)
            .help("All Clusters")
            .accessibilityIdentifier("rail-all-clusters")

            Rectangle()
                .fill(DesignTokens.borderFaint)
                .frame(width: 28, height: 1)

            ScrollView(showsIndicators: false) {
                VStack(spacing: 8) {
                    ForEach(contexts, id: \.self) { context in
                        avatar(for: context)
                    }
                }
            }

            Spacer(minLength: 0)

            Button {
                openSettings()
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 14))
                    .frame(width: 38, height: 38)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .buttonStyle(.plain)
            .help("Preferences")
        }
        .padding(.vertical, 10)
        .frame(width: 58)
        .background(DesignTokens.surfaceWindow)
        .overlay(alignment: .trailing) {
            Rectangle().fill(DesignTokens.borderFaint).frame(width: 1)
        }
    }

    private func avatar(for context: String) -> some View {
        let identity = ClusterIdentity.color(for: context, in: contexts)
        let isActive = context == selectedContext && !showAllClusters
        return Button {
            onSelectContext(context)
        } label: {
            Text(ClusterIdentity.initials(for: context))
                .font(.system(size: 12, weight: .semibold))
                .frame(width: 38, height: 38)
                .background(
                    isActive
                        ? AnyShapeStyle(identity.opacity(0.2))
                        : AnyShapeStyle(DesignTokens.surfaceRaised),
                    in: RoundedRectangle(cornerRadius: DesignTokens.radiusXl)
                )
                .foregroundStyle(isActive ? DesignTokens.textPrimary : DesignTokens.textSecondary)
                .overlay(
                    RoundedRectangle(cornerRadius: DesignTokens.radiusXl)
                        .strokeBorder(identity, lineWidth: isActive ? 2 : 0)
                )
        }
        .buttonStyle(.plain)
        .help(context)
        .accessibilityIdentifier("rail-context-\(context)")
    }
}

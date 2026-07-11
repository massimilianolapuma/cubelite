import SwiftUI

/// 42pt unified header bar (Design System v1): active-cluster identity dot +
/// name + connection state on the left; namespace picker, refresh and logs
/// on the right. Replaces the native toolbar of the old layout.
struct UnifiedHeaderView: View {

    let contexts: [String]
    let selectedContext: String?
    let clusterReachable: Bool?
    let namespaces: [NamespaceInfo]
    let selectedNamespace: String?
    let isLoading: Bool
    let unreadErrorCount: Int
    let onSelectNamespace: (String?) -> Void
    let onRefresh: () -> Void
    let onShowLogs: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            if let context = selectedContext {
                let identity = ClusterIdentity.color(for: context, in: contexts)
                HStack(spacing: 8) {
                    Circle().fill(identity).frame(width: 8, height: 8)
                    Text(context)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(DesignTokens.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    connectionBadge
                }
            } else {
                Text("All Clusters")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(DesignTokens.textPrimary)
            }

            Spacer(minLength: 8)

            if selectedContext != nil {
                namespaceMenu
            }

            Button(action: onRefresh) {
                if isLoading {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(DesignTokens.textSecondary)
                }
            }
            .buttonStyle(.plain)
            .help("Refresh all")
            .disabled(isLoading)

            Button(action: onShowLogs) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: "bell")
                        .foregroundStyle(DesignTokens.textSecondary)
                    if unreadErrorCount > 0 {
                        Text(unreadErrorCount < 100 ? "\(unreadErrorCount)" : "99+")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(2)
                            .background(DesignTokens.statusErr, in: Circle())
                            .offset(x: 5, y: -5)
                    }
                }
            }
            .buttonStyle(.plain)
            .help("View logs and errors")
        }
        // Inset for the macOS traffic lights (hidden-title-bar window).
        .padding(.leading, 78)
        .padding(.trailing, 12)
        .frame(height: 42)
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
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(DesignTokens.textTertiary)
        }
    }

    private var namespaceMenu: some View {
        Menu {
            Button("All Namespaces") { onSelectNamespace(nil) }
            if !namespaces.isEmpty {
                Divider()
                ForEach(namespaces) { ns in
                    Button(ns.name) { onSelectNamespace(ns.name) }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text("namespace:")
                    .font(.system(size: 11))
                    .foregroundStyle(DesignTokens.textSecondary)
                Text(selectedNamespace ?? "all")
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(DesignTokens.textPrimary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 8))
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .padding(.horizontal, 10)
            .frame(height: 28)
            .background(
                DesignTokens.surfaceRaised,
                in: RoundedRectangle(cornerRadius: DesignTokens.radiusMd))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }
}

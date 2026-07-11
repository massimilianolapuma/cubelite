import SwiftUI

/// Table listing Kubernetes secrets for the selected context and namespace.
///
/// Columns: Name, Namespace, Type, Data Keys, Age.
/// Actual secret values are never displayed — only the key count is shown.
struct SecretListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Binding var selectedSecretID: SecretInfo.ID?

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                loadingView
            } else if let error = clusterState.resourceError {
                errorView(error)
            } else if clusterState.secrets.isEmpty {
                emptyView
            } else {
                secretTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - States

    private var loadingView: some View {
        UnifiedLoadingState(label: "Loading secrets…")
    }

    private func errorView(_ message: String) -> some View {
        UnifiedErrorState(title: "Failed to load secrets", message: message)
    }

    private var emptyView: some View {
        UnifiedEmptyState(message: "There are no secrets in this namespace.")
    }

    // MARK: - Table

    private var secretTable: some View {
        Table(clusterState.secrets, selection: $selectedSecretID) {
            TableColumn("Name") { secret in
                Text(secret.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Namespace") { secret in
                Text(secret.namespace)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Type") { secret in
                SecretTypeTag(type: secret.type)
            }
            .width(min: 100, ideal: 160)

            TableColumn("Data Keys") { secret in
                Text("\(secret.dataCount)")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 80)

            TableColumn("Age") { secret in
                Text(secret.creationTimestamp.k8sAge)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)
        }
        .unifiedTableBackground()
    }
}

// MARK: - Secret Type Tag

/// Small badge indicating the Kubernetes secret type.
private struct SecretTypeTag: View {

    let type: String?

    var body: some View {
        Text(shortType)
            .font(.caption.weight(.medium))
            .foregroundStyle(tagColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tagColor.opacity(0.12), in: Capsule())
            .lineLimit(1)
            .truncationMode(.middle)
    }

    /// Shortened display label for well-known secret types.
    private var shortType: String {
        switch type {
        case "kubernetes.io/tls": "TLS"
        case "kubernetes.io/dockerconfigjson": "Docker"
        case "kubernetes.io/service-account-token": "SA Token"
        case "kubernetes.io/basic-auth": "Basic Auth"
        case "kubernetes.io/ssh-auth": "SSH Auth"
        case "bootstrap.kubernetes.io/token": "Bootstrap"
        default: type ?? "—"
        }
    }

    private var tagColor: Color {
        switch type {
        case "kubernetes.io/tls": .blue
        case "kubernetes.io/dockerconfigjson": .orange
        case "kubernetes.io/service-account-token": .green
        default: .secondary
        }
    }
}

// MARK: - Preview

#Preview {
    let state = ClusterState()
    state.secrets = [
        SecretInfo(
            name: "my-tls-secret",
            namespace: "default",
            type: "kubernetes.io/tls",
            dataCount: 2,
            creationTimestamp: nil
        ),
        SecretInfo(
            name: "registry-credentials",
            namespace: "default",
            type: "kubernetes.io/dockerconfigjson",
            dataCount: 1,
            creationTimestamp: nil
        ),
        SecretInfo(
            name: "app-secrets",
            namespace: "production",
            type: "Opaque",
            dataCount: 5,
            creationTimestamp: nil
        ),
    ]
    return SecretListView(selectedSecretID: .constant(nil))
        .environment(state)
        .frame(width: 800, height: 400)
}

import SwiftUI

/// Table listing Kubernetes Ingresses for the selected context and namespace.
///
/// Columns: Name, Namespace, Class, Hosts, Address, TLS, Age.
struct IngressListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Binding var selectedIngressID: IngressInfo.ID?

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                loadingView
            } else if let error = clusterState.resourceError {
                errorView(error)
            } else if clusterState.ingresses.isEmpty {
                emptyView
            } else {
                ingressTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading ingresses…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(.orange)
            Text("Failed to load ingresses")
                .font(.headline)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 20)
        }
    }

    private var emptyView: some View {
        VStack(spacing: 10) {
            Image(systemName: "globe")
                .font(.system(size: 36))
                .foregroundStyle(.quinary)
            Text("No ingresses found")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("There are no ingresses in this namespace.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Table

    private var ingressTable: some View {
        Table(clusterState.ingresses, selection: $selectedIngressID) {
            TableColumn("Name") { ingress in
                Text(ingress.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Namespace") { ingress in
                Text(ingress.namespace)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Class") { ingress in
                Text(ingress.ingressClass ?? "—")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 60, ideal: 100)

            TableColumn("Hosts") { ingress in
                Text(ingress.hosts ?? "—")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Address") { ingress in
                Text(ingress.address ?? "—")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 140)

            TableColumn("TLS") { ingress in
                if ingress.tlsEnabled {
                    Image(systemName: "lock.fill")
                        .foregroundStyle(.green)
                        .help("TLS enabled")
                } else {
                    Image(systemName: "lock.open")
                        .foregroundStyle(.secondary)
                        .help("No TLS")
                }
            }
            .width(ideal: 40)

            TableColumn("Age") { ingress in
                Text(ingress.creationTimestamp.k8sAge)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)
        }
    }
}

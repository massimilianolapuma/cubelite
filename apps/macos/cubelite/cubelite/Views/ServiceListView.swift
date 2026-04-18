import SwiftUI

/// Table listing services for the selected context and namespace.
///
/// Columns: Name, Namespace, Type, Cluster IP, Ports, Age.
/// Selecting a row updates the `selectedServiceID` binding, which the parent
/// view can use to show a detail panel.
struct ServiceListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Binding var selectedServiceID: ServiceInfo.ID?

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                loadingView
            } else if let error = clusterState.resourceError {
                errorView(error)
            } else if clusterState.services.isEmpty {
                emptyView
            } else {
                serviceTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading services…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 32))
                .foregroundStyle(.orange)
            Text("Failed to load services")
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
            Image(systemName: "network")
                .font(.system(size: 36))
                .foregroundStyle(.quinary)
            Text("No services found")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("There are no services in this namespace.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Table

    private var serviceTable: some View {
        Table(clusterState.services, selection: $selectedServiceID) {
            TableColumn("Name") { service in
                Text(service.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }
            .width(min: 120, ideal: 200)

            TableColumn("Namespace") { service in
                Text(service.namespace)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Type") { service in
                ServiceTypeTag(type: service.type)
            }
            .width(min: 70, ideal: 100)

            TableColumn("Cluster IP") { service in
                Text(service.clusterIP ?? "—")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 120)

            TableColumn("Ports") { service in
                Text(service.ports ?? "—")
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .width(min: 100, ideal: 160)

            TableColumn("Age") { service in
                Text(service.creationTimestamp.k8sAge)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .width(ideal: 60)
        }
    }
}

// MARK: - Service Type Tag

/// Small badge indicating the Kubernetes service type.
private struct ServiceTypeTag: View {

    let type: String?

    var body: some View {
        Text(type ?? "—")
            .font(.caption.weight(.medium))
            .foregroundStyle(tagColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tagColor.opacity(0.12), in: Capsule())
    }

    private var tagColor: Color {
        switch type {
        case "LoadBalancer": .blue
        case "NodePort": .orange
        case "ExternalName": .purple
        default: .secondary  // ClusterIP and unknown
        }
    }
}

// MARK: - Preview

#Preview {
    let state = ClusterState()
    state.services = [
        ServiceInfo(
            name: "kubernetes",
            namespace: "default",
            type: "ClusterIP",
            clusterIP: "10.96.0.1",
            ports: "443:6443/TCP",
            externalIP: nil,
            creationTimestamp: nil
        ),
        ServiceInfo(
            name: "nginx-ingress",
            namespace: "ingress-nginx",
            type: "LoadBalancer",
            clusterIP: "10.100.42.8",
            ports: "80:30080/TCP, 443:30443/TCP",
            externalIP: "203.0.113.10",
            creationTimestamp: nil
        ),
        ServiceInfo(
            name: "nodeport-svc",
            namespace: "default",
            type: "NodePort",
            clusterIP: "10.99.0.5",
            ports: "8080:31200/TCP",
            externalIP: nil,
            creationTimestamp: nil
        ),
    ]
    return ServiceListView(selectedServiceID: .constant(nil))
        .environment(state)
        .frame(width: 800, height: 400)
}

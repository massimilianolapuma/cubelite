import SwiftUI

/// Table listing batch Jobs for the selected context and namespace.
///
/// Columns: Status, Name, Completions, Active, Failed, Age.
struct JobListView: View {

    @Environment(ClusterState.self) private var clusterState

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                UnifiedLoadingState(label: "Loading jobs…")
            } else if let error = clusterState.resourceError {
                UnifiedErrorState(title: "Failed to load jobs", message: error)
            } else if clusterState.jobs.isEmpty {
                UnifiedEmptyState(message: "There are no jobs in this namespace.")
            } else {
                jobTable
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func tone(for job: JobInfo) -> Color {
        if job.failed > 0 { return DesignTokens.statusErr }
        if job.active > 0 { return DesignTokens.statusWarn }
        if job.succeeded >= job.completions { return DesignTokens.statusOk }
        return DesignTokens.textTertiary
    }

    private var jobTable: some View {
        Table(clusterState.jobs) {
            TableColumn("") { job in
                Circle()
                    .fill(tone(for: job))
                    .frame(width: 8, height: 8)
            }
            .width(16)

            TableColumn("Name") { job in
                Text(job.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
            }

            TableColumn("Completions") { job in
                Text("\(job.succeeded)/\(job.completions)")
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(90)

            TableColumn("Active") { job in
                Text("\(job.active)")
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(60)

            TableColumn("Failed") { job in
                Text("\(job.failed)")
                    .foregroundStyle(
                        job.failed > 0 ? DesignTokens.statusErr : DesignTokens.textSecondary)
            }
            .width(60)

            TableColumn("Age") { job in
                Text(job.creationTimestamp.k8sAge)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .width(70)
        }
        .unifiedTableBackground()
    }
}

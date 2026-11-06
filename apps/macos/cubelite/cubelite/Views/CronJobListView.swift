import SwiftUI

/// Table listing CronJobs for the selected context and namespace.
///
/// Columns: Status, Name, Schedule, Suspend, Active, Last schedule, Age.
struct CronJobListView: View {

    @Environment(ClusterState.self) private var clusterState
    @Environment(ResourcePreferences.self) private var resourcePreferences

    /// Preferences default sort or this session's header sort (#497),
    /// grouped by namespace when that applies (#551).
    private var layout: ListLayout<CronJobInfo> {
        resourcePreferences.layout(
            clusterState.cronJobs, for: .cronJobs, namespace: clusterState.selectedNamespace)
    }

    var body: some View {
        Group {
            if clusterState.isLoadingResources {
                UnifiedLoadingState(label: "Loading cron jobs…")
            } else if let error = clusterState.resourceError {
                UnifiedErrorState(title: "Failed to load cron jobs", message: error)
            } else if clusterState.cronJobs.isEmpty {
                UnifiedEmptyState(message: "There are no cron jobs in this namespace.")
            } else {
                table
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var table: some View {
        let layout = self.layout
        return Table(of: CronJobInfo.self, sortOrder: resourcePreferences.sortOrder(for: "cronjobs", of: CronJobInfo.self)) {
            TableColumn("") { job in
                Circle()
                    .fill(job.suspend ? DesignTokens.statusWarn : DesignTokens.statusOk)
                    .frame(width: 8, height: 8)
                    .help(job.suspend ? "Suspended" : "Scheduled")
                    .accessibilityHidden(true)
            }
            .width(16)

            TableColumn("Name", value: \.sortKeyName) { job in
                Text(job.name)
                    .typeStyle(DesignTokens.Typography.data)
                    .lineLimit(1)
            }

            TableColumn("Schedule") { job in
                Text(job.schedule)
                    .typeStyle(DesignTokens.Typography.dataSm)
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(110)

            TableColumn("Suspend") { job in
                Text(job.suspend ? "True" : "False")
                    .foregroundStyle(
                        job.suspend ? DesignTokens.statusWarn : DesignTokens.textSecondary)
            }
            .width(70)

            TableColumn("Active") { job in
                Text("\(job.active)")
                    .foregroundStyle(DesignTokens.textSecondary)
            }
            .width(60)

            TableColumn("Last schedule") { job in
                Text(job.lastSchedule.k8sAge)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .width(100)

            TableColumn("Age", value: \.sortKeyAge) { job in
                Text(job.creationTimestamp.k8sAge)
                    .foregroundStyle(DesignTokens.textTertiary)
            }
            .width(70)
        } rows: {
            NamespaceTableRows(layout: layout, type: .cronJobs, preferences: resourcePreferences)
        }
        .unifiedTableBackground()
    }
}

import SwiftUI

// MARK: - Row formatting

/// Pure formatting for event rows, shared by `EventListView` and its tests.
enum EventRowFormat {

    /// Column weights (fr) for TYPE / REASON / OBJECT / MESSAGE / AGE,
    /// matching the desktop `EventsView` grid.
    static let columnWeights: [CGFloat] = [0.7, 1, 1.4, 2.6, 0.5]

    /// True for `Warning` events (case-insensitive).
    static func isWarning(_ event: EventInfo) -> Bool {
        event.type?.lowercased() == "warning"
    }

    /// Type pill label; unknown types read "Normal" like the desktop.
    static func typeLabel(_ event: EventInfo) -> String {
        isWarning(event) ? "Warning" : (event.type ?? "Normal")
    }

    /// Reason, with `×count` appended when the event repeated.
    static func reasonLabel(_ event: EventInfo) -> String {
        let reason = event.reason ?? "—"
        guard let count = event.count, count > 1 else { return reason }
        return "\(reason) ×\(count)"
    }

    /// `Kind/name` of the involved object, or an em dash.
    static func objectLabel(_ event: EventInfo) -> String {
        switch (event.objectKind, event.objectName) {
        case let (kind?, name?): "\(kind)/\(name)"
        case let (nil, name?): name
        case let (kind?, nil): kind
        case (nil, nil): "—"
        }
    }

    /// Widths for each column given the available width.
    static func columnWidths(total: CGFloat) -> [CGFloat] {
        let sum = columnWeights.reduce(0, +)
        return columnWeights.map { max(0, total) * $0 / sum }
    }
}

// MARK: - Events view

/// Cluster events (Normal and Warning), most recent first.
///
/// Columns: Type, Reason, Object, Message, Age — the desktop `EventsView`
/// grid. Warning rows get a faint warn tint.
struct EventListView: View {

    @Environment(ClusterState.self) private var clusterState

    var body: some View {
        Group {
            if clusterState.isLoadingResources && clusterState.events.isEmpty {
                UnifiedLoadingState(label: "Loading events…")
            } else if let error = clusterState.resourceError {
                UnifiedErrorState(title: "Failed to load events", message: error)
            } else if clusterState.forbiddenResources.contains("events") {
                UnifiedEmptyState(message: "No access to events (RBAC restricted).")
            } else if clusterState.events.isEmpty {
                UnifiedEmptyState(message: "No events found.")
            } else {
                grid
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var grid: some View {
        GeometryReader { proxy in
            let widths = EventRowFormat.columnWidths(total: proxy.size.width - 28)
            VStack(spacing: 0) {
                header(widths)
                Divider()
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(clusterState.events) { event in
                            row(event, widths)
                            Divider().opacity(0.5)
                        }
                    }
                }
            }
        }
        .background(DesignTokens.surfacePanel)
    }

    private func header(_ widths: [CGFloat]) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(["Type", "Reason", "Object", "Message", "Age"].enumerated()), id: \.offset) {
                index, title in
                Text(title)
                    .typeStyle(DesignTokens.Typography.colhead, color: DesignTokens.textTertiary)
                    .frame(width: widths[index], alignment: .leading)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private func row(_ event: EventInfo, _ widths: [CGFloat]) -> some View {
        let warning = EventRowFormat.isWarning(event)
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            typePill(event, warning: warning)
                .frame(width: widths[0], alignment: .leading)
            Text(EventRowFormat.reasonLabel(event))
                .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textDataBright)
                .lineLimit(1)
                .frame(width: widths[1], alignment: .leading)
            Text(EventRowFormat.objectLabel(event))
                .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: widths[2], alignment: .leading)
            Text(event.message ?? "—")
                .typeStyle(DesignTokens.Typography.caption, color: DesignTokens.textSecondary)
                .lineLimit(2)
                .frame(width: widths[3], alignment: .leading)
            Text(event.lastTimestamp.k8sAge)
                .typeStyle(DesignTokens.Typography.dataSm, color: DesignTokens.textTertiary)
                .frame(width: widths[4], alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, DesignTokens.rowPadDefault)
        .background(warning ? DesignTokens.statusWarn.opacity(0.04) : Color.clear)
        .accessibilityElement(children: .combine)
    }

    private func typePill(_ event: EventInfo, warning: Bool) -> some View {
        Text(EventRowFormat.typeLabel(event))
            .typeStyle(
                DesignTokens.Typography.micro,
                color: warning ? DesignTokens.statusWarn : DesignTokens.textSecondary
            )
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(
                Capsule().fill(
                    warning ? DesignTokens.statusWarn.opacity(0.10) : DesignTokens.surfaceRaised)
            )
    }
}

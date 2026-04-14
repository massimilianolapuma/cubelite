import SwiftUI

/// Full-panel view for browsing application log entries.
///
/// Presents a list/detail layout: the left column shows a filterable list of
/// ``LogEntry`` items; selecting one reveals full details in the right column.
/// Opens with all unread errors automatically marked as read.
struct LogsView: View {

    @Environment(LogStore.self) private var logStore
    @State private var selectedEntryID: UUID?
    @State private var filter: LogFilter = .all

    var body: some View {
        HSplitView {
            logListColumn
            logDetailColumn
        }
        .frame(minWidth: 700, minHeight: 400)
        .onAppear { logStore.markErrorsRead() }
    }

    // MARK: - List column

    private var logListColumn: some View {
        VStack(spacing: 0) {
            logListHeader
            Divider()
            filterRow
            Divider()
            logEntryList
        }
        .frame(minWidth: 420)
    }

    private var logListHeader: some View {
        HStack {
            Text("Logs").font(.headline)
            entryCountBadge
            Spacer()
            Button("Clear") { logStore.clear() }.buttonStyle(.borderless)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var entryCountBadge: some View {
        Text(verbatim: "\(filteredEntries.count)")
            .font(.caption)
            .monospacedDigit()
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.secondary.opacity(0.2), in: Capsule())
    }

    private var filterRow: some View {
        Picker("Filter", selection: $filter) {
            ForEach(LogFilter.allCases) { f in Text(f.label).tag(f) }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .labelsHidden()
    }

    private var logEntryList: some View {
        List(filteredEntries, id: \.id, selection: $selectedEntryID) { entry in
            LogRowView(entry: entry)
        }
        .listStyle(.plain)
    }

    // MARK: - Detail column

    private var logDetailColumn: some View {
        Group {
            if let entry = selectedEntry {
                LogDetailView(entry: entry)
            } else {
                noSelectionPlaceholder
            }
        }
        .frame(minWidth: 260)
    }

    private var noSelectionPlaceholder: some View {
        VStack(spacing: 12) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("Select an entry to view details")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private var selectedEntry: LogEntry? {
        guard let id = selectedEntryID else { return nil }
        return logStore.entries.first { $0.id == id }
    }

    private var filteredEntries: [LogEntry] {
        switch filter {
        case .all:      logStore.entries
        case .errors:   logStore.entries.filter { $0.severity == .error }
        case .warnings: logStore.entries.filter { $0.severity == .warning }
        case .info:     logStore.entries.filter { $0.severity == .info }
        }
    }
}

// MARK: - Filter Options

private enum LogFilter: String, CaseIterable, Identifiable {
    case all, errors, warnings, info
    var id: String { rawValue }

    var label: String {
        switch self {
        case .all:      "All"
        case .errors:   "Errors"
        case .warnings: "Warnings"
        case .info:     "Info"
        }
    }
}

// MARK: - Row View

private struct LogRowView: View {

    let entry: LogEntry

    private static let timestampFormatter: DateFormatter = {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        return fmt
    }()

    var body: some View {
        HStack(spacing: 8) {
            timestampLabel
            SeverityBadgeView(severity: entry.severity)
            sourceLabel
            messageLabel
        }
        .padding(.vertical, 2)
    }

    private var timestampLabel: some View {
        Text(Self.timestampFormatter.string(from: entry.timestamp))
            .font(.caption.monospacedDigit())
            .foregroundStyle(.secondary)
            .frame(width: 54, alignment: .leading)
    }

    private var sourceLabel: some View {
        Text(entry.source)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .frame(width: 60, alignment: .leading)
    }

    private var messageLabel: some View {
        Text(entry.message)
            .lineLimit(1)
            .truncationMode(.tail)
    }
}

// MARK: - Severity Badge

private struct SeverityBadgeView: View {

    let severity: LogSeverity

    var body: some View {
        Text(severity.rawValue)
            .font(.caption2.bold())
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .frame(width: 56)
            .background(badgeColor, in: RoundedRectangle(cornerRadius: 4))
    }

    private var badgeColor: Color {
        switch severity {
        case .error:   .red
        case .warning: .orange
        case .info:    .blue
        }
    }
}

// MARK: - Detail View

private struct LogDetailView: View {

    let entry: LogEntry

    private static let dateFormatter: DateFormatter = {
        let fmt = DateFormatter()
        fmt.dateStyle = .medium
        fmt.timeStyle = .medium
        return fmt
    }()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                detailHeader
                detailBody
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var detailHeader: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                SeverityBadgeView(severity: entry.severity)
                Text(entry.source)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text(entry.message).font(.headline)
            Text(Self.dateFormatter.string(from: entry.timestamp))
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var detailBody: some View {
        if let details = entry.details {
            detailSection(title: "Details", content: details, monospaced: true)
        }
        if let action = entry.suggestedAction {
            suggestedActionSection(action)
        }
    }

    private func detailSection(title: String, content: String, monospaced: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.subheadline.bold())
            Text(content)
                .font(monospaced ? .body.monospaced() : .body)
                .textSelection(.enabled)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
        }
    }

    private func suggestedActionSection(_ action: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Suggested Action", systemImage: "lightbulb")
                .font(.subheadline.bold())
            Text(action).foregroundStyle(.secondary)
        }
    }
}

// MARK: - Preview

#Preview {
    let store = LogStore()
    store.append(LogEntry(severity: .error, source: "KubeAPI", message: "Connection refused", details: "dial tcp: connect: connection refused", suggestedAction: "Check VPN and cluster status."))
    store.append(LogEntry(severity: .warning, source: "TLS", message: "Certificate expires in 7 days"))
    store.append(LogEntry(severity: .info, source: "Config", message: "Loaded kubeconfig from ~/.kube/config"))
    return LogsView()
        .environment(store)
}

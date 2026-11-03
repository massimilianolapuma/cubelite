import SwiftUI

/// Raw · JSON · ECS segmented control of the log panel and the aggregated
/// Logs view (#493; replaces the `{}` JSON toggle of #477).
struct LogViewModePicker: View {
    @Binding var mode: LogViewMode
    let identifier: String

    var body: some View {
        Picker("Log view", selection: $mode) {
            ForEach(LogViewMode.allCases, id: \.self) { mode in
                Text(mode.label).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .fixedSize()
        .help("Log view: raw text, humanised JSON or Elastic Common Schema")
        .accessibilityIdentifier(identifier)
    }
}

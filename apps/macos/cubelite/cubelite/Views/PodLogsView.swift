import SwiftUI

/// Live pod log viewer (Design System v1): follows the pod's log via the
/// streaming API, colors detected severities, supports pause and clear.
struct PodLogsView: View {

    let pod: PodInfo
    let kubeAPIService: KubeAPIService
    let context: String?
    let onClose: () -> Void

    private static let bufferCap = 500

    @State private var lines: [LogLine] = []
    @State private var following = true
    @State private var streamError: String?
    @State private var streamTask: Task<Void, Never>?

    /// One parsed log line.
    struct LogLine: Identifiable {
        let id: Int
        let time: String?
        let level: Level
        let message: String

        enum Level {
            case info, warn, error

            var color: Color {
                switch self {
                case .info: DesignTokens.statusInfo
                case .warn: DesignTokens.statusWarn
                case .error: DesignTokens.statusErr
                }
            }

            var label: String {
                switch self {
                case .info: "INFO"
                case .warn: "WARN"
                case .error: "ERROR"
                }
            }
        }

        /// Splits the kubelet RFC 3339 prefix and detects the severity.
        static func parse(_ raw: String, id: Int) -> LogLine {
            var time: String?
            var message = raw
            if let space = raw.firstIndex(of: " "),
                raw[raw.startIndex..<space].contains("T"),
                raw.hasPrefix("2")
            {
                time = String(raw[raw.startIndex..<space]).components(separatedBy: "T").last
                message = String(raw[raw.index(after: space)...])
            }
            let upper = message.uppercased()
            let level: Level =
                upper.contains("ERROR") || upper.contains("FATAL") || upper.contains("PANIC")
                ? .error
                : upper.contains("WARN") ? .warn : .info
            return LogLine(id: id, time: time, level: level, message: message)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
            content
        }
        .frame(minWidth: 640, minHeight: 420)
        .onAppear { startStream() }
        .onDisappear { streamTask?.cancel() }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("\(pod.name) — logs")
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Button {
                following.toggle()
            } label: {
                Text(following ? "● Following" : "⏸ Paused")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(
                        following ? DesignTokens.statusOk : DesignTokens.statusWarn)
            }
            .buttonStyle(.plain)
            Button("Clear") { lines = [] }
                .controlSize(.small)
            Button("Done", action: onClose)
                .keyboardShortcut(.defaultAction)
                .controlSize(.small)
        }
        .padding(12)
    }

    @ViewBuilder
    private var content: some View {
        if let streamError {
            UnifiedErrorState(title: "Log stream failed", message: streamError)
        } else if lines.isEmpty {
            UnifiedLoadingState(label: "Waiting for log lines…")
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(lines) { line in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(line.time ?? "—")
                                    .font(.system(size: 10.5, design: .monospaced))
                                    .foregroundStyle(DesignTokens.textDisabled)
                                    .frame(width: 90, alignment: .leading)
                                Text(line.level.label)
                                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(line.level.color)
                                    .frame(width: 40, alignment: .leading)
                                Text(line.message)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(DesignTokens.textLog)
                                    .textSelection(.enabled)
                            }
                            .id(line.id)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(DesignTokens.surfaceSunken)
                .onChange(of: lines.count) { _, _ in
                    if following, let last = lines.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private func startStream() {
        streamTask = Task {
            do {
                var nextID = 0
                let stream = try await kubeAPIService.streamPodLogs(
                    namespace: pod.namespace, pod: pod.name, inContext: context)
                for try await raw in stream {
                    let line = LogLine.parse(raw, id: nextID)
                    nextID += 1
                    lines.append(line)
                    if lines.count > Self.bufferCap {
                        lines.removeFirst(lines.count - Self.bufferCap)
                    }
                }
            } catch is CancellationError {
                // Sheet dismissed.
            } catch {
                streamError = error.localizedDescription
            }
        }
    }
}

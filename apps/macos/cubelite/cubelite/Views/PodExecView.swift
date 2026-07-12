import SwiftUI

/// Line-based shell session inside a pod over the Kubernetes exec
/// WebSocket (`v4.channel.k8s.io`, tty disabled): commands are sent one
/// line at a time on the stdin channel; stdout/stderr stream back into a
/// scrollback rendered on the sunken surface.
struct PodExecView: View {

    let pod: PodInfo
    let kubeAPIService: KubeAPIService
    let context: String?
    let onClose: () -> Void

    private static let scrollbackCap = 1000

    @State private var lines: [ExecLine] = []
    @State private var command = ""
    @State private var sessionError: String?
    @State private var webSocket: URLSessionWebSocketTask?
    @FocusState private var inputFocused: Bool

    /// One scrollback entry.
    struct ExecLine: Identifiable {
        enum Kind {
            case input, stdout, stderr, status
        }

        let id: Int
        let kind: Kind
        let text: String

        var color: Color {
            switch kind {
            case .input: DesignTokens.accentDefault
            case .stdout: DesignTokens.textLog
            case .stderr: DesignTokens.statusErr
            case .status: DesignTokens.textTertiary
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
            scrollback
            Rectangle().fill(DesignTokens.borderFaint).frame(height: 1)
            inputRow
        }
        .frame(minWidth: 640, minHeight: 420)
        .onAppear { startSession() }
        .onDisappear { webSocket?.cancel(with: .normalClosure, reason: nil) }
    }

    private var header: some View {
        HStack {
            Text("\(pod.name) — shell")
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Button("Done", action: onClose)
                .keyboardShortcut(.cancelAction)
                .controlSize(.small)
        }
        .padding(12)
    }

    @ViewBuilder
    private var scrollback: some View {
        if let sessionError {
            UnifiedErrorState(title: "Shell session failed", message: sessionError)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(lines) { line in
                            Text(line.text)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(line.color)
                                .textSelection(.enabled)
                                .id(line.id)
                        }
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .background(DesignTokens.surfaceSunken)
                .onChange(of: lines.count) { _, _ in
                    if let last = lines.last {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var inputRow: some View {
        HStack(spacing: 8) {
            Text("$")
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundStyle(DesignTokens.accentDefault)
            TextField("command", text: $command)
                .textFieldStyle(.plain)
                .font(.system(size: 12, design: .monospaced))
                .focused($inputFocused)
                .onSubmit { sendCommand() }
                .disabled(sessionError != nil)
        }
        .padding(10)
    }

    // MARK: - Session

    private func startSession() {
        inputFocused = true
        Task {
            do {
                let ws = try await kubeAPIService.execWebSocket(
                    namespace: pod.namespace, pod: pod.name, inContext: context)
                webSocket = ws
                ws.resume()
                append(.status, "connected — line-based shell (/bin/sh, no TTY)")
                receive(ws)
            } catch {
                sessionError = error.localizedDescription
            }
        }
    }

    private func receive(_ ws: URLSessionWebSocketTask) {
        ws.receive { result in
            Task { @MainActor in
                switch result {
                case .success(.data(var payload)):
                    guard !payload.isEmpty else { return receive(ws) }
                    let channel = payload.removeFirst()
                    let text = String(decoding: payload, as: UTF8.self)
                    for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
                        let line = String(raw)
                        if line.isEmpty { continue }
                        switch channel {
                        case 1: append(.stdout, line)
                        case 2: append(.stderr, line)
                        case 3: append(.status, line)
                        default: break
                        }
                    }
                    receive(ws)
                case .success:
                    receive(ws)
                case .failure:
                    append(.status, "session closed")
                }
            }
        }
    }

    private func sendCommand() {
        guard let ws = webSocket, !command.isEmpty else { return }
        let line = command
        command = ""
        append(.input, "$ \(line)")
        var framed = Data([0])  // channel 0 = stdin
        framed.append(Data((line + "\n").utf8))
        ws.send(.data(framed)) { error in
            if let error {
                Task { @MainActor in
                    sessionError = error.localizedDescription
                }
            }
        }
    }

    private func append(_ kind: ExecLine.Kind, _ text: String) {
        lines.append(ExecLine(id: lines.count, kind: kind, text: text))
        if lines.count > Self.scrollbackCap {
            lines.removeFirst(lines.count - Self.scrollbackCap)
        }
    }
}

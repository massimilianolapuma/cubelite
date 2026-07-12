import Foundation
import Network

/// One active port-forward: a local TCP listener relaying to a pod port
/// through the Kubernetes port-forward WebSocket protocol.
@MainActor
@Observable
final class PortForwardSession: Identifiable {

    enum State: Equatable {
        case starting
        case active
        case failed(String)
    }

    let id = UUID()
    let context: String
    let namespace: String
    let pod: String
    let localPort: UInt16
    let remotePort: Int
    var state: State = .starting

    fileprivate var listener: NWListener?
    fileprivate var relays: [UUID: PortForwardRelay] = [:]

    init(context: String, namespace: String, pod: String, localPort: UInt16, remotePort: Int) {
        self.context = context
        self.namespace = namespace
        self.pod = pod
        self.localPort = localPort
        self.remotePort = remotePort
    }
}

/// Manages the lifecycle of all port-forward sessions.
@MainActor
@Observable
final class PortForwardService {

    private(set) var sessions: [PortForwardSession] = []
    private let kubeAPIService: KubeAPIService

    init(kubeAPIService: KubeAPIService) {
        self.kubeAPIService = kubeAPIService
    }

    /// Starts a listener on `localPort` relaying each accepted connection to
    /// `pod:remotePort` over its own port-forward WebSocket.
    func start(
        context: String, namespace: String, pod: String, localPort: UInt16, remotePort: Int
    ) throws {
        let session = PortForwardSession(
            context: context, namespace: namespace, pod: pod,
            localPort: localPort, remotePort: remotePort)

        guard let port = NWEndpoint.Port(rawValue: localPort) else {
            throw CubeliteError.clientError(reason: "Invalid local port \(localPort)")
        }
        let listener = try NWListener(using: .tcp, on: port)
        session.listener = listener

        listener.stateUpdateHandler = { [weak session] state in
            Task { @MainActor in
                switch state {
                case .ready: session?.state = .active
                case .failed(let error): session?.state = .failed(error.localizedDescription)
                default: break
                }
            }
        }
        listener.newConnectionHandler = { [weak self, weak session] connection in
            Task { @MainActor in
                guard let self, let session else { return }
                await self.attach(connection: connection, to: session)
            }
        }
        listener.start(queue: .main)
        sessions.append(session)
    }

    /// Stops a session: closes the listener and every live relay.
    func stop(_ session: PortForwardSession) {
        session.listener?.cancel()
        for relay in session.relays.values {
            relay.close()
        }
        session.relays.removeAll()
        sessions.removeAll { $0.id == session.id }
    }

    /// Sessions attached to one pod.
    func sessions(namespace: String, pod: String) -> [PortForwardSession] {
        sessions.filter { $0.namespace == namespace && $0.pod == pod }
    }

    private func attach(connection: NWConnection, to session: PortForwardSession) async {
        do {
            let ws = try await kubeAPIService.portForwardWebSocket(
                namespace: session.namespace,
                pod: session.pod,
                remotePort: session.remotePort,
                inContext: session.context
            )
            let relay = PortForwardRelay(connection: connection, webSocket: ws) {
                [weak session] id in
                Task { @MainActor in session?.relays[id] = nil }
            }
            session.relays[relay.id] = relay
            relay.start()
        } catch {
            connection.cancel()
            session.state = .failed(error.localizedDescription)
        }
    }
}

/// Bidirectional relay between one local TCP connection and one
/// port-forward WebSocket (channel 0 = data, channel 1 = error; the first
/// frame of each channel carries a 2-byte little-endian port header).
final class PortForwardRelay: @unchecked Sendable {

    let id = UUID()
    private let connection: NWConnection
    private let webSocket: URLSessionWebSocketTask
    private let onClose: @Sendable (UUID) -> Void
    private var seenHeaderForChannel: Set<UInt8> = []
    private let lock = NSLock()

    init(
        connection: NWConnection,
        webSocket: URLSessionWebSocketTask,
        onClose: @escaping @Sendable (UUID) -> Void
    ) {
        self.connection = connection
        self.webSocket = webSocket
        self.onClose = onClose
    }

    func start() {
        webSocket.resume()
        connection.start(queue: .global(qos: .userInitiated))
        pumpWebSocket()
        pumpLocal()
    }

    func close() {
        webSocket.cancel(with: .normalClosure, reason: nil)
        connection.cancel()
        onClose(id)
    }

    // MARK: - WS → TCP

    private func pumpWebSocket() {
        webSocket.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(.data(var payload)):
                guard !payload.isEmpty else { return self.pumpWebSocket() }
                let channel = payload.removeFirst()
                let isFirst: Bool = {
                    self.lock.lock()
                    defer { self.lock.unlock() }
                    return self.seenHeaderForChannel.insert(channel).inserted
                }()
                // The first frame per channel is the 2-byte port header.
                if isFirst {
                    payload = payload.dropFirst(2)
                }
                if channel == 0, !payload.isEmpty {
                    self.connection.send(
                        content: payload,
                        completion: .contentProcessed { _ in
                            // Best-effort relay: a failed local write surfaces
                            // as the connection closing, handled by pumpLocal.
                        })
                }
                self.pumpWebSocket()
            case .success(.string):
                self.pumpWebSocket()
            case .success:
                self.pumpWebSocket()
            case .failure:
                self.close()
            }
        }
    }

    // MARK: - TCP → WS

    private func pumpLocal() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                var framed = Data([0])  // channel 0 = data
                framed.append(data)
                self.webSocket.send(.data(framed)) { [weak self] sendError in
                    if sendError != nil {
                        self?.close()
                    }
                }
            }
            if isComplete || error != nil {
                self.close()
            } else {
                self.pumpLocal()
            }
        }
    }
}

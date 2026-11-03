import Foundation
import Network

/// A loopback-only port-forward for one integration connection (#502, #511):
/// an ephemeral `127.0.0.1` listener whose connections are each relayed to
/// `pod:remotePort` over their own port-forward WebSocket. Closed with the
/// connection that owns it.
final class IntegrationTunnel: @unchecked Sendable {

    typealias OpenSocket = @Sendable () async throws -> URLSessionWebSocketTask

    private let listener: NWListener
    private let openSocket: OpenSocket
    private let queue = DispatchQueue(label: "it.lapuma.cubelite.integration-tunnel")
    private let lock = NSLock()
    private var relays: [UUID: PortForwardRelay] = [:]
    private var readiness: CheckedContinuation<UInt16, Error>?
    private var closed = false

    private init(listener: NWListener, openSocket: @escaping OpenSocket) {
        self.listener = listener
        self.openSocket = openSocket
    }

    /// Opens the listener and returns once it has a port.
    static func open(openSocket: @escaping OpenSocket) async throws -> (IntegrationTunnel, UInt16) {
        let parameters = NWParameters.tcp
        // Loopback only: nothing else on the network may use the tunnel.
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener: NWListener
        do {
            listener = try NWListener(using: parameters)
        } catch {
            throw IntegrationFailure.connect("cannot open a local port: \(error.localizedDescription)")
        }
        let tunnel = IntegrationTunnel(listener: listener, openSocket: openSocket)
        let port = try await tunnel.start()
        return (tunnel, port)
    }

    private func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock { readiness = continuation }
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    if let port = self.listener.port?.rawValue, port > 0 {
                        self.resolveReadiness(.success(port))
                    } else {
                        self.resolveReadiness(.failure(IntegrationFailure.connect("no local port")))
                    }
                case .waiting(let error), .failed(let error):
                    self.resolveReadiness(
                        .failure(IntegrationFailure.connect("local port failed: \(error.localizedDescription)")))
                case .cancelled:
                    self.resolveReadiness(.failure(IntegrationFailure.connect("local port closed")))
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.attach(connection)
            }
            listener.start(queue: queue)
        }
    }

    private func resolveReadiness(_ result: Result<UInt16, Error>) {
        let continuation = lock.withLock {
            defer { readiness = nil }
            return readiness
        }
        continuation?.resume(with: result)
    }

    private func attach(_ connection: NWConnection) {
        Task { [weak self] in
            guard let self else {
                connection.cancel()
                return
            }
            do {
                let socket = try await self.openSocket()
                let relay = PortForwardRelay(connection: connection, webSocket: socket) {
                    [weak self] id in
                    self?.lock.withLock { _ = self?.relays.removeValue(forKey: id) }
                }
                let accepted = self.lock.withLock {
                    guard !self.closed else { return false }
                    self.relays[relay.id] = relay
                    return true
                }
                if accepted {
                    relay.start()
                } else {
                    socket.cancel(with: .goingAway, reason: nil)
                    connection.cancel()
                }
            } catch {
                connection.cancel()
            }
        }
    }

    /// Stops listening and closes every relay.
    func close() {
        let open = lock.withLock {
            closed = true
            defer { relays.removeAll() }
            return Array(relays.values)
        }
        listener.cancel()
        for relay in open {
            relay.close()
        }
    }

    deinit {
        close()
    }
}

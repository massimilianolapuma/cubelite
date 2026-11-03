import XCTest

@testable import cubelite

// MARK: - Stubs

/// Canned HTTP responses for integration sessions, recorded per test.
final class IntegrationStubProtocol: URLProtocol, @unchecked Sendable {
    struct Recorded: Sendable {
        let method: String
        let url: String
        let authorization: String?
        let body: String
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var responses: [String: (Int, String)] = [:]
    nonisolated(unsafe) private static var recorded: [Recorded] = []
    nonisolated(unsafe) private static var handler: (@Sendable (URLRequest) -> (Int, String)?)?

    /// Responses keyed by URL path (query ignored).
    /// `handle` answers first when it returns a response (per-query replies).
    static func reset(
        _ map: [String: (Int, String)],
        handle: (@Sendable (URLRequest) -> (Int, String)?)? = nil
    ) {
        lock.withLock {
            responses = map
            recorded = []
            handler = handle
        }
    }

    static var requests: [Recorded] { lock.withLock { recorded } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                body.append(buffer, count: n)
            }
            stream.close()
        }
        let url = request.url
        let path = url?.path ?? ""
        let (status, text) = Self.lock.withLock { () -> (Int, String) in
            Self.recorded.append(
                Recorded(
                    method: request.httpMethod ?? "GET", url: url?.absoluteString ?? "",
                    authorization: request.value(forHTTPHeaderField: "Authorization"),
                    body: String(decoding: body, as: UTF8.self)))
            return Self.handler?(request) ?? Self.responses[path] ?? (404, "")
        }
        guard let url, let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)
        else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(text.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

actor MemorySecrets: IntegrationSecretStore {
    var items: [String: Data] = [:]

    func read(account: String) async throws -> Data? { items[account] }
    func write(_ data: Data, account: String) async throws { items[account] = data }
    func delete(account: String) async throws { items[account] = nil }
}

struct StubCluster: IntegrationClusterAccess {
    let objects: [String: String]
    /// `rawGet` replies (service proxy) by path prefix match; else `objects`.
    var proxy: [String: (Int, String)] = [:]

    func getIfPresent(path: String, inContext contextName: String?) async throws -> Data? {
        objects[path].map { Data($0.utf8) }
    }

    func portForwardWebSocket(
        namespace: String, pod: String, remotePort: Int, inContext contextName: String?
    ) async throws -> URLSessionWebSocketTask {
        throw ElasticError.connect("no port-forward in tests")
    }

    func rawGet(path: String, inContext contextName: String?) async throws -> (
        status: Int, body: Data
    ) {
        if let reply = proxy.first(where: { path.hasPrefix($0.key) })?.value {
            return (reply.0, Data(reply.1.utf8))
        }
        return objects[path].map { (200, Data($0.utf8)) } ?? (404, Data())
    }
}


/// A cluster whose objects can change during a test (pod replaced).
final class MutableCluster: IntegrationClusterAccess, @unchecked Sendable {
    private let lock = NSLock()
    private var objects: [String: String]

    init(_ objects: [String: String]) { self.objects = objects }

    func set(_ path: String, _ json: String?) { lock.withLock { objects[path] = json } }

    func getIfPresent(path: String, inContext contextName: String?) async throws -> Data? {
        lock.withLock { objects[path] }.map { Data($0.utf8) }
    }

    func portForwardWebSocket(
        namespace: String, pod: String, remotePort: Int, inContext contextName: String?
    ) async throws -> URLSessionWebSocketTask {
        throw ElasticError.connect("no port-forward in tests")
    }

    func rawGet(path: String, inContext contextName: String?) async throws -> (status: Int, body: Data) {
        (404, Data())
    }
}

/// The in-cluster web UI forward checks shared by Kibana (#519) and
/// Grafana (#525): one forward per context and service, shared by
/// concurrent opens, reused while its pod is ready, moved to the new pod
/// after a rollout, closed by a disconnect.
enum ForwardScenario {

    static func pod(_ name: String) -> String {
        #"{"metadata":{"name":"\#(name)"},"status":{"phase":"Running","conditions":[{"type":"Ready","status":"True"}]}}"#
    }

    /// `service` selecting `app=ui`, with one ready pod `<service>-1`.
    static func cluster(_ service: ServiceRef) -> MutableCluster {
        let base = "/api/v1/namespaces/\(service.namespace)"
        let scheme = service.https ? "https" : "http"
        return MutableCluster([
            "\(base)/services/\(service.service)":
                #"{"metadata":{"name":"\#(service.service)"},"spec":{"selector":{"app":"ui"},"ports":[{"name":"\#(scheme)","port":\#(service.port)}]}}"#,
            "\(base)/pods?labelSelector=app%3Dui": #"{"items":[\#(pod("\(service.service)-1"))]}"#,
            "\(base)/pods/\(service.service)-1": pod("\(service.service)-1"),
        ])
    }

    static func run(
        cluster: MutableCluster, service: ServiceRef,
        forward: @escaping @Sendable () async throws -> UInt16,
        pod current: @Sendable () async -> String?,
        disconnect: @Sendable () async -> Void,
        file: StaticString = #filePath, line: UInt = #line
    ) async throws {
        async let a = forward()
        async let b = forward()
        let (first, second) = try await (a, b)
        XCTAssertGreaterThan(first, 0, file: file, line: line)
        XCTAssertEqual(first, second, "a double click shares one forward", file: file, line: line)
        let reused = try await forward()
        XCTAssertEqual(reused, first, "reused while the pod is ready", file: file, line: line)

        // A rollout replaced the pod: the next open forwards to the new one.
        let base = "/api/v1/namespaces/\(service.namespace)"
        let old = "\(service.service)-1"
        let new = "\(service.service)-2"
        cluster.set("\(base)/pods/\(old)", nil)
        cluster.set("\(base)/pods?labelSelector=app%3Dui", #"{"items":[\#(pod(new))]}"#)
        cluster.set("\(base)/pods/\(new)", pod(new))
        let before = await current()
        XCTAssertEqual(before, old, file: file, line: line)
        _ = try await forward()
        let after = await current()
        XCTAssertEqual(after, new, "forwards to the new pod", file: file, line: line)
        await disconnect()
        let closed = await current()
        XCTAssertNil(closed, "disconnect closes the forward", file: file, line: line)
        _ = try await forward()
        let reopened = await current()
        XCTAssertEqual(reopened, new, file: file, line: line)
    }
}

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


import Foundation

// Pieces shared by the HTTP integrations (Elasticsearch #502, Prometheus
// #511), mirroring `crates/cubelite-core/src/integration.rs`: where an
// endpoint lives, what stored credentials are bound to, the rules for
// external URLs and headers, and safe kube API path segments.

/// Where an integration's HTTP API lives (Elasticsearch, Prometheus).
enum IntegrationTarget: Hashable, Sendable {
    /// A service in the cluster, reached through a port-forward.
    case inCluster(namespace: String, service: String, port: Int, https: Bool)
    /// An external deployment (`https://…:9243`), base URL without a path.
    case external(url: String)
}

extension IntegrationTarget: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, namespace, service, port, https, url
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "in-cluster":
            self = .inCluster(
                namespace: try c.decode(String.self, forKey: .namespace),
                service: try c.decode(String.self, forKey: .service),
                port: try c.decode(Int.self, forKey: .port),
                https: try c.decode(Bool.self, forKey: .https))
        case "external":
            self = .external(url: try c.decode(String.self, forKey: .url))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c, debugDescription: "Unknown target kind \(other)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .inCluster(let namespace, let service, let port, let https):
            try c.encode("in-cluster", forKey: .kind)
            try c.encode(namespace, forKey: .namespace)
            try c.encode(service, forKey: .service)
            try c.encode(port, forKey: .port)
            try c.encode(https, forKey: .https)
        case .external(let url):
            try c.encode("external", forKey: .kind)
            try c.encode(url, forKey: .url)
        }
    }
}

/// A web UI service in the cluster picked from Detect (Kibana #519, Grafana
/// #525), opened through a port-forward when there is no URL. Same JSON as
/// the desktop's `ServiceRef`.
struct ServiceRef: Codable, Hashable, Sendable {
    let namespace: String
    let service: String
    let port: Int
    let https: Bool

    /// `http(s)://127.0.0.1:<port>`: a forward to it listens on IPv4 loopback.
    func loopbackBase(port local: UInt16) -> String {
        "\(https ? "https" : "http")://127.0.0.1:\(local)"
    }
}

/// Why a shared integration helper refused; each integration reports it
/// with its own wording (`ElasticError`, `PromError`).
enum IntegrationFailure: Error, Equatable {
    case config(String)
    case connect(String)
}

enum Integration {

    /// What stored credentials are bound to: the external origin (scheme,
    /// host, port) or the in-cluster service, plus the TLS setting. Same
    /// strings as the desktop.
    static func binding(_ target: IntegrationTarget, skipTLSVerify: Bool) throws -> String {
        let origin: String
        switch target {
        case .external(let url):
            origin = try self.origin(of: url)
        case .inCluster(let namespace, let service, let port, let https):
            try checkNames(namespace: namespace, service: service)
            origin = "in-cluster:\(namespace)/\(service):\(port):\(https ? "https" : "http")"
        }
        return skipTLSVerify ? origin + "|insecure" : origin
    }

    /// Checks an external URL: http(s), a host, no credentials in it, and
    /// credentials only over https (or plain http to loopback, which never
    /// leaves the host). Returns the base URL without query, fragment or a
    /// trailing slash (paths are appended to it).
    static func checkExternalURL(_ url: String, sendsCredentials: Bool) throws -> URL {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: trimmed), let scheme = parts.scheme?.lowercased(),
            ["http", "https"].contains(scheme), let host = parts.host, !host.isEmpty
        else {
            throw IntegrationFailure.config("Invalid URL: use http:// or https://")
        }
        if parts.user != nil || parts.password != nil {
            throw IntegrationFailure.config(
                "Put credentials in the authentication fields, not in the URL")
        }
        if scheme == "http", sendsCredentials, !isLoopback(host) {
            throw IntegrationFailure.config("Credentials are only sent over https://")
        }
        parts.query = nil
        parts.fragment = nil
        // Trim the encoded path so an escaped `%2F` in a prefix survives.
        while parts.percentEncodedPath.hasSuffix("/") { parts.percentEncodedPath.removeLast() }
        guard let result = parts.url else {
            throw IntegrationFailure.config("Invalid URL: use http:// or https://")
        }
        return result
    }

    /// `header`, refusing control characters and non-ASCII text that cannot
    /// travel in an HTTP header.
    static func checkedHeader(_ header: String?) throws -> String? {
        guard let header else { return nil }
        guard header.unicodeScalars.allSatisfy({ $0.isASCII && $0.value >= 0x20 && $0.value != 0x7F })
        else {
            throw IntegrationFailure.config("Credentials contain invalid characters")
        }
        return header
    }

    /// `{service}.{namespace}.svc`: the in-cluster DNS name (and the name
    /// ECK puts in its HTTP certificate).
    static func serviceHost(namespace: String, service: String) -> String {
        "\(service).\(namespace).svc"
    }

    /// First PEM certificate of a bundle as DER (ECK's `ca.crt`).
    static func firstPEMCertificate(_ pem: Data) -> Data? {
        guard let text = String(data: pem, encoding: .utf8),
            let begin = text.range(of: "-----BEGIN CERTIFICATE-----"),
            let end = text.range(of: "-----END CERTIFICATE-----", range: begin.upperBound..<text.endIndex)
        else { return nil }
        let body = text[begin.upperBound..<end.lowerBound].filter { !$0.isWhitespace }
        return Data(base64Encoded: String(body))
    }

    /// A DNS-1123 label (namespace and service names).
    static func isDNSLabel(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 63
            && name.allSatisfy { ($0.isASCII && ($0.isLowercase || $0.isNumber)) || $0 == "-" }
            && !name.hasPrefix("-") && !name.hasSuffix("-")
    }

    /// In-cluster names must be DNS labels: it also keeps them out of other
    /// API server paths (`/`, `..`).
    static func checkNames(namespace: String, service: String) throws {
        for (what, name) in [("namespace", namespace), ("service", service)] where !isDNSLabel(name) {
            throw IntegrationFailure.config("Invalid \(what) name \"\(name)\"")
        }
    }

    /// One percent-encoded path segment; `.`/`..` and empty names are refused
    /// (they would be normalised into another API path).
    static func pathSegment(_ text: String) throws -> String {
        guard !text.isEmpty, text != ".", text != ".." else {
            throw IntegrationFailure.config("Invalid name \"\(text)\"")
        }
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? text
    }

    /// Percent-encodes everything outside the URL-safe unreserved set.
    static func percentEncode(_ s: String) -> String {
        var out = ""
        for byte in s.utf8 {
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
                UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "."),
                UInt8(ascii: "_"), UInt8(ascii: "~"):
                out.append(Character(Unicode.Scalar(byte)))
            default:
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    /// `scheme://host[:port]`, lower-cased, default ports omitted (like the
    /// WHATWG origin the desktop uses).
    static func origin(of url: String) throws -> String {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed), let scheme = parts.scheme?.lowercased(),
            let host = parts.host?.lowercased(), !host.isEmpty
        else {
            throw IntegrationFailure.config("Invalid URL \"\(url)\"")
        }
        let hostText = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
        let defaultPort = scheme == "https" ? 443 : scheme == "http" ? 80 : nil
        if let port = parts.port, port != defaultPort {
            return "\(scheme)://\(hostText):\(port)"
        }
        return "\(scheme)://\(hostText)"
    }

    static func isLoopback(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h == "localhost" || h == "::1" { return true }
        let octets = h.split(separator: ".")
        return octets.count == 4 && octets.first == "127" && octets.allSatisfy { UInt8($0) != nil }
    }
}

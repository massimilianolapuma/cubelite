import Foundation

/// Log view modes of the log panel and the aggregated Logs view (#493).
enum LogViewMode: String, CaseIterable, Sendable {
    case raw, json, ecs

    var label: String {
        switch self {
        case .raw: "Raw"
        case .json: "JSON"
        case .ecs: "ECS"
        }
    }

    /// Stored mode, else the pre-#493 `jsonView` boolean, else raw.
    static func stored(in defaults: UserDefaults, key: String, legacyKey: String) -> LogViewMode {
        if let raw = defaults.string(forKey: key), let mode = LogViewMode(rawValue: raw) {
            return mode
        }
        return defaults.bool(forKey: legacyKey) ? .json : .raw
    }
}

/// One flattened ECS field (`log.level`).
struct ECSField: Equatable, Sendable {
    let key: String
    let value: JSONValue
    /// Added by the conversion (kubelet time, detected level, metadata,
    /// `ecs.version`), not present in the line.
    let added: Bool
}

/// The Elastic Common Schema document a log line becomes (#493; same rules as
/// the desktop `log-ecs.ts`, spec
/// `docs/superpowers/specs/2026-11-03-ecs-log-view-design.md` §4).
struct ECSDocument: Equatable, Sendable {

    static let ecsVersion = "8.11.0"

    /// ECS-first order: `@timestamp`, `log.level`, `message`, then the line's
    /// order, then added fields.
    let fields: [ECSField]
    /// Badge level: `log.level` mapped, else the detected level.
    let level: LogLine.Level

    /// Kubernetes metadata CubeLite knows for a line.
    struct Metadata: Equatable, Sendable {
        let namespace: String
        let pod: String
        var container: String?
    }

    private struct Alias: Sendable {
        let target: String
        let candidates: [String]
        let accept: @Sendable (JSONValue) -> Bool
        var convert: (@Sendable (JSONValue) -> JSONValue)?
    }

    private static func isString(_ v: JSONValue) -> Bool {
        if case .string = v { return true }
        return false
    }

    private static func isISO8601(_ v: JSONValue) -> Bool {
        guard case .string(let s) = v else { return false }
        return s.prefixMatch(of: /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/) != nil
    }

    /// Lowercased level name; pino numbers mapped to their names.
    private static func levelName(_ v: JSONValue) -> JSONValue {
        let number: Double?
        switch v {
        case .number(let text): number = Double(text)
        case .string(let s):
            let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, trimmed.allSatisfy({ $0.isASCII && $0.isNumber }) {
                number = Double(trimmed)
            } else {
                return .string(trimmed.lowercased())
            }
        default: return v
        }
        guard let n = number else { return v }
        let names: [(Double, String)] = [
            (20, "trace"), (30, "debug"), (40, "info"), (50, "warn"), (60, "error"),
        ]
        return .string(names.first { n < $0.0 }?.1 ?? "fatal")
    }

    private static let aliases: [Alias] = [
        Alias(target: "@timestamp", candidates: ["timestamp", "time", "ts", "t"], accept: isISO8601),
        Alias(
            target: "log.level", candidates: ["level", "severity", "lvl"],
            accept: { JSONLogView.mapLevel($0) != nil }, convert: levelName),
        Alias(target: "message", candidates: ["msg", "event"], accept: isString),
        Alias(
            target: "log.logger", candidates: ["logger", "logger_name", "loggername", "name"],
            accept: isString),
        Alias(target: "error.message", candidates: ["error", "err", "err.message"], accept: isString),
        Alias(
            target: "error.stack_trace",
            candidates: ["stack", "stacktrace", "stack_trace", "error.stack", "err.stack"],
            accept: isString),
        Alias(target: "trace.id", candidates: ["trace_id", "traceid"], accept: isString),
        Alias(target: "span.id", candidates: ["span_id", "spanid"], accept: isString),
        Alias(
            target: "service.name", candidates: ["service", "service_name", "servicename"],
            accept: isString),
    ]

    /// Flattens nested objects to dotted keys, in source order. When a
    /// literal dotted key and a nested path collide, the nested value wins
    /// and the literal one moves to `<key>_`.
    static func flatten(_ members: [JSONMember]) -> [(key: String, value: JSONValue)] {
        var out: [(key: String, value: JSONValue)] = []
        var index: [String: Int] = [:]
        var nested = Set<String>()
        func set(_ key: String, _ value: JSONValue) {
            if let i = index[key] {
                out[i].value = value
            } else {
                index[key] = out.count
                out.append((key, value))
            }
        }
        func put(_ key: String, _ value: JSONValue, fromNesting: Bool) {
            if let i = index[key] {
                if fromNesting && !nested.contains(key) {
                    set(key + "_", out[i].value)
                } else {
                    set(key + "_", value)
                    return
                }
            }
            set(key, value)
            if fromNesting { nested.insert(key) }
        }
        func walk(_ members: [JSONMember], prefix: String) {
            for member in members {
                let key = prefix.isEmpty ? member.key : prefix + "." + member.key
                if case .object(let children) = member.value, !children.isEmpty {
                    walk(children, prefix: key)
                } else {
                    put(key, member.value, fromNesting: !prefix.isEmpty)
                }
            }
        }
        walk(members, prefix: "")
        return out
    }

    private static func applyAliases(_ input: [(key: String, value: JSONValue)])
        -> [(key: String, value: JSONValue)]
    {
        var fields = input
        for alias in aliases where !fields.contains(where: { $0.key == alias.target }) {
            for candidate in alias.candidates {
                guard
                    let i = fields.firstIndex(where: {
                        $0.key.lowercased() == candidate && alias.accept($0.value)
                    })
                else { continue }
                let value = fields[i].value
                fields[i] = (alias.target, alias.convert?(value) ?? value)
                break
            }
        }
        return fields
    }

    private static let leading = ["@timestamp", "log.level", "message"]

    /// Converts one line (spec §4): JSON objects are flattened and, unless
    /// they carry `ecs.version`, common aliases renamed; plain text becomes
    /// `message`. Missing `@timestamp` / `log.level` come from the kubelet
    /// timestamp and the detected level; metadata and `ecs.version` are added
    /// when absent.
    static func make(line: LogLine, metadata: Metadata) -> ECSDocument {
        var own: [(key: String, value: JSONValue)]
        if JSONLogView.parse(line.structuredText) != nil,
            case .object(let members)? = JSONValue.parse(
                line.structuredText.trimmingCharacters(in: CharacterSet(charactersIn: "\u{FEFF}"))
                    .trimmingCharacters(in: .whitespacesAndNewlines))
        {
            own = flatten(members)
            if !own.contains(where: { $0.key == "ecs.version" }) { own = applyAliases(own) }
        } else {
            own = [("message", .string(line.message))]
        }

        var added: [(String, JSONValue)] = []
        func fill(_ key: String, _ value: String?) {
            guard let value, !value.isEmpty, !own.contains(where: { $0.key == key }) else { return }
            added.append((key, .string(value)))
        }
        fill("@timestamp", line.timestamp)
        fill("log.level", levelText(line.level))
        fill("kubernetes.namespace", metadata.namespace)
        fill("kubernetes.pod.name", metadata.pod)
        fill("container.name", metadata.container ?? line.container)
        fill("ecs.version", ecsVersion)

        let all =
            own.map { ECSField(key: $0.key, value: $0.value, added: false) }
            + added.map { ECSField(key: $0.0, value: $0.1, added: true) }
        let first = leading.compactMap { key in all.first { $0.key == key } }
        let fields = first + all.filter { !leading.contains($0.key) }
        let level =
            fields.first { $0.key == "log.level" }.flatMap { JSONLogView.mapLevel($0.value) }
            ?? line.level
        return ECSDocument(fields: fields, level: level)
    }

    private static func levelText(_ level: LogLine.Level) -> String {
        switch level {
        case .debug: "debug"
        case .info: "info"
        case .warn: "warn"
        case .error: "error"
        }
    }

    // MARK: - Nested output

    /// Nested form (`{"log":{"level":…}}`), what Elasticsearch stores.
    var nested: JSONValue {
        var root = OrderedObject()
        for field in fields {
            let parts = field.key.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
            if parts.contains(where: \.isEmpty) {
                root.setLeaf(field.key, field.value)
            } else {
                if !root.insert(path: parts[...], value: field.value) {
                    // An object already sits at this slot (`service.name` before
                    // `service`): keep the key dotted at the root, or suffixed
                    // like a flatten collision when it has no dots.
                    root.setLeaf(parts.count > 1 ? field.key : field.key + "_", field.value)
                }
            }
        }
        return root.json
    }

    var compactJSON: String { nested.compactText }
    var prettyJSON: String { nested.prettyText }

    /// NDJSON export: one compact nested document per line, newline-terminated.
    static func ndjson(_ lines: [LogLine], metadata: (LogLine) -> Metadata) -> String {
        lines.map { make(line: $0, metadata: metadata($0)).compactJSON + "\n" }.joined()
    }

    // MARK: - Rendering

    struct Row: Equatable, Sendable {
        let message: String
        let service: String?
        let tail: [JSONLogView.TailField]
    }

    private static let tailHidden: Set<String> = [
        "@timestamp", "log.level", "message", "service.name", "ecs.version",
        "kubernetes.namespace", "kubernetes.pod.name", "container.name",
    ]
    private static let tailFirst = ["error.message", "error.type", "trace.id"]

    /// Collapsed-row summary (spec §5.1).
    var row: Row {
        func string(_ key: String) -> String? {
            if case .string(let s)? = fields.first(where: { $0.key == key })?.value { return s }
            return nil
        }
        let visible = fields.filter { !Self.tailHidden.contains($0.key) }
        var text = string("message")
        var rest = visible
        if text == nil, let first = visible.first(where: { Self.isString($0.value) }),
            case .string(let s) = first.value
        {
            text = s
            rest = visible.filter { $0.key != first.key }
        }
        let ordered =
            Self.tailFirst.compactMap { key in rest.first { $0.key == key } }
            + rest.filter { !Self.tailFirst.contains($0.key) }
        return Row(
            message: JSONLogView.displayText(text ?? ""),
            service: string("service.name"),
            tail: ordered.map {
                JSONLogView.TailField(
                    key: $0.key,
                    value: JSONLogView.displayText(JSONLogView.compactValue($0.value)))
            })
    }

    /// Field-table rows, Kibana order (by name; `@timestamp` sorts first).
    var table: [ECSField] {
        fields.sorted {
            if ($0.key == "@timestamp") != ($1.key == "@timestamp") { return $0.key == "@timestamp" }
            return $0.key.unicodeScalars.lexicographicallyPrecedes($1.key.unicodeScalars)
        }
    }
}

/// Insertion-ordered JSON object builder for `ECSDocument.nested`.
private struct OrderedObject {
    private var keys: [String] = []
    private var values: [String: Node] = [:]

    private indirect enum Node {
        case leaf(JSONValue)
        case object(OrderedObject)
    }

    /// Sets `key` (taken literally, dots included) to a scalar or container value.
    mutating func setLeaf(_ key: String, _ value: JSONValue) {
        if values[key] == nil { keys.append(key) }
        values[key] = .leaf(value)
    }

    /// Places `value` at `path`; when a scalar already sits on the path the
    /// rest of the key stays dotted at that level. Returns false, placing
    /// nothing, when an object already occupies the final slot.
    mutating func insert(path: ArraySlice<String>, value: JSONValue) -> Bool {
        guard let head = path.first else { return true }
        let rest = path.dropFirst()
        if rest.isEmpty {
            if case .object? = values[head] { return false }
            setLeaf(head, value)
            return true
        }
        switch values[head] {
        case nil:
            var child = OrderedObject()
            let placed = child.insert(path: rest, value: value)
            keys.append(head)
            values[head] = .object(child)
            return placed
        case .object(var child)?:
            let placed = child.insert(path: rest, value: value)
            values[head] = .object(child)
            return placed
        case .leaf?:
            setLeaf(path.joined(separator: "."), value)
            return true
        }
    }

    var json: JSONValue {
        .object(
            keys.compactMap { key in
                switch values[key] {
                case .leaf(let v)?: JSONMember(key: key, value: v)
                case .object(let o)?: JSONMember(key: key, value: o.json)
                case nil: nil
                }
            })
    }
}

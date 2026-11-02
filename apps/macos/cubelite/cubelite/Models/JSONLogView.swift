import Foundation

/// A log line whose message is a JSON object, humanised for the JSON view
/// (#477; same rules as the desktop `log-json.ts`, spec
/// `docs/superpowers/specs/2026-10-28-desktop-json-log-view-design.md` §3.2).
struct JSONLogView: Equatable, Sendable {

    /// One remaining top-level field shown after the message.
    struct TailField: Equatable, Sendable {
        let key: String
        /// Display text: scalars as literals, containers compacted to 60
        /// characters, control characters flattened.
        let value: String
    }

    /// The parsed root object (always `.object`).
    let object: JSONValue
    /// Raw value of the recognised time field (kept out of the tail).
    let time: String?
    /// Level from the JSON, or nil so the caller keeps the detected level.
    let level: LogLine.Level?
    /// Recognised message, else first remaining string, else compact JSON.
    let message: String
    /// Remaining top-level fields in source order.
    let tail: [TailField]

    static let timeKeys = ["@timestamp", "timestamp", "time", "ts", "t"]
    static let levelKeys = ["level", "severity", "lvl"]
    static let messageKeys = ["message", "msg", "event"]

    private static let levelNames: [String: LogLine.Level] = [
        "trace": .debug, "debug": .debug, "verbose": .debug,
        "info": .info, "notice": .info,
        "warn": .warn, "warning": .warn,
        "error": .error, "err": .error, "fatal": .error, "critical": .error, "crit": .error,
        "alert": .error, "emerg": .error, "emergency": .error, "panic": .error, "dpanic": .error,
    ]

    /// Humanises `message` when it is exactly one JSON object (after a BOM
    /// and surrounding whitespace); nil for anything else.
    static func parse(_ message: String) -> JSONLogView? {
        var text = Substring(message)
        if text.first == "\u{FEFF}" { text = text.dropFirst() }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"), trimmed.hasSuffix("}"),
            let root = JSONValue.parse(trimmed), case .object(let members) = root
        else { return nil }

        var consumed = Set<String>()

        let timeKey = findKey(in: members, candidates: timeKeys) {
            if case .string = $0 { return true }
            if case .number = $0 { return true }
            return false
        }
        let time = timeKey.flatMap { key in members.first { $0.key == key } }.map {
            scalarText($0.value)
        }
        if let timeKey { consumed.insert(timeKey) }

        var level: LogLine.Level?
        if let levelKey = findKey(in: members, candidates: levelKeys, accept: { mapLevel($0) != nil }) {
            level = members.first { $0.key == levelKey }.flatMap { mapLevel($0.value) }
            consumed.insert(levelKey)
        } else {
            if case .object(let log)? = members.first(where: { $0.key == "log" })?.value,
                let nested = log.first(where: { $0.key == "level" })
            {
                level = mapLevel(nested.value)
            }
            if level == nil, let dotted = members.first(where: { $0.key == "log.level" }) {
                level = mapLevel(dotted.value)
                if level != nil { consumed.insert("log.level") }
            }
        }

        let messageKey = findKey(in: members, candidates: messageKeys) {
            if case .string = $0 { return true }
            return false
        }
        let messageText: String
        var compactFallback = false
        if let messageKey, case .string(let s)? = members.first(where: { $0.key == messageKey })?.value {
            messageText = s
            consumed.insert(messageKey)
        } else if let first = members.first(where: {
            if case .string = $0.value { return !consumed.contains($0.key) }
            return false
        }), case .string(let s) = first.value {
            messageText = s
            consumed.insert(first.key)
        } else {
            messageText = root.compactText
            compactFallback = true
        }

        let tail =
            compactFallback
            ? []
            : members.filter { !consumed.contains($0.key) }.map {
                TailField(key: $0.key, value: displayText(compactValue($0.value)))
            }
        return JSONLogView(
            object: root, time: time, level: level, message: displayText(messageText), tail: tail)
    }

    /// Maps a level name (any case, trimmed) or a pino/bunyan number to a
    /// log level; nil when unrecognised.
    static func mapLevel(_ raw: JSONValue) -> LogLine.Level? {
        let number: Double
        switch raw {
        case .string(let s):
            let name = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !name.isEmpty else { return nil }
            guard name.allSatisfy(\.isASCIIDigit), let n = Double(name) else {
                return levelNames[name]
            }
            number = n
        case .number(let text):
            guard let n = Double(text), n.isFinite else { return nil }
            number = n
        default:
            return nil
        }
        switch number {
        case ..<30: return .debug
        case ..<40: return .info
        case ..<50: return .warn
        default: return .error
        }
    }

    /// Scalars as literals (strings unquoted); containers as compact JSON cut
    /// to `max` characters with `…`.
    static func compactValue(_ value: JSONValue, max: Int = 60) -> String {
        switch value {
        case .array, .object:
            let json = value.compactText
            return json.count > max ? String(json.prefix(max)) + "…" : json
        default:
            return scalarText(value)
        }
    }

    /// One-line form for the collapsed row: newlines become "↵ ", tabs and
    /// other C0 control characters a space.
    static func displayText(_ s: String) -> String {
        let flattened = s.replacingOccurrences(of: "\r\n", with: "↵ ")
            .replacingOccurrences(of: "\n", with: "↵ ")
        var out = String.UnicodeScalarView()
        for scalar in flattened.unicodeScalars {
            out.append(scalar.value < 0x20 ? " " : scalar)
        }
        return String(out)
    }

    private static func scalarText(_ value: JSONValue) -> String {
        switch value {
        case .string(let s): s
        case .number(let n): n
        case .bool(let b): b ? "true" : "false"
        case .null: "null"
        case .array, .object: value.compactText
        }
    }

    /// First key matching a candidate (candidate order wins, case-insensitive)
    /// whose value passes `accept`.
    private static func findKey(
        in members: [JSONMember], candidates: [String], accept: (JSONValue) -> Bool
    ) -> String? {
        for candidate in candidates {
            if let member = members.first(where: {
                $0.key.lowercased() == candidate && accept($0.value)
            }) {
                return member.key
            }
        }
        return nil
    }
}

extension Character {
    fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}

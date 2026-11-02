import Foundation

/// One key/value pair of a JSON object, in source order.
struct JSONMember: Equatable, Sendable {
    let key: String
    let value: JSONValue
}

/// A parsed JSON document that keeps what `JSONSerialization` loses for log
/// display: object key order, and numbers as their source text (integers
/// beyond 2^53 stay exact, cf. desktop #455).
indirect enum JSONValue: Equatable, Sendable {
    case string(String)
    /// Source text of a JSON number, already validated against the grammar.
    case number(String)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([JSONMember])

    /// Maximum container nesting accepted by `parse`, so hostile input
    /// cannot exhaust the stack.
    static let maxDepth = 512

    /// Parses a complete JSON text (RFC 8259); nil on any syntax error,
    /// trailing garbage, lone surrogate escapes or nesting beyond `maxDepth`.
    /// Duplicate keys keep the first key's position and the last value, like
    /// `JSON.parse`.
    static func parse(_ text: String) -> JSONValue? {
        var parser = JSONTextParser(bytes: Array(text.utf8))
        return parser.parseDocument()
    }

    /// Compact JSON, like `JSON.stringify(value)`.
    var compactText: String {
        var out = ""
        write(to: &out, indent: 0, depth: 0)
        return out
    }

    /// Pretty-printed JSON with a two-space indent, like
    /// `JSON.stringify(value, null, 2)`.
    var prettyText: String {
        var out = ""
        write(to: &out, indent: 2, depth: 0)
        return out
    }

    private func write(to out: inout String, indent: Int, depth: Int) {
        switch self {
        case .string(let s): Self.writeString(s, to: &out)
        case .number(let n): out += n
        case .bool(let b): out += b ? "true" : "false"
        case .null: out += "null"
        case .array(let items):
            writeContainer(
                open: "[", close: "]", count: items.count, to: &out, indent: indent, depth: depth
            ) { i, out in
                items[i].write(to: &out, indent: indent, depth: depth + 1)
            }
        case .object(let members):
            writeContainer(
                open: "{", close: "}", count: members.count, to: &out, indent: indent,
                depth: depth
            ) { i, out in
                Self.writeString(members[i].key, to: &out)
                out += indent > 0 ? ": " : ":"
                members[i].value.write(to: &out, indent: indent, depth: depth + 1)
            }
        }
    }

    private func writeContainer(
        open: String, close: String, count: Int, to out: inout String, indent: Int, depth: Int,
        element: (Int, inout String) -> Void
    ) {
        guard count > 0 else {
            out += open + close
            return
        }
        let inner = "\n" + String(repeating: " ", count: indent * (depth + 1))
        out += open
        for i in 0..<count {
            if i > 0 { out += "," }
            if indent > 0 { out += inner }
            element(i, &out)
        }
        if indent > 0 { out += "\n" + String(repeating: " ", count: indent * depth) }
        out += close
    }

    private static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case _ where scalar.value < 0x20:
                out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        out += "\""
    }
}

/// Recursive-descent parser over UTF-8 bytes.
private struct JSONTextParser {
    let bytes: [UInt8]
    var index = 0

    init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    mutating func parseDocument() -> JSONValue? {
        skipWhitespace()
        guard let value = parseValue(depth: 0) else { return nil }
        skipWhitespace()
        return index == bytes.count ? value : nil
    }

    private var current: UInt8? { index < bytes.count ? bytes[index] : nil }

    private mutating func skipWhitespace() {
        while let byte = current, byte == 0x20 || byte == 0x0A || byte == 0x0D || byte == 0x09 {
            index += 1
        }
    }

    private mutating func consume(_ literal: String) -> Bool {
        let expected = Array(literal.utf8)
        guard index + expected.count <= bytes.count,
            Array(bytes[index..<index + expected.count]) == expected
        else { return false }
        index += expected.count
        return true
    }

    private mutating func parseValue(depth: Int) -> JSONValue? {
        switch current {
        case UInt8(ascii: "{"): return parseObject(depth: depth + 1)
        case UInt8(ascii: "["): return parseArray(depth: depth + 1)
        case UInt8(ascii: "\""): return parseString().map(JSONValue.string)
        case UInt8(ascii: "t"): return consume("true") ? .bool(true) : nil
        case UInt8(ascii: "f"): return consume("false") ? .bool(false) : nil
        case UInt8(ascii: "n"): return consume("null") ? .null : nil
        default: return parseNumber()
        }
    }

    private mutating func parseObject(depth: Int) -> JSONValue? {
        guard depth <= JSONValue.maxDepth else { return nil }
        index += 1  // {
        var members: [JSONMember] = []
        var positions: [String: Int] = [:]
        skipWhitespace()
        if current == UInt8(ascii: "}") {
            index += 1
            return .object(members)
        }
        while true {
            skipWhitespace()
            guard current == UInt8(ascii: "\""), let key = parseString() else { return nil }
            skipWhitespace()
            guard current == UInt8(ascii: ":") else { return nil }
            index += 1
            skipWhitespace()
            guard let value = parseValue(depth: depth) else { return nil }
            if let position = positions[key] {
                members[position] = JSONMember(key: key, value: value)
            } else {
                positions[key] = members.count
                members.append(JSONMember(key: key, value: value))
            }
            skipWhitespace()
            switch current {
            case UInt8(ascii: ","): index += 1
            case UInt8(ascii: "}"):
                index += 1
                return .object(members)
            default: return nil
            }
        }
    }

    private mutating func parseArray(depth: Int) -> JSONValue? {
        guard depth <= JSONValue.maxDepth else { return nil }
        index += 1  // [
        var items: [JSONValue] = []
        skipWhitespace()
        if current == UInt8(ascii: "]") {
            index += 1
            return .array(items)
        }
        while true {
            skipWhitespace()
            guard let value = parseValue(depth: depth) else { return nil }
            items.append(value)
            skipWhitespace()
            switch current {
            case UInt8(ascii: ","): index += 1
            case UInt8(ascii: "]"):
                index += 1
                return .array(items)
            default: return nil
            }
        }
    }

    /// Parses a string starting at the opening quote.
    private mutating func parseString() -> String? {
        index += 1  // opening quote
        var scalars = String.UnicodeScalarView()
        var runStart = index
        func flushRun(_ end: Int) -> Bool {
            guard runStart < end else { return true }
            guard let run = String(bytes: bytes[runStart..<end], encoding: .utf8) else {
                return false
            }
            scalars.append(contentsOf: run.unicodeScalars)
            return true
        }
        while let byte = current {
            switch byte {
            case UInt8(ascii: "\""):
                guard flushRun(index) else { return nil }
                index += 1
                return String(scalars)
            case UInt8(ascii: "\\"):
                guard flushRun(index) else { return nil }
                index += 1
                guard let scalar = parseEscape() else { return nil }
                scalars.append(scalar)
                runStart = index
            case 0x00..<0x20:
                return nil  // raw control characters are not allowed
            default:
                index += 1
            }
        }
        return nil  // unterminated
    }

    /// Parses the escape after a backslash.
    private mutating func parseEscape() -> Unicode.Scalar? {
        guard let byte = current else { return nil }
        index += 1
        switch byte {
        case UInt8(ascii: "\""): return "\""
        case UInt8(ascii: "\\"): return "\\"
        case UInt8(ascii: "/"): return "/"
        case UInt8(ascii: "b"): return "\u{08}"
        case UInt8(ascii: "f"): return "\u{0C}"
        case UInt8(ascii: "n"): return "\n"
        case UInt8(ascii: "r"): return "\r"
        case UInt8(ascii: "t"): return "\t"
        case UInt8(ascii: "u"):
            guard let high = parseHex4() else { return nil }
            if (0xD800...0xDBFF).contains(high) {
                guard consume("\\u"), let low = parseHex4(), (0xDC00...0xDFFF).contains(low)
                else { return nil }
                return Unicode.Scalar(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00))
            }
            return Unicode.Scalar(high)  // nil for a lone low surrogate
        default: return nil
        }
    }

    private mutating func parseHex4() -> UInt32? {
        guard index + 4 <= bytes.count,
            let text = String(bytes: bytes[index..<index + 4], encoding: .ascii),
            text.allSatisfy(\.isHexDigit),
            let value = UInt32(text, radix: 16)
        else { return nil }
        index += 4
        return value
    }

    /// `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`, kept as text.
    private mutating func parseNumber() -> JSONValue? {
        let start = index
        if current == UInt8(ascii: "-") { index += 1 }
        guard let first = current, isDigit(first) else { return nil }
        index += 1
        if first != UInt8(ascii: "0") { skipDigits() }
        if current == UInt8(ascii: ".") {
            index += 1
            guard requireDigits() else { return nil }
        }
        if current == UInt8(ascii: "e") || current == UInt8(ascii: "E") {
            index += 1
            if current == UInt8(ascii: "+") || current == UInt8(ascii: "-") { index += 1 }
            guard requireDigits() else { return nil }
        }
        return String(bytes: bytes[start..<index], encoding: .ascii).map(JSONValue.number)
    }

    private func isDigit(_ byte: UInt8) -> Bool {
        byte >= UInt8(ascii: "0") && byte <= UInt8(ascii: "9")
    }

    private mutating func skipDigits() {
        while let byte = current, isDigit(byte) { index += 1 }
    }

    private mutating func requireDigits() -> Bool {
        let start = index
        skipDigits()
        return index > start
    }
}

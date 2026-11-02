import XCTest

@testable import cubelite

/// JSON log humanisation (#477, parity of the desktop `log-json.ts`).
final class JSONLogParserTests: XCTestCase {

    // MARK: - JSONValue parsing

    func testParse_keepsKeyOrderAndNumberSourceText() throws {
        let value = try XCTUnwrap(
            JSONValue.parse(#"{"z":1,"a":12345678901234567890,"m":1.50,"e":-2E+3}"#))
        guard case .object(let members) = value else { return XCTFail("not an object") }
        XCTAssertEqual(members.map(\.key), ["z", "a", "m", "e"])
        XCTAssertEqual(members[1].value, .number("12345678901234567890"))
        XCTAssertEqual(members[2].value, .number("1.50"))
        XCTAssertEqual(members[3].value, .number("-2E+3"))
    }

    func testParse_stringEscapesAndSurrogatePairs() throws {
        let value = try XCTUnwrap(JSONValue.parse(#"["a\"b\\c\/d\n\t\u00e9\ud83d\ude00"]"#))
        XCTAssertEqual(value, .array([.string("a\"b\\c/d\n\té😀")]))
    }

    func testParse_literalsAndNesting() throws {
        let value = try XCTUnwrap(JSONValue.parse(#" {"a":[true,false,null,{}],"b":{"c":[]}} "#))
        XCTAssertEqual(
            value,
            .object([
                JSONMember(key: "a", value: .array([.bool(true), .bool(false), .null, .object([])])),
                JSONMember(key: "b", value: .object([JSONMember(key: "c", value: .array([]))])),
            ]))
    }

    func testParse_duplicateKeyKeepsFirstPositionLastValue() throws {
        let value = try XCTUnwrap(JSONValue.parse(#"{"a":1,"b":2,"a":3}"#))
        XCTAssertEqual(
            value,
            .object([
                JSONMember(key: "a", value: .number("3")), JSONMember(key: "b", value: .number("2")),
            ]))
    }

    func testParse_rejectsInvalidJSON() {
        for text in [
            "", "{", "{\"a\":}", "{\"a\":1,}", "[1,]", "01", "1.", "-", "+1", ".5", "1e",
            "{'a':1}", "{\"a\":1} x", "\"unterminated", "\"bad \\x escape\"", "\"raw\ttab\"",
            "tru", "nul", "{\"a\" 1}", "\"\\ud83d",
        ] {
            XCTAssertNil(JSONValue.parse(text), text)
        }
    }

    func testParse_loneSurrogatesBecomeReplacementCharacter() {
        XCTAssertEqual(JSONValue.parse(#""a\ud83db""#), .string("a\u{FFFD}b"))
        XCTAssertEqual(JSONValue.parse(#""\udc00""#), .string("\u{FFFD}"))
        XCTAssertEqual(JSONValue.parse(#""\ud83d\u0041""#), .string("\u{FFFD}A"))
    }

    func testParse_rejectsExcessiveNesting() {
        let deep = String(repeating: "[", count: 600) + String(repeating: "]", count: 600)
        XCTAssertNil(JSONValue.parse(deep))
        let ok = String(repeating: "[", count: 100) + String(repeating: "]", count: 100)
        XCTAssertNotNil(JSONValue.parse(ok))
    }

    // MARK: - Serialisation

    func testCompactText_escapesLikeJSONStringify() throws {
        let value = try XCTUnwrap(JSONValue.parse(#"{"k":"a\"b\n\u0001","n":12345678901234567890,"x":[1,{}]}"#))
        XCTAssertEqual(
            value.compactText, #"{"k":"a\"b\n\u0001","n":12345678901234567890,"x":[1,{}]}"#)
    }

    func testPrettyText_usesTwoSpaceIndent() throws {
        let value = try XCTUnwrap(JSONValue.parse(#"{"a":1,"b":[true,"x"],"c":{},"d":[]}"#))
        XCTAssertEqual(
            value.prettyText,
            """
            {
              "a": 1,
              "b": [
                true,
                "x"
              ],
              "c": {},
              "d": []
            }
            """)
    }

    // MARK: - Detection

    func testParseLine_acceptsObjectsOnly() {
        XCTAssertNotNil(JSONLogView.parse(#"{"msg":"ok"}"#))
        XCTAssertNotNil(JSONLogView.parse("\u{FEFF}  {\"msg\":\"ok\"}  "))
        XCTAssertNil(JSONLogView.parse(#"[{"msg":"ok"}]"#))
        XCTAssertNil(JSONLogView.parse("42"))
        XCTAssertNil(JSONLogView.parse(#"app[1]: {"msg":"ok"}"#))
        XCTAssertNil(JSONLogView.parse(#"{"msg":"ok"} trailing"#))
        XCTAssertNil(JSONLogView.parse(#"{"msg":"ok""#))
        XCTAssertNil(JSONLogView.parse("plain text line"))
    }

    // MARK: - Field picking

    func testParseLine_humanisesTypicalLine() throws {
        let view = try XCTUnwrap(
            JSONLogView.parse(
                #"{"level":"info","ts":"2026-10-28T09:41:02.113Z","msg":"order accepted","orderId":"A-1931","latencyMs":41}"#
            ))
        XCTAssertEqual(view.time, "2026-10-28T09:41:02.113Z")
        XCTAssertEqual(view.level, .info)
        XCTAssertEqual(view.message, "order accepted")
        XCTAssertEqual(view.tail, [.init(key: "orderId", value: "A-1931"), .init(key: "latencyMs", value: "41")])
    }

    func testParseLine_candidateOrderWinsAndKeysAreCaseInsensitive() throws {
        let view = try XCTUnwrap(
            JSONLogView.parse(#"{"Msg":"second","MESSAGE":"first","T":"x","Timestamp":"y"}"#))
        XCTAssertEqual(view.message, "first")
        XCTAssertEqual(view.time, "y")
        XCTAssertEqual(view.tail, [.init(key: "Msg", value: "second"), .init(key: "T", value: "x")])
    }

    func testParseLine_skipsCandidatesWithWrongType() throws {
        let view = try XCTUnwrap(JSONLogView.parse(#"{"message":{"a":1},"msg":"text","level":"nope","severity":"WARNING"}"#))
        XCTAssertEqual(view.message, "text")
        XCTAssertEqual(view.level, .warn)
        XCTAssertEqual(view.tail.map(\.key), ["message", "level"])
    }

    func testParseLine_nestedECSLevelKeepsLogObjectInTail() throws {
        let view = try XCTUnwrap(JSONLogView.parse(#"{"log":{"level":"ERROR"},"message":"boom"}"#))
        XCTAssertEqual(view.level, .error)
        XCTAssertEqual(view.tail, [.init(key: "log", value: #"{"level":"ERROR"}"#)])
    }

    func testParseLine_literalDottedLevelKeyIsConsumed() throws {
        let view = try XCTUnwrap(JSONLogView.parse(#"{"log.level":"warn","message":"m","x":1}"#))
        XCTAssertEqual(view.level, .warn)
        XCTAssertEqual(view.tail.map(\.key), ["x"])
    }

    func testMapLevel_namesAndNumbers() {
        let cases: [(JSONValue, LogLine.Level?)] = [
            (.string("TRACE"), .debug), (.string("verbose"), .debug), (.string("Info"), .info),
            (.string("notice"), .info), (.string("warning"), .warn), (.string("err"), .error),
            (.string("dpanic"), .error), (.string("emergency"), .error), (.string(" crit "), .error),
            (.string("bogus"), nil), (.string(""), nil), (.string("30"), .info),
            (.number("10"), .debug), (.number("30"), .info), (.number("40"), .warn),
            (.number("50"), .error), (.number("60"), .error), (.bool(true), nil), (.null, nil),
        ]
        for (raw, expected) in cases {
            XCTAssertEqual(JSONLogView.mapLevel(raw), expected, "\(raw)")
        }
    }

    func testParseLine_unknownLevelLeavesLevelNilAndKeepsField() throws {
        let view = try XCTUnwrap(JSONLogView.parse(#"{"level":"custom","msg":"m"}"#))
        XCTAssertNil(view.level)
        XCTAssertEqual(view.tail, [.init(key: "level", value: "custom")])
    }

    // MARK: - Message fallback and tail

    func testParseLine_messageFallsBackToFirstRemainingString() throws {
        let view = try XCTUnwrap(JSONLogView.parse(#"{"time":"t","level":"info","n":1,"text":"hello","other":"x"}"#))
        XCTAssertEqual(view.message, "hello")
        XCTAssertEqual(view.tail, [.init(key: "n", value: "1"), .init(key: "other", value: "x")])
    }

    func testParseLine_messageFallsBackToCompactJSONWithEmptyTail() throws {
        let view = try XCTUnwrap(JSONLogView.parse(#"{"n":1,"ok":true}"#))
        XCTAssertEqual(view.message, #"{"n":1,"ok":true}"#)
        XCTAssertEqual(view.tail, [])
    }

    func testParseLine_tailCompactsAndTruncatesContainers() throws {
        let long = String(repeating: "x", count: 80)
        let view = try XCTUnwrap(
            JSONLogView.parse(#"{"msg":"m","flag":false,"none":null,"obj":{"s":"\#(long)"},"big":12345678901234567890}"#))
        XCTAssertEqual(view.tail[0], .init(key: "flag", value: "false"))
        XCTAssertEqual(view.tail[1], .init(key: "none", value: "null"))
        XCTAssertEqual(view.tail[2].value, String(#"{"s":"\#(long)"}"#.prefix(60)) + "…")
        XCTAssertEqual(view.tail[3], .init(key: "big", value: "12345678901234567890"))
    }

    func testParseLine_flattensControlCharactersForDisplayOnly() throws {
        let view = try XCTUnwrap(JSONLogView.parse(#"{"msg":"line1\nline2\r\nline3\tend","st":"a\nb"}"#))
        XCTAssertEqual(view.message, "line1↵ line2↵ line3 end")
        XCTAssertEqual(view.tail, [.init(key: "st", value: "a↵ b")])
        guard case .object(let members) = view.object else { return XCTFail("not an object") }
        XCTAssertEqual(members[0].value, .string("line1\nline2\r\nline3\tend"))
    }
}

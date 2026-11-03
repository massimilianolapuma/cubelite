import XCTest

@testable import cubelite

// MARK: - ECS conversion (#493)
//
// Same vectors as the desktop `log-ecs.test.ts`
// (spec docs/superpowers/specs/2026-11-03-ecs-log-view-design.md §4-5).

final class ECSDocumentTests: XCTestCase {

    private let stamp = "2026-11-03T08:00:01.123456789Z"
    private let meta = ECSDocument.Metadata(namespace: "shop", pod: "api-0")

    private func line(
        _ message: String, level: LogLine.Level = .info, container: String? = nil,
        timestamp: String?? = .none
    ) -> LogLine {
        LogLine(
            id: 1, time: "08:00:01", level: level, message: message, container: container,
            timestamp: timestamp ?? stamp)
    }

    private func fields(_ doc: ECSDocument) -> [String: JSONValue] {
        Dictionary(uniqueKeysWithValues: doc.fields.map { ($0.key, $0.value) })
    }

    private func added(_ doc: ECSDocument) -> [String] {
        doc.fields.filter(\.added).map(\.key)
    }

    // MARK: Plain text

    func testPlainLine_wrapsMessageWithKubeletTimeLevelAndMetadata() {
        let doc = ECSDocument.make(
            line: line("GET /health 200", level: .warn, container: "web"), metadata: meta)
        XCTAssertEqual(
            doc.fields.map(\.key),
            [
                "@timestamp", "log.level", "message", "kubernetes.namespace",
                "kubernetes.pod.name", "container.name", "ecs.version",
            ])
        let f = fields(doc)
        XCTAssertEqual(f["@timestamp"], .string(stamp))
        XCTAssertEqual(f["log.level"], .string("warn"))
        XCTAssertEqual(f["message"], .string("GET /health 200"))
        XCTAssertEqual(f["container.name"], .string("web"))
        XCTAssertEqual(f["ecs.version"], .string(ECSDocument.ecsVersion))
        XCTAssertFalse(added(doc).contains("message"))
        XCTAssertEqual(doc.level, .warn)
    }

    func testPlainLine_omitsUnknownContainerAndMissingTimestamp() {
        let doc = ECSDocument.make(line: line("x", timestamp: .some(nil)), metadata: meta)
        XCTAssertFalse(doc.fields.contains { $0.key == "container.name" })
        XCTAssertFalse(doc.fields.contains { $0.key == "@timestamp" })
    }

    func testMetadataContainerWinsOverLineTag() {
        let doc = ECSDocument.make(
            line: line("x", container: "a"),
            metadata: ECSDocument.Metadata(namespace: "n", pod: "p", container: "b"))
        XCTAssertEqual(fields(doc)["container.name"], .string("b"))
    }

    // MARK: Aliases

    func testJSONLine_renamesEveryAliasAndKeepsCustomFields() {
        let json = #"""
            {"ts":"2026-11-03T07:59:59Z","level":"WARN","msg":"order accepted","logger":"orders","error":"boom","stack":"at x\nat y","traceId":"t1","span_id":"s1","service":"shop-api","orderId":"A-1931"}
            """#
        let doc = ECSDocument.make(line: line(json), metadata: meta)
        let f = fields(doc)
        XCTAssertEqual(f["@timestamp"], .string("2026-11-03T07:59:59Z"))
        XCTAssertEqual(f["log.level"], .string("warn"))
        XCTAssertEqual(f["message"], .string("order accepted"))
        XCTAssertEqual(f["log.logger"], .string("orders"))
        XCTAssertEqual(f["error.message"], .string("boom"))
        XCTAssertEqual(f["error.stack_trace"], .string("at x\nat y"))
        XCTAssertEqual(f["trace.id"], .string("t1"))
        XCTAssertEqual(f["span.id"], .string("s1"))
        XCTAssertEqual(f["service.name"], .string("shop-api"))
        XCTAssertEqual(f["orderId"], .string("A-1931"))
        XCTAssertEqual(added(doc), ["kubernetes.namespace", "kubernetes.pod.name", "ecs.version"])
    }

    func testPinoNumericLevels() {
        func level(_ n: Int) -> JSONValue? {
            fields(ECSDocument.make(line: line(#"{"level":\#(n),"msg":"m"}"#), metadata: meta))[
                "log.level"]
        }
        XCTAssertEqual(level(30), .string("info"))
        XCTAssertEqual(level(50), .string("error"))
        XCTAssertEqual(level(60), .string("fatal"))
        XCTAssertEqual(
            ECSDocument.make(line: line(#"{"level":60,"msg":"m"}"#), metadata: meta).level, .error)
    }

    func testEpochTimestampStaysAndKubeletFillsTimestamp() {
        let doc = ECSDocument.make(line: line(#"{"ts":1730620800,"msg":"m"}"#), metadata: meta)
        XCTAssertEqual(fields(doc)["ts"], .number("1730620800"))
        XCTAssertEqual(fields(doc)["@timestamp"], .string(stamp))
        XCTAssertTrue(added(doc).contains("@timestamp"))
    }

    func testDoesNotRenameOntoAnExistingField() {
        let doc = ECSDocument.make(line: line(#"{"message":"a","msg":"b"}"#), metadata: meta)
        XCTAssertEqual(fields(doc)["message"], .string("a"))
        XCTAssertEqual(fields(doc)["msg"], .string("b"))
    }

    func testErrorObjectsFlattenIntoErrorFields() {
        let doc = ECSDocument.make(
            line: line(#"{"msg":"m","err":{"message":"bad","stack":"s"}}"#), metadata: meta)
        XCTAssertEqual(fields(doc)["error.message"], .string("bad"))
        XCTAssertEqual(fields(doc)["error.stack_trace"], .string("s"))
    }

    // MARK: Already ECS

    func testAlreadyECSLine_keptAsLoggedWithOnlyMissingMetadata() {
        let json = #"""
            {"@timestamp":"2026-11-03T07:00:00Z","log":{"level":"error","logger":"app"},"message":"failed","msg":"not renamed","ecs":{"version":"1.6.0"},"kubernetes":{"namespace":"other"}}
            """#
        let doc = ECSDocument.make(line: line(json), metadata: meta)
        let f = fields(doc)
        XCTAssertEqual(f["log.level"], .string("error"))
        XCTAssertEqual(f["log.logger"], .string("app"))
        XCTAssertEqual(f["msg"], .string("not renamed"))
        XCTAssertEqual(f["ecs.version"], .string("1.6.0"))
        XCTAssertEqual(f["kubernetes.namespace"], .string("other"))
        XCTAssertEqual(added(doc), ["kubernetes.pod.name"])
        XCTAssertEqual(doc.level, .error)
    }

    // MARK: Flatten

    func testFlatten_nestedPathWinsOverLiteralDottedKey() {
        for json in [#"{"log.level":"a","log":{"level":"b"}}"#, #"{"log":{"level":"b"},"log.level":"a"}"#] {
            guard case .object(let members)? = JSONValue.parse(json) else {
                return XCTFail("parse")
            }
            let flat = ECSDocument.flatten(members)
            XCTAssertEqual(flat.map(\.key), ["log.level", "log.level_"], json)
            XCTAssertEqual(flat.map(\.value), [.string("b"), .string("a")], json)
        }
    }

    func testFlatten_keepsArraysAndEmptyObjectsAsValues() {
        guard case .object(let members)? = JSONValue.parse(#"{"tags":["a"],"meta":{}}"#) else {
            return XCTFail("parse")
        }
        let flat = ECSDocument.flatten(members)
        XCTAssertEqual(flat.map(\.key), ["tags", "meta"])
        XCTAssertEqual(flat.map(\.value), [.array([.string("a")]), .object([])])
    }

    // MARK: Nested output

    func testNestedJSON_ecsFieldsFirst() {
        let doc = ECSDocument.make(
            line: line(#"{"orderId":7,"msg":"m","level":"info"}"#), metadata: meta)
        XCTAssertEqual(
            doc.compactJSON,
            #"{"@timestamp":"\#(stamp)","log":{"level":"info"},"message":"m","orderId":7,"kubernetes":{"namespace":"shop","pod":{"name":"api-0"}},"ecs":{"version":"\#(ECSDocument.ecsVersion)"}}"#
        )
    }

    func testNestedJSON_scalarOnPathKeepsKeyDotted() {
        let doc = ECSDocument(
            fields: [
                ECSField(key: "a", value: .number("1"), added: false),
                ECSField(key: "a.b", value: .number("2"), added: false),
                ECSField(key: "x..y", value: .number("3"), added: false),
            ], level: .info)
        XCTAssertEqual(doc.compactJSON, #"{"a":1,"a.b":2,"x..y":3}"#)
    }

    func testNestedJSON_laterScalarDoesNotOverwriteObject() {
        let doc = ECSDocument(
            fields: [
                ECSField(key: "service.name", value: .string("a"), added: false),
                ECSField(key: "service", value: .string("b"), added: false),
                ECSField(key: "log.level.x", value: .number("1"), added: false),
                ECSField(key: "log.level", value: .string("info"), added: false),
            ], level: .info)
        XCTAssertEqual(
            doc.compactJSON,
            #"{"service":{"name":"a"},"service_":"b","log":{"level":{"x":1}},"log.level":"info"}"#)
    }

    func testNestedJSON_keepsLargeIntegersExact() {
        let doc = ECSDocument.make(
            line: line(#"{"msg":"m","id":12345678901234567890}"#), metadata: meta)
        XCTAssertTrue(doc.compactJSON.contains(#""id":12345678901234567890"#))
    }

    func testNDJSON_newlineTerminated() {
        let out = ECSDocument.ndjson([line("a"), line("b")]) { _ in self.meta }
        let parts = out.components(separatedBy: "\n")
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(parts[2], "")
        XCTAssertTrue(parts[1].contains(#""message":"b""#))
    }

    // MARK: Row and table

    func testRow_serviceMessageAndTailWithoutNoise() {
        let doc = ECSDocument.make(
            line: line(
                #"{"msg":"m","service":"api","orderId":"A","trace_id":"t","error":"e"}"#,
                container: "web"),
            metadata: meta)
        XCTAssertEqual(doc.row.service, "api")
        XCTAssertEqual(doc.row.message, "m")
        XCTAssertEqual(doc.row.tail.map(\.key), ["error.message", "trace.id", "orderId"])
    }

    func testRow_fallsBackToFirstStringField() {
        let row = ECSDocument.make(line: line(#"{"n":1,"op":"sync","k":"v"}"#), metadata: meta).row
        XCTAssertEqual(row.message, "sync")
        XCTAssertEqual(row.tail.map(\.key), ["n", "k"])
    }

    func testRow_flattensNewlines() {
        XCTAssertEqual(
            ECSDocument.make(line: line(#"{"msg":"a\nb"}"#), metadata: meta).row.message, "a↵ b")
    }

    func testTable_sortedWithTimestampFirst() {
        let keys = ECSDocument.make(
            line: line(#"{"msg":"m","zeta":1,"alpha":2,"1":3,"$x":4}"#), metadata: meta
        ).table.map(\.key)
        XCTAssertEqual(keys.first, "@timestamp")
        XCTAssertEqual(Array(keys.dropFirst()), keys.dropFirst().sorted())
    }

    // MARK: Line timestamp and export

    func testLogLineParse_keepsFullKubeletTimestamp() {
        let parsed = LogLine.parse("2026-11-03T08:00:01.5Z hello", id: 0)
        XCTAssertEqual(parsed.timestamp, "2026-11-03T08:00:01.5Z")
        XCTAssertEqual(parsed.time, "08:00:01.5Z")
        XCTAssertNil(LogLine.parse("hello", id: 0).timestamp)
    }

    func testExporter_writesNDJSONInECSMode() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
            "cubelite-ecs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = try LogExporter.write(
            [line("hello", level: .warn)], pod: "api-0", container: "worker", full: false,
            directory: dir, ecs: { _ in self.meta })
        XCTAssertEqual(url.lastPathComponent, "api-0_worker.ndjson")
        let text = try String(contentsOf: url, encoding: .utf8)
        XCTAssertTrue(text.hasSuffix("}\n"))
        XCTAssertTrue(text.contains(#""log":{"level":"warn"}"#))
    }
}

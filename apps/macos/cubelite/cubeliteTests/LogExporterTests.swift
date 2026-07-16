import XCTest

@testable import cubelite

final class LogExporterTests: XCTestCase {

    func testFilename_withContainer() {
        XCTAssertEqual(
            LogExporter.filename(pod: "web-1", container: "worker", full: false),
            "web-1_worker.log")
    }

    func testFilename_fullBuffer_addsSuffix() {
        XCTAssertEqual(
            LogExporter.filename(pod: "web-1", container: "worker", full: true),
            "web-1_worker_full.log")
    }

    func testFilename_noContainer_omitsSegment() {
        XCTAssertEqual(
            LogExporter.filename(pod: "web-1", container: nil, full: false), "web-1.log")
    }

    func testContent_joinsTimeAndMessage() {
        let lines = [
            LogLine.parse("2026-07-15T10:00:00Z hello", id: 0),
            LogLine.parse("bare message", id: 1),
        ]
        XCTAssertEqual(
            LogExporter.content(lines),
            "10:00:00Z hello\nbare message\n")
    }

    func testWrite_createsFileWithContent() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("LogExporterTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let lines = [LogLine.parse("2026-07-15T10:00:00Z hello", id: 0)]
        let url = try LogExporter.write(
            lines, pod: "web-1", container: "worker", full: false, directory: dir)

        XCTAssertEqual(url.lastPathComponent, "web-1_worker.log")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "10:00:00Z hello\n")
    }
}

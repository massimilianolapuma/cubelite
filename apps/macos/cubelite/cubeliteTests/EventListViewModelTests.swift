import XCTest

@testable import cubelite

final class EventListViewModelTests: XCTestCase {

    private func event(
        type: String? = "Normal",
        reason: String? = "Scheduled",
        kind: String? = "Pod",
        name: String? = "api-1",
        count: Int? = nil
    ) -> EventInfo {
        EventInfo(
            name: "evt", namespace: "default", reason: reason, message: "msg",
            objectKind: kind, objectName: name, count: count,
            lastTimestamp: "2026-07-18T10:00:00Z", type: type)
    }

    // MARK: - Decoding

    func testToEventInfoKeepsType() {
        let dto = K8sEvent(
            metadata: K8sObjectMeta(name: "evt-1", namespace: "default"),
            reason: "BackOff", message: nil, type: "Warning", count: 3,
            lastTimestamp: "2026-07-18T10:00:00Z",
            involvedObject: K8sEvent.InvolvedObject(kind: "Pod", name: "api-1"))

        XCTAssertEqual(dto.toEventInfo().type, "Warning")
    }

    func testEventInfoDecodesWithoutType() throws {
        let json = #"{"name":"e","namespace":"ns"}"#.data(using: .utf8)!
        let info = try JSONDecoder().decode(EventInfo.self, from: json)
        XCTAssertNil(info.type)
    }

    // MARK: - Type

    func testIsWarningIsCaseInsensitive() {
        XCTAssertTrue(EventRowFormat.isWarning(event(type: "Warning")))
        XCTAssertTrue(EventRowFormat.isWarning(event(type: "warning")))
        XCTAssertFalse(EventRowFormat.isWarning(event(type: "Normal")))
        XCTAssertFalse(EventRowFormat.isWarning(event(type: nil)))
    }

    func testTypeLabelDefaultsToNormal() {
        XCTAssertEqual(EventRowFormat.typeLabel(event(type: "Warning")), "Warning")
        XCTAssertEqual(EventRowFormat.typeLabel(event(type: nil)), "Normal")
    }

    // MARK: - Labels

    func testReasonLabelAppendsRepeatCount() {
        XCTAssertEqual(EventRowFormat.reasonLabel(event(count: 12)), "Scheduled ×12")
        XCTAssertEqual(EventRowFormat.reasonLabel(event(count: 1)), "Scheduled")
        XCTAssertEqual(EventRowFormat.reasonLabel(event(count: nil)), "Scheduled")
        XCTAssertEqual(EventRowFormat.reasonLabel(event(reason: nil)), "—")
    }

    func testObjectLabelJoinsKindAndName() {
        XCTAssertEqual(EventRowFormat.objectLabel(event()), "Pod/api-1")
        XCTAssertEqual(EventRowFormat.objectLabel(event(kind: nil)), "api-1")
        XCTAssertEqual(EventRowFormat.objectLabel(event(name: nil)), "Pod")
        XCTAssertEqual(EventRowFormat.objectLabel(event(kind: nil, name: nil)), "—")
    }

    // MARK: - Layout and age

    func testColumnWidthsFollowTheDesktopGrid() {
        let widths = EventRowFormat.columnWidths(total: 620)
        XCTAssertEqual(widths.count, 5)
        XCTAssertEqual(widths.reduce(0, +), 620, accuracy: 0.001)
        XCTAssertEqual(widths[3] / widths[0], 2.6 / 0.7, accuracy: 0.001)
    }

    func testAgeIsDashWithoutTimestamp() {
        let noTime = EventInfo(
            name: "e", namespace: "ns", reason: nil, message: nil,
            objectKind: nil, objectName: nil, count: nil, lastTimestamp: nil)
        XCTAssertEqual(noTime.lastTimestamp.k8sAge, "—")
    }
}

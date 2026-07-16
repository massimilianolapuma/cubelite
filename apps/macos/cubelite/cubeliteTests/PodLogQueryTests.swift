import XCTest

@testable import cubelite

final class PodLogQueryTests: XCTestCase {

    func testPath_defaults_followsWithTimestampsAndTail500() {
        let query = PodLogQuery(namespace: "default", pod: "web-1")
        XCTAssertEqual(
            query.path,
            "/api/v1/namespaces/default/pods/web-1/log"
                + "?follow=true&timestamps=true&tailLines=500")
    }

    func testPath_container_addsEncodedContainerParam() {
        let query = PodLogQuery(namespace: "default", pod: "web-1", container: "istio proxy")
        XCTAssertTrue(query.path.contains("&container=istio%20proxy"))
    }

    func testPath_previous_disablesFollowAndAddsPrevious() {
        let query = PodLogQuery(
            namespace: "default", pod: "web-1", container: "worker", previous: true)
        XCTAssertFalse(query.path.contains("follow=true"))
        XCTAssertTrue(query.path.contains("previous=true"))
        XCTAssertTrue(query.path.contains("timestamps=true"))
    }

    func testPath_noFollow_omitsFollowParam() {
        let query = PodLogQuery(namespace: "default", pod: "web-1", follow: false)
        XCTAssertFalse(query.path.contains("follow"))
    }

    func testPath_customTail_usesGivenValue() {
        let query = PodLogQuery(namespace: "default", pod: "web-1", tailLines: 5000)
        XCTAssertTrue(query.path.contains("tailLines=5000"))
    }

    func testPath_sinceTime_addsEncodedTimestamp() {
        let query = PodLogQuery(
            namespace: "default", pod: "web-1", sinceTime: "2026-07-15T10:00:00Z")
        XCTAssertTrue(query.path.contains("sinceTime=2026-07-15T10%3A00%3A00Z"))
    }

    func testPath_namespaceAndPod_arePercentEncoded() {
        let query = PodLogQuery(namespace: "team a", pod: "web 1")
        XCTAssertTrue(query.path.hasPrefix("/api/v1/namespaces/team%20a/pods/web%201/log?"))
    }
}

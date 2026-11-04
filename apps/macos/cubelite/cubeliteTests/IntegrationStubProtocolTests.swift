import XCTest

@testable import cubelite

/// The HTTP stub is process-wide, so a request a previous test left in
/// flight (e.g. a cancelled chart query) must not land in the next test's
/// record (#540).
final class IntegrationStubProtocolTests: XCTestCase {
    func testALateRequestFromAnEarlierTestIsNotRecorded() async throws {
        IntegrationStubProtocol.reset([:]) { _ in (200, "earlier") }
        let earlier = URLSession(configuration: IntegrationStubProtocol.configuration())

        // The next test starts: a fresh record.
        IntegrationStubProtocol.reset(["/x": (200, "now")])
        let url = try XCTUnwrap(URL(string: "https://stub.test/x"))
        let (_, late) = try await earlier.data(from: url)
        XCTAssertEqual((late as? HTTPURLResponse)?.statusCode, 404, "a stale request is answered, not served")
        XCTAssertTrue(IntegrationStubProtocol.requests.isEmpty, "and not recorded")

        let current = URLSession(configuration: IntegrationStubProtocol.configuration())
        let (body, _) = try await current.data(from: url)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "now")
        XCTAssertEqual(IntegrationStubProtocol.requests.map(\.url), ["https://stub.test/x"])
    }
}

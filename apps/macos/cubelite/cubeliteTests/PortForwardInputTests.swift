import XCTest

@testable import cubelite

// MARK: - PortForwardInputTests

/// Tests the pure parsing/validation helpers behind the port-forward fields.
final class PortForwardInputTests: XCTestCase {

    // MARK: - parsePort

    func testParsePort_validPort_parses() {
        XCTAssertEqual(PortForwardInput.parsePort("6789"), 6789)
    }

    func testParsePort_trimsWhitespace() {
        XCTAssertEqual(PortForwardInput.parsePort(" 80 "), 80)
    }

    func testParsePort_bounds() {
        XCTAssertEqual(PortForwardInput.parsePort("1"), 1)
        XCTAssertEqual(PortForwardInput.parsePort("65535"), 65535)
        XCTAssertNil(PortForwardInput.parsePort("0"))
        XCTAssertNil(PortForwardInput.parsePort("65536"))
    }

    func testParsePort_rejectsNonNumeric() {
        XCTAssertNil(PortForwardInput.parsePort(""))
        XCTAssertNil(PortForwardInput.parsePort("http"))
        XCTAssertNil(PortForwardInput.parsePort("6.789"))
        XCTAssertNil(PortForwardInput.parsePort("-80"))
    }

    // MARK: - resolveLocalPort

    func testResolveLocalPort_empty_mirrorsRemote() {
        XCTAssertEqual(PortForwardInput.resolveLocalPort("", remotePort: 6789), 6789)
    }

    func testResolveLocalPort_explicitValue_wins() {
        XCTAssertEqual(PortForwardInput.resolveLocalPort("9000", remotePort: 80), 9000)
    }

    func testResolveLocalPort_invalidText_isNil() {
        XCTAssertNil(PortForwardInput.resolveLocalPort("abc", remotePort: 80))
        XCTAssertNil(PortForwardInput.resolveLocalPort("0", remotePort: 80))
    }
}

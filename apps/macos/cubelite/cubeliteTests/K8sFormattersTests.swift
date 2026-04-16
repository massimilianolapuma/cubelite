import SwiftUI
import XCTest

@testable import cubelite

// MARK: - K8s Age Formatting Tests

final class K8sFormattersTests: XCTestCase {

    // MARK: k8sAge — nil / invalid

    func testK8sAge_nilString_returnsDash() {
        let value: String? = nil
        XCTAssertEqual(value.k8sAge, "—")
    }

    func testK8sAge_emptyString_returnsDash() {
        let value: String? = ""
        XCTAssertEqual(value.k8sAge, "—")
    }

    func testK8sAge_invalidString_returnsDash() {
        let value: String? = "not-a-date"
        XCTAssertEqual(value.k8sAge, "—")
    }

    // MARK: k8sAge — seconds

    func testK8sAge_fewSecondsAgo_returnsSuffix() {
        let date = Date().addingTimeInterval(-30)
        let iso = ISO8601DateFormatter().string(from: date)
        let result: String? = iso
        let age = result.k8sAge
        XCTAssertTrue(age.hasSuffix("s"), "Expected seconds suffix, got \(age)")
        // Should be around 30s (±2s for test execution)
        let num = Int(age.dropLast())
        XCTAssertNotNil(num)
        XCTAssertTrue((28...35).contains(num!), "Expected ~30s, got \(age)")
    }

    func testK8sAge_zeroSeconds_returns0s() {
        let date = Date()
        let iso = ISO8601DateFormatter().string(from: date)
        let result: String? = iso
        let age = result.k8sAge
        XCTAssertTrue(age.hasSuffix("s"), "Expected seconds suffix, got \(age)")
    }

    // MARK: k8sAge — minutes

    func testK8sAge_fewMinutesAgo_returnsMSuffix() {
        let date = Date().addingTimeInterval(-300)  // 5 min
        let iso = ISO8601DateFormatter().string(from: date)
        let result: String? = iso
        let age = result.k8sAge
        XCTAssertEqual(age, "5m")
    }

    func testK8sAge_59MinutesAgo_returns59m() {
        let date = Date().addingTimeInterval(-59 * 60)  // 59 min
        let iso = ISO8601DateFormatter().string(from: date)
        let result: String? = iso
        let age = result.k8sAge
        XCTAssertEqual(age, "59m")
    }

    // MARK: k8sAge — hours

    func testK8sAge_twoHoursAgo_returns2h() {
        let date = Date().addingTimeInterval(-2 * 3600)
        let iso = ISO8601DateFormatter().string(from: date)
        let result: String? = iso
        let age = result.k8sAge
        XCTAssertEqual(age, "2h")
    }

    func testK8sAge_23HoursAgo_returns23h() {
        let date = Date().addingTimeInterval(-23 * 3600)
        let iso = ISO8601DateFormatter().string(from: date)
        let result: String? = iso
        let age = result.k8sAge
        XCTAssertEqual(age, "23h")
    }

    // MARK: k8sAge — days

    func testK8sAge_threeDaysAgo_returns3d() {
        let date = Date().addingTimeInterval(-3 * 86400)
        let iso = ISO8601DateFormatter().string(from: date)
        let result: String? = iso
        let age = result.k8sAge
        XCTAssertEqual(age, "3d")
    }

    func testK8sAge_30DaysAgo_returns30d() {
        let date = Date().addingTimeInterval(-30 * 86400)
        let iso = ISO8601DateFormatter().string(from: date)
        let result: String? = iso
        let age = result.k8sAge
        XCTAssertEqual(age, "30d")
    }

    // MARK: k8sAge — fractional seconds format

    func testK8sAge_fractionalSecondsFormat_parseSucceeds() {
        // Kubernetes often emits fractional-second timestamps
        let date = Date().addingTimeInterval(-120)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let iso: String? = formatter.string(from: date)
        let age = iso.k8sAge
        XCTAssertEqual(age, "2m")
    }

    // MARK: Pod Phase Colors

    func testPodPhase_running_isGreen() {
        XCTAssertEqual(Color.podPhase("Running"), .green)
    }

    func testPodPhase_pending_isOrange() {
        XCTAssertEqual(Color.podPhase("Pending"), .orange)
    }

    func testPodPhase_succeeded_isBlue() {
        XCTAssertEqual(Color.podPhase("Succeeded"), .blue)
    }

    func testPodPhase_failed_isRed() {
        XCTAssertEqual(Color.podPhase("Failed"), .red)
    }

    func testPodPhase_nil_isSecondary() {
        XCTAssertEqual(Color.podPhase(nil), .secondary)
    }

    func testPodPhase_unknown_isSecondary() {
        XCTAssertEqual(Color.podPhase("Unknown"), .secondary)
    }

    func testPodPhase_caseSensitive_lowercaseReturnsSecondary() {
        // Kubernetes phases are case-sensitive: "running" ≠ "Running"
        XCTAssertEqual(Color.podPhase("running"), .secondary)
    }

    // MARK: Condition Status Colors

    func testConditionStatus_true_isGreen() {
        XCTAssertEqual(Color.conditionStatus("True"), .green)
    }

    func testConditionStatus_false_isRed() {
        XCTAssertEqual(Color.conditionStatus("False"), .red)
    }

    func testConditionStatus_unknown_isOrange() {
        XCTAssertEqual(Color.conditionStatus("Unknown"), .orange)
    }

    func testConditionStatus_emptyString_isOrange() {
        XCTAssertEqual(Color.conditionStatus(""), .orange)
    }
}

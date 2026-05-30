import XCTest

@testable import cubelite

@MainActor
final class AutoRefreshCoordinatorTests: XCTestCase {

    // MARK: - Disabled (interval == 0)

    func testScheduleWithZeroIntervalIsInactive() {
        let sut = AutoRefreshCoordinator()
        sut.schedule(intervalSeconds: 0) { /* never invoked */ }

        XCTAssertFalse(sut.isActive)
        XCTAssertEqual(sut.currentIntervalSeconds, 0)
        XCTAssertEqual(sut.tickCount, 0)
    }

    func testScheduleWithNegativeIntervalIsInactive() {
        let sut = AutoRefreshCoordinator()
        sut.schedule(intervalSeconds: -5) { /* never invoked */ }

        XCTAssertFalse(sut.isActive)
        XCTAssertEqual(sut.currentIntervalSeconds, 0)
    }

    // MARK: - Active scheduling

    func testScheduleWithPositiveIntervalIsActive() {
        let sut = AutoRefreshCoordinator()
        sut.schedule(intervalSeconds: 30) { /* sleeping */ }

        XCTAssertTrue(sut.isActive)
        XCTAssertEqual(sut.currentIntervalSeconds, 30)
        sut.cancel()
    }

    func testReschedulingReplacesPreviousTask() async {
        let sut = AutoRefreshCoordinator()

        sut.schedule(intervalSeconds: 60) { /* sleeping */ }
        XCTAssertTrue(sut.isActive)
        XCTAssertEqual(sut.currentIntervalSeconds, 60)

        sut.schedule(intervalSeconds: 15) { /* sleeping */ }
        XCTAssertTrue(sut.isActive)
        XCTAssertEqual(sut.currentIntervalSeconds, 15)

        sut.cancel()
    }

    func testReschedulingToZeroStopsTask() {
        let sut = AutoRefreshCoordinator()
        sut.schedule(intervalSeconds: 30) { /* sleeping */ }
        XCTAssertTrue(sut.isActive)

        sut.schedule(intervalSeconds: 0) { /* never invoked */ }
        XCTAssertFalse(sut.isActive)
        XCTAssertEqual(sut.currentIntervalSeconds, 0)
    }

    func testCancelStopsActiveTask() {
        let sut = AutoRefreshCoordinator()
        sut.schedule(intervalSeconds: 30) { /* sleeping */ }
        XCTAssertTrue(sut.isActive)

        sut.cancel()
        XCTAssertFalse(sut.isActive)
        XCTAssertEqual(sut.currentIntervalSeconds, 0)
    }

    func testCancelOnIdleCoordinatorIsSafe() {
        let sut = AutoRefreshCoordinator()
        sut.cancel()
        sut.cancel()
        XCTAssertFalse(sut.isActive)
    }
}

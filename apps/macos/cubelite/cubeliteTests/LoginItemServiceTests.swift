import XCTest

@testable import cubelite

/// Stub `LoginItemRegistering` that records calls and can simulate failures.
@MainActor
private final class StubLoginItemService: LoginItemRegistering {
    var status: LoginItemStatus = .notRegistered
    var registerError: Error?
    var unregisterError: Error?

    private(set) var registerCallCount = 0
    private(set) var unregisterCallCount = 0

    func register() throws {
        registerCallCount += 1
        if let err = registerError { throw err }
        status = .enabled
    }

    func unregister() throws {
        unregisterCallCount += 1
        if let err = unregisterError { throw err }
        status = .notRegistered
    }

    func currentStatus() -> LoginItemStatus { status }
}

/// Unit tests for ``LoginItemController`` and ``LoginItemStatus``.
@MainActor
final class LoginItemServiceTests: XCTestCase {

    // MARK: - LoginItemStatus.isEnabled

    func testStatusEnabledIsEnabled() {
        XCTAssertTrue(LoginItemStatus.enabled.isEnabled)
    }

    func testStatusRequiresApprovalIsEnabled() {
        XCTAssertTrue(LoginItemStatus.requiresApproval.isEnabled)
    }

    func testStatusNotRegisteredIsDisabled() {
        XCTAssertFalse(LoginItemStatus.notRegistered.isEnabled)
    }

    func testStatusNotFoundIsDisabled() {
        XCTAssertFalse(LoginItemStatus.notFound.isEnabled)
    }

    // MARK: - Controller init

    func testInitReadsInitialStatusFromService() {
        let stub = makeStub(status: .enabled)
        let sut = LoginItemController(service: stub)
        XCTAssertEqual(sut.status, .enabled)
    }

    // MARK: - setEnabled(true)

    func testEnableCallsRegisterAndUpdatesStatus() {
        let stub = makeStub(status: .notRegistered)
        let sut = LoginItemController(service: stub)

        let ok = sut.setEnabled(true)

        XCTAssertTrue(ok)
        XCTAssertEqual(stub.registerCallCount, 1)
        XCTAssertEqual(stub.unregisterCallCount, 0)
        XCTAssertEqual(sut.status, .enabled)
    }

    func testEnableFailureReportsErrorAndKeepsStatusInSync() {
        let stub = makeStub(status: .notRegistered)
        stub.registerError = TestError.simulated
        var reportedMessage: String?
        var reportedDetails: String?
        let sut = LoginItemController(service: stub) { msg, details in
            reportedMessage = msg
            reportedDetails = details
        }

        let ok = sut.setEnabled(true)

        XCTAssertFalse(ok)
        XCTAssertEqual(sut.status, .notRegistered)
        XCTAssertEqual(reportedMessage, "Failed to register Launch at Login")
        XCTAssertNotNil(reportedDetails)
    }

    // MARK: - setEnabled(false)

    func testDisableCallsUnregisterAndUpdatesStatus() {
        let stub = makeStub(status: .enabled)
        let sut = LoginItemController(service: stub)

        let ok = sut.setEnabled(false)

        XCTAssertTrue(ok)
        XCTAssertEqual(stub.unregisterCallCount, 1)
        XCTAssertEqual(stub.registerCallCount, 0)
        XCTAssertEqual(sut.status, .notRegistered)
    }

    func testDisableFailureReportsError() {
        let stub = makeStub(status: .enabled)
        stub.unregisterError = TestError.simulated
        var reportedMessage: String?
        let sut = LoginItemController(service: stub) { msg, _ in
            reportedMessage = msg
        }

        let ok = sut.setEnabled(false)

        XCTAssertFalse(ok)
        XCTAssertEqual(reportedMessage, "Failed to unregister Launch at Login")
    }

    // MARK: - refresh

    func testRefreshPullsLatestStatus() {
        let stub = makeStub(status: .notRegistered)
        let sut = LoginItemController(service: stub)
        XCTAssertEqual(sut.status, .notRegistered)

        stub.status = .requiresApproval
        sut.refresh()

        XCTAssertEqual(sut.status, .requiresApproval)
    }

    // MARK: - onError reassignment

    func testOnErrorCanBeReassignedAfterInit() {
        let stub = makeStub(status: .notRegistered)
        stub.registerError = TestError.simulated
        let sut = LoginItemController(service: stub)

        var captured: String?
        sut.onError = { msg, _ in captured = msg }

        _ = sut.setEnabled(true)

        XCTAssertEqual(captured, "Failed to register Launch at Login")
    }

    // MARK: - Helpers

    private func makeStub(status: LoginItemStatus) -> StubLoginItemService {
        let stub = StubLoginItemService()
        stub.status = status
        return stub
    }

    private enum TestError: Error { case simulated }
}

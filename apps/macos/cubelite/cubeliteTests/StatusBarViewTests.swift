import XCTest

@testable import cubelite

final class StatusBarViewTests: XCTestCase {

    func testRefreshLabelMatchesTheDesktop() {
        XCTAssertEqual(StatusBarView.refreshLabel(interval: 0), "refresh off")
        XCTAssertEqual(StatusBarView.refreshLabel(interval: 60), "refresh 1m")
        XCTAssertEqual(StatusBarView.refreshLabel(interval: 15), "refresh 15s")
    }

    func testVersionLabelIsHiddenWhenUnknown() {
        XCTAssertEqual(StatusBarView.versionLabel("v1.30.2"), "k8s v1.30.2")
        XCTAssertNil(StatusBarView.versionLabel(nil))
        XCTAssertNil(StatusBarView.versionLabel(""))
    }

    func testWarningLabelPluralises() {
        XCTAssertNil(StatusBarView.warningLabel(count: 0))
        XCTAssertEqual(StatusBarView.warningLabel(count: 1), "1 warning")
        XCTAssertEqual(StatusBarView.warningLabel(count: 4), "4 warnings")
    }

    func testErrorLabelPluralises() {
        XCTAssertNil(StatusBarView.errorLabel(count: 0))
        XCTAssertEqual(StatusBarView.errorLabel(count: 1), "1 error")
        XCTAssertEqual(StatusBarView.errorLabel(count: 12), "12 errors")
    }
}

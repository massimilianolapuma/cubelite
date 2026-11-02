import XCTest

@testable import cubelite

/// The Overview stat tiles open the view that holds their evidence (#464).
final class OverviewStatTileTests: XCTestCase {

    func testTilesAreInDisplayOrder() {
        XCTAssertEqual(
            OverviewStatTile.allCases.map(\.title),
            ["Nodes", "Pods running", "Deploys healthy", "Warnings"])
    }

    func testEachTileTargetsItsEvidenceView() {
        XCTAssertEqual(OverviewStatTile.nodes.target, .nodes)
        XCTAssertEqual(OverviewStatTile.pods.target, .pods)
        XCTAssertEqual(OverviewStatTile.deployments.target, .deployments)
        XCTAssertEqual(OverviewStatTile.warnings.target, .events)
    }

    func testAccessibilityHintNamesTheTargetView() {
        XCTAssertEqual(
            OverviewStatTile.allCases.map(\.accessibilityHint),
            ["Opens Nodes", "Opens Pods", "Opens Deployments", "Opens Events"])
    }

    func testIdentifiersAreUnique() {
        let ids = OverviewStatTile.allCases.map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count)
    }
}

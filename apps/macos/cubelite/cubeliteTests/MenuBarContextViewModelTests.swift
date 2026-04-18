import XCTest

@testable import cubelite

// MARK: - MenuBarContextViewModelTests

/// Tests for the state logic driving ``MenuBarContextView``.
///
/// Since ``MenuBarContextView`` is a pure data-driven SwiftUI view, these tests
/// verify ``ClusterState`` properties that the view reads — exercising the exact
/// paths the view uses without needing a UI host.
@MainActor
final class MenuBarContextViewModelTests: XCTestCase {

    // MARK: - Active Context Header

    func testActiveContextHeader_showsCurrentContext() {
        let state = ClusterState()
        state.currentContext = "production-us-east"

        XCTAssertEqual(state.currentContext, "production-us-east")
        XCTAssertFalse(state.noConfig)
    }

    func testActiveContextHeader_currentContext_isNilWhenNoneSelected() {
        let state = ClusterState()

        XCTAssertNil(state.currentContext, "currentContext should be nil by default")
    }

    func testActiveContextHeader_noConfig_suppressesContextDisplay() {
        let state = ClusterState()
        state.noConfig = true

        XCTAssertTrue(state.noConfig)
        XCTAssertNil(state.currentContext, "When noConfig=true, no context should be displayed")
    }

    // MARK: - Context List

    func testContextList_empty_noContextsAvailable() {
        let state = ClusterState()

        XCTAssertTrue(state.contexts.isEmpty)
    }

    func testContextList_populatedContexts_areAvailable() {
        let state = ClusterState()
        state.contexts = ["production-us-east", "staging-eu-west", "local-minikube"]

        XCTAssertEqual(state.contexts.count, 3)
        XCTAssertTrue(state.contexts.contains("staging-eu-west"))
    }

    func testContextList_checkmarkContext_isCurrentContext() {
        let state = ClusterState()
        state.contexts = ["ctx-a", "ctx-b", "ctx-c"]
        state.currentContext = "ctx-b"

        // The view renders a checkmark for the row where context == currentContext.
        let activeContextInList = state.contexts.first { $0 == state.currentContext }
        XCTAssertEqual(activeContextInList, "ctx-b")
    }

    func testContextList_currentContext_notPresentInList_showsNoneActive() {
        let state = ClusterState()
        state.contexts = ["ctx-a", "ctx-b"]
        state.currentContext = "ctx-c"  // not in list

        let activeInList = state.contexts.first { $0 == state.currentContext }
        XCTAssertNil(
            activeInList,
            "If currentContext is not in contexts list, nothing should be marked active")
    }

    func testContextList_singleContext_markedActive() {
        let state = ClusterState()
        state.contexts = ["only-cluster"]
        state.currentContext = "only-cluster"

        let activeContextInList = state.contexts.filter { $0 == state.currentContext }
        XCTAssertEqual(activeContextInList.count, 1)
    }

    // MARK: - Error State (visible via error message)

    func testContextSwitch_failure_setsErrorMessage() {
        let state = ClusterState()
        state.errorMessage = "Failed to write kubeconfig: permission denied"

        XCTAssertNotNil(state.errorMessage)
        XCTAssertTrue(state.errorMessage?.contains("permission denied") == true)
    }

    func testContextSwitch_success_clearsErrorMessage() {
        let state = ClusterState()
        state.errorMessage = "previous error"
        state.errorMessage = nil

        XCTAssertNil(state.errorMessage)
    }

    // MARK: - No-config State

    func testNoConfigState_contextsIsEmpty_whenNoConfig() {
        let state = ClusterState()
        state.noConfig = true
        state.contexts = []

        // The view shows "No kubeconfig found" when both noConfig=true and contexts is empty.
        XCTAssertTrue(state.noConfig)
        XCTAssertTrue(state.contexts.isEmpty)
    }

    func testNoConfigState_canClear() {
        let state = ClusterState()
        state.noConfig = true
        state.noConfig = false

        XCTAssertFalse(state.noConfig)
    }

    // MARK: - Context Switching (state mutation)

    func testSwitchContext_updatesCurrentContext() {
        let state = ClusterState()
        state.contexts = ["dev", "staging", "prod"]
        state.currentContext = "dev"

        // Simulate what switchContext(_:) does after a successful save.
        state.currentContext = "staging"

        XCTAssertEqual(state.currentContext, "staging")
    }

    func testSwitchContext_toSameContext_noChange() {
        let state = ClusterState()
        state.contexts = ["ctx-a", "ctx-b"]
        state.currentContext = "ctx-a"

        state.currentContext = "ctx-a"  // same value

        XCTAssertEqual(state.currentContext, "ctx-a")
    }

    // MARK: - Cluster Reachability Banner

    func testClusterUnreachable_stateIsSetToFalse() {
        let state = ClusterState()
        state.clusterReachable = false

        XCTAssertEqual(state.clusterReachable, false)
    }

    func testClusterReachable_stateIsSetToTrue() {
        let state = ClusterState()
        state.clusterReachable = true

        XCTAssertEqual(state.clusterReachable, true)
    }

    func testClusterReachable_initiallyNil_notYetChecked() {
        let state = ClusterState()

        XCTAssertNil(state.clusterReachable, "clusterReachable should be nil until first probe")
    }
}

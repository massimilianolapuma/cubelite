import AppKit
import SwiftUI
import XCTest

@testable import cubelite

// MARK: - Grouped Pods table, rendered (#551)
//
// Hosts the real `PodListView` in a window and reads the backing table:
// Namespace column out while grouped, collapse redraws the rows, the
// selection survives collapsing, ← / → act on the selected row's group.

@MainActor
final class NamespaceGroupTableTests: XCTestCase {

    private var selected: PodInfo.ID? = "team-a/worker"

    private func host(_ prefs: ResourcePreferences) -> NSWindow {
        let state = ClusterState()
        state.selectedNamespace = nil
        state.pods = [
            PodInfo(name: "api", namespace: "team-a", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
            PodInfo(name: "worker", namespace: "team-a", phase: "Failed", ready: false, restarts: 3, creationTimestamp: nil),
            PodInfo(name: "coredns", namespace: "kube-system", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
            PodInfo(name: "batch", namespace: "team-b", phase: "Running", ready: true, restarts: 0, creationTimestamp: nil),
        ]
        let selection = Binding<PodInfo.ID?>(get: { self.selected }, set: { self.selected = $0 })
        let view = PodListView(selectedPodID: selection)
            .environment(state)
            .environment(prefs)
            .frame(width: 900, height: 360)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 360), styleMask: [.titled],
            backing: .buffered, defer: false)
        window.contentView = NSHostingView(rootView: view)
        window.makeKeyAndOrderFront(nil)
        return window
    }

    private func table(in view: NSView?) -> NSTableView? {
        guard let view else { return nil }
        if let table = view as? NSTableView { return table }
        for sub in view.subviews { if let table = table(in: sub) { return table } }
        return nil
    }

    /// Polls (up to 5 s) until `condition` holds on the window's table.
    private func waitFor(
        _ window: NSWindow, _ what: String, _ condition: (NSTableView) -> Bool
    ) async throws -> NSTableView {
        for _ in 0..<50 {
            window.contentView?.layoutSubtreeIfNeeded()
            if let table = table(in: window.contentView), condition(table) { return table }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let table = try XCTUnwrap(table(in: window.contentView), "no table")
        XCTFail("timed out: \(what) (rows \(table.numberOfRows))")
        return table
    }

    private func titles(_ table: NSTableView) -> [String] { table.tableColumns.map(\.title) }

    func testFlatTableKeepsTheNamespaceColumn() async throws {
        let prefs = ResourcePreferences(defaults: TestDefaults.fresh(for: Self.self))
        let window = host(prefs)
        defer { window.orderOut(nil) }
        let table = try await waitFor(window, "4 flat rows") { $0.numberOfRows == 4 }
        XCTAssertTrue(titles(table).contains("Namespace"))
    }

    func testGroupedTableCollapsesAndKeepsTheSelection() async throws {
        let prefs = ResourcePreferences(defaults: TestDefaults.fresh(for: Self.self))
        prefs.groupByNamespace = true
        prefs.toggleCollapsed("kube-system")
        let window = host(prefs)
        defer { window.orderOut(nil) }

        // 3 headers + team-a (2) + team-b (1); kube-system collapsed.
        let table = try await waitFor(window, "6 grouped rows") { $0.numberOfRows == 6 }
        XCTAssertFalse(titles(table).contains("Namespace"), "the header names the namespace")

        prefs.toggleCollapsed("team-a")  // the selected row's group
        _ = try await waitFor(window, "team-a collapsed") { $0.numberOfRows == 4 }
        XCTAssertEqual(selected, "team-a/worker", "collapsing keeps the selection")

        prefs.toggleCollapsed("team-a")
        _ = try await waitFor(window, "team-a expanded") { $0.numberOfRows == 6 }
        XCTAssertEqual(selected, "team-a/worker")
    }

    func testArrowKeysCollapseAndExpandTheSelectedRowsGroup() async throws {
        let prefs = ResourcePreferences(defaults: TestDefaults.fresh(for: Self.self))
        prefs.groupByNamespace = true
        let window = host(prefs)
        defer { window.orderOut(nil) }
        let table = try await waitFor(window, "7 grouped rows") { $0.numberOfRows == 7 }
        window.makeFirstResponder(table)

        func press(_ keyCode: UInt16, _ character: Int) throws {
            let chars = String(UnicodeScalar(character).map(Character.init) ?? " ")
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                let event = try XCTUnwrap(
                    NSEvent.keyEvent(
                        with: type, location: .zero, modifierFlags: [.numericPad, .function],
                        timestamp: ProcessInfo.processInfo.systemUptime,
                        windowNumber: window.windowNumber, context: nil, characters: chars,
                        charactersIgnoringModifiers: chars, isARepeat: false, keyCode: keyCode))
                window.sendEvent(event)
            }
        }

        try press(123, NSLeftArrowFunctionKey)
        _ = try await waitFor(window, "← collapses team-a") { $0.numberOfRows == 5 }
        XCTAssertTrue(prefs.isCollapsed("team-a"))
        XCTAssertEqual(selected, "team-a/worker")

        try press(124, NSRightArrowFunctionKey)
        _ = try await waitFor(window, "→ expands team-a") { $0.numberOfRows == 7 }
        XCTAssertFalse(prefs.isCollapsed("team-a"))
    }
}

import XCTest

@testable import cubelite

// MARK: - Kubeconfig Watcher Tests
//
// Covers:
// - Path resolver: tilde expansion, $KUBECONFIG parsing, deduplication
// - Debouncer: bursts collapse into a single fire after the quiescence window
// - Integration: writing to a temp file fires the reload callback within 2 s

final class KubeconfigWatcherTests: XCTestCase {

    // MARK: - Path Resolver

    func testResolveWatchedPaths_defaultsToHomeKubeConfig_whenEnvUnset() {
        let home = URL(fileURLWithPath: "/Users/test")
        let paths = KubeconfigWatcher.resolveWatchedPaths(
            environment: [:],
            homeDirectory: home
        )
        XCTAssertEqual(paths.map(\.path), ["/Users/test/.kube/config"])
    }

    func testResolveWatchedPaths_parsesColonSeparatedKUBECONFIG() {
        let home = URL(fileURLWithPath: "/Users/test")
        let paths = KubeconfigWatcher.resolveWatchedPaths(
            environment: ["KUBECONFIG": "/etc/kube/a:/etc/kube/b:/etc/kube/c"],
            homeDirectory: home
        )
        XCTAssertEqual(paths.map(\.path), [
            "/etc/kube/a",
            "/etc/kube/b",
            "/etc/kube/c",
        ])
    }

    func testResolveWatchedPaths_expandsTilde() {
        let home = URL(fileURLWithPath: "/Users/alice")
        let paths = KubeconfigWatcher.resolveWatchedPaths(
            environment: ["KUBECONFIG": "~/.kube/config:~/work/k8s.yaml"],
            homeDirectory: home
        )
        XCTAssertEqual(paths.map(\.path), [
            "/Users/alice/.kube/config",
            "/Users/alice/work/k8s.yaml",
        ])
    }

    func testResolveWatchedPaths_dropsEmptyEntriesAndDuplicates() {
        let home = URL(fileURLWithPath: "/Users/test")
        let paths = KubeconfigWatcher.resolveWatchedPaths(
            environment: ["KUBECONFIG": "/a::/a:/b:"],
            homeDirectory: home
        )
        XCTAssertEqual(paths.map(\.path), ["/a", "/b"])
    }

    func testExpandToWatchTargets_filtersMissingFilesUpToParentDirectory() throws {
        let fm = FileManager.default
        let tempDir = fm.temporaryDirectory.appendingPathComponent(
            "watcher-targets-\(UUID().uuidString)"
        )
        try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tempDir) }

        let existing = tempDir.appendingPathComponent("config")
        try Data("apiVersion: v1\nkind: Config\n".utf8).write(to: existing)

        let missing = tempDir.appendingPathComponent("future-config")
        let parentMissing = URL(fileURLWithPath: "/no/such/dir/at/all/cfg")

        let targets = KubeconfigWatcher.expandToWatchTargets([existing, missing, parentMissing])

        XCTAssertTrue(targets.contains(existing.path))
        XCTAssertTrue(targets.contains(tempDir.path))
        XCTAssertFalse(targets.contains(parentMissing.path))
        XCTAssertFalse(targets.contains(parentMissing.deletingLastPathComponent().path))
    }

    // MARK: - Debouncer

    func testDebouncer_collapsesFiveRapidEventsIntoOneFire() {
        let debouncer = Debouncer(interval: 0.25)
        let expectation = expectation(description: "debounced fire")
        let counter = AtomicCounter()

        for _ in 0..<5 {
            debouncer.schedule {
                counter.increment()
                expectation.fulfill()
            }
        }

        wait(for: [expectation], timeout: 2.0)
        // Wait a little more to ensure no extra fires arrive after the first.
        let extra = XCTestExpectation(description: "no extra fires")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { extra.fulfill() }
        wait(for: [extra], timeout: 1.0)

        XCTAssertEqual(counter.value, 1, "Debouncer must collapse rapid events into a single fire")
    }

    func testDebouncer_cancelPreventsFire() {
        let debouncer = Debouncer(interval: 0.10)
        let counter = AtomicCounter()
        debouncer.schedule { counter.increment() }
        debouncer.cancel()

        let waited = XCTestExpectation(description: "cancel window")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) { waited.fulfill() }
        wait(for: [waited], timeout: 1.0)

        XCTAssertEqual(counter.value, 0)
    }

    // MARK: - Integration: FSEvents fires on file write

    @MainActor
    func testWatcher_firesCallbackWhenWatchedFileIsWritten() async throws {
        let fm = FileManager.default
        let tempDir = fm.temporaryDirectory.appendingPathComponent(
            "watcher-int-\(UUID().uuidString)"
        )
        try fm.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tempDir) }

        let configPath = tempDir.appendingPathComponent("config")
        try Data("apiVersion: v1\nkind: Config\ncontexts: []\n".utf8).write(to: configPath)

        let expectation = expectation(description: "watcher reload callback fires")
        expectation.assertForOverFulfill = false

        let watcher = KubeconfigWatcher(debounceInterval: 0.20) {
            expectation.fulfill()
        }
        watcher.start(paths: [configPath])
        defer { watcher.stop() }

        // Give FSEvents a moment to attach before the first write.
        try await Task.sleep(nanoseconds: 200_000_000)

        // Atomic write — mimics editors and `kubectl config use-context`.
        try Data("apiVersion: v1\nkind: Config\ncontexts: []\n# updated\n".utf8)
            .write(to: configPath, options: .atomic)

        await fulfillment(of: [expectation], timeout: 2.0)
    }
}

// MARK: - Helpers

/// Tiny lock-protected counter so multiple debouncer fires (if any) are seen.
private final class AtomicCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = 0
    var value: Int {
        lock.lock(); defer { lock.unlock() }
        return _value
    }
    func increment() {
        lock.lock(); defer { lock.unlock() }
        _value += 1
    }
}

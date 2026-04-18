import XCTest

@testable import cubelite

// MARK: - Multi-Config Session Tests

/// Tests for multi-kubeconfig file scenarios, verifying that ``KubeAPIService``
/// correctly handles session lifecycle when configuration paths change.
///
/// Regression tests for: "NSGenericException: Task created in a session that
/// has been invalidated" — triggered when adding a second kubeconfig file via
/// Preferences and then browsing resources.
final class MultiConfigSessionTests: XCTestCase {

    private var kubeconfigService: KubeconfigService!

    override func setUp() async throws {
        kubeconfigService = KubeconfigService()
    }

    // MARK: - Multi-File Config Merge

    /// Adding a second config file preserves the original contexts.
    func testAddSecondConfig_preservesOriginalContexts() async throws {
        let yaml1 = minimalYAML(
            context: "ctx-original",
            cluster: "cluster-original",
            server: "https://original.example.com:6443"
        )
        let yaml2 = minimalYAML(
            context: "ctx-added",
            cluster: "cluster-added",
            server: "https://added.example.com:6443"
        )

        let url1 = try temporaryFile(contents: yaml1)
        let url2 = try temporaryFile(contents: yaml2)
        defer {
            try? FileManager.default.removeItem(at: url1)
            try? FileManager.default.removeItem(at: url2)
        }

        // Simulate initial load with single file
        let config1 = try await kubeconfigService.loadFromPaths([url1])
        XCTAssertEqual(config1.contexts, ["ctx-original"])
        XCTAssertEqual(config1.currentContext, "ctx-original")

        // Simulate adding second file (as Preferences → Add File does)
        let config2 = try await kubeconfigService.loadFromPaths([url1, url2])
        XCTAssertTrue(
            config2.contexts.contains("ctx-original"),
            "Original context must survive after adding second config"
        )
        XCTAssertTrue(
            config2.contexts.contains("ctx-added"),
            "New context from second file must appear"
        )
        XCTAssertEqual(
            config2.currentContext, "ctx-original",
            "First file's current-context must win"
        )
    }

    /// Reconfiguring custom paths and reloading merges both files.
    func testConfigure_thenLoad_mergesBothFiles() async throws {
        let yaml1 = minimalYAML(
            context: "ctx-a",
            cluster: "cluster-a",
            server: "https://a.example.com:6443"
        )
        let yaml2 = minimalYAML(
            context: "ctx-b",
            cluster: "cluster-b",
            server: "https://b.example.com:6443"
        )

        let url1 = try temporaryFile(contents: yaml1)
        let url2 = try temporaryFile(contents: yaml2)
        defer {
            try? FileManager.default.removeItem(at: url1)
            try? FileManager.default.removeItem(at: url2)
        }

        // Start with single path
        await kubeconfigService.configure(paths: [url1])
        let config1 = try await kubeconfigService.load()
        XCTAssertEqual(config1.contexts.count, 1)

        // Reconfigure with both paths (simulates onChange in CubeliteApp)
        await kubeconfigService.configure(paths: [url1, url2])
        let config2 = try await kubeconfigService.load()
        XCTAssertEqual(config2.contexts.count, 2)
        XCTAssertTrue(config2.contexts.contains("ctx-a"))
        XCTAssertTrue(config2.contexts.contains("ctx-b"))
    }

    // MARK: - Session Invalidation Safety

    /// After invalidateSession(), the service does not crash when fetching.
    ///
    /// Regression: the old code kept a reference to the invalidated URLSession
    /// in `cachedSessionEntry` when `makeSession()` threw, causing
    /// "Task created in a session that has been invalidated" on the next fetch.
    func testInvalidateSession_thenFetch_doesNotCrash() async throws {
        let yaml = minimalYAML(
            context: "ctx-test",
            cluster: "cluster-test",
            server: "https://localhost:1"
        )
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        await kubeconfigService.configure(paths: [url])
        let sut = KubeAPIService(kubeconfigService: kubeconfigService)

        // First fetch attempt — will fail (no server running) but creates session
        do {
            _ = try await sut.listNamespaces()
        } catch {
            // Expected: cluster unreachable
        }

        // Invalidate session (simulates config change)
        await sut.invalidateSession()

        // Second fetch — must NOT crash with "session invalidated"
        // It should fail with a connection error, not an NSGenericException
        do {
            _ = try await sut.listNamespaces()
        } catch let error as CubeliteError {
            // Expected: clusterUnreachable or clientError — NOT a session invalidation crash
            switch error {
            case .clusterUnreachable, .clientError, .tlsError:
                break  // OK — expected network/TLS error
            default:
                XCTFail("Unexpected CubeliteError after session invalidation: \(error)")
            }
        } catch {
            // Any non-CubeliteError (e.g., NSGenericException) is the regression
            XCTFail("Session invalidation crash regression: \(error)")
        }
    }

    /// Switching between contexts on different clusters after config reload.
    ///
    /// Simulates: user adds second config → selects context from new cluster →
    /// then switches back to original context. The session must be recreated
    /// correctly without crashing.
    func testSwitchContexts_acrossConfigs_afterReload() async throws {
        let yaml1 = minimalYAML(
            context: "ctx-alpha",
            cluster: "cluster-alpha",
            server: "https://localhost:1"
        )
        let yaml2 = minimalYAML(
            context: "ctx-beta",
            cluster: "cluster-beta",
            server: "https://localhost:2"
        )

        let url1 = try temporaryFile(contents: yaml1)
        let url2 = try temporaryFile(contents: yaml2)
        defer {
            try? FileManager.default.removeItem(at: url1)
            try? FileManager.default.removeItem(at: url2)
        }

        // Start with single config
        await kubeconfigService.configure(paths: [url1])
        let sut = KubeAPIService(kubeconfigService: kubeconfigService)

        // Fetch on context alpha — creates session for localhost:1
        do {
            _ = try await sut.listNamespaces(inContext: "ctx-alpha")
        } catch {
            // Expected: cluster unreachable
        }

        // Simulate adding second config
        await kubeconfigService.configure(paths: [url1, url2])
        await sut.invalidateSession()

        // Fetch on context beta — different server (localhost:2)
        do {
            _ = try await sut.listNamespaces(inContext: "ctx-beta")
        } catch let error as CubeliteError {
            switch error {
            case .clusterUnreachable, .clientError, .tlsError:
                break  // Expected
            default:
                XCTFail("Unexpected error on beta context: \(error)")
            }
        } catch {
            XCTFail("Session invalidation crash on context switch: \(error)")
        }

        // Switch back to context alpha — must create new session for localhost:1
        do {
            _ = try await sut.listNamespaces(inContext: "ctx-alpha")
        } catch let error as CubeliteError {
            switch error {
            case .clusterUnreachable, .clientError, .tlsError:
                break  // Expected
            default:
                XCTFail("Unexpected error switching back to alpha: \(error)")
            }
        } catch {
            XCTFail("Session crash on switch back: \(error)")
        }
    }

    /// Double invalidation does not crash.
    func testDoubleInvalidateSession_doesNotCrash() async throws {
        let yaml = minimalYAML(
            context: "ctx-test",
            cluster: "cluster-test",
            server: "https://localhost:1"
        )
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        await kubeconfigService.configure(paths: [url])
        let sut = KubeAPIService(kubeconfigService: kubeconfigService)

        // Create a session by attempting a fetch
        do { _ = try await sut.listNamespaces() } catch { /* expected */  }

        // Double invalidation — must not crash
        await sut.invalidateSession()
        await sut.invalidateSession()

        // Must still be usable after double invalidation
        do { _ = try await sut.listNamespaces() } catch {
            // Expected: network error, not crash
        }
    }

    // MARK: - Helpers

    private func temporaryFile(contents: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-multiconfig-\(UUID().uuidString).yaml")
        try contents.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func minimalYAML(context: String, cluster: String, server: String) -> String {
        """
        apiVersion: v1
        kind: Config
        current-context: \(context)
        contexts:
        - name: \(context)
          context:
            cluster: \(cluster)
            user: user-\(context)
            namespace: default
        clusters:
        - name: \(cluster)
          cluster:
            server: \(server)
            insecure-skip-tls-verify: true
        users:
        - name: user-\(context)
          user:
            token: token-for-\(context)
        """
    }
}

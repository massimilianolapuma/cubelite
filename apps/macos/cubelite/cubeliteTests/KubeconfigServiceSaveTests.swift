import XCTest

@testable import cubelite

// MARK: - KubeconfigServiceSaveTests

/// Tests for ``KubeconfigService/save(_:)`` and the full load → mutate → save → reload cycle.
final class KubeconfigServiceSaveTests: XCTestCase {

    private let sut = KubeconfigService()

    // MARK: - save: basic round-trip

    /// Verifies that saving a config and reloading it from the same file returns the same data.
    func testSave_loadRoundTrip_preservesContexts() async throws {
        let yaml = minimalYAML(
            context: "round-trip-ctx", cluster: "cluster-rt", server: "https://rt.example.com")
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try await sut.loadFromPaths([url])
        try await sut.save(config)

        let reloaded = try await sut.loadFromPaths([url])
        XCTAssertEqual(reloaded.contexts, config.contexts)
        XCTAssertEqual(reloaded.currentContext, config.currentContext)
    }

    /// Verifies that saving after `setActiveContext` persists the new active context.
    func testSave_afterSetActiveContext_persistsNewContext() async throws {
        let yaml = twoContextYAML()
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        var config = try await sut.loadFromPaths([url])
        XCTAssertEqual(config.currentContext, "ctx-a")

        try await sut.setActiveContext("ctx-b", in: &config)
        try await sut.save(config)

        let reloaded = try await sut.loadFromPaths([url])
        XCTAssertEqual(
            reloaded.currentContext, "ctx-b",
            "Reloaded config should reflect the saved context switch")
    }

    /// Verifies that all context names survive a save/reload round-trip.
    func testSave_twoContexts_bothPresentAfterReload() async throws {
        let yaml = twoContextYAML()
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try await sut.loadFromPaths([url])
        try await sut.save(config)

        let reloaded = try await sut.loadFromPaths([url])
        XCTAssertTrue(reloaded.contexts.contains("ctx-a"))
        XCTAssertTrue(reloaded.contexts.contains("ctx-b"))
        XCTAssertEqual(reloaded.contexts.count, 2)
    }

    // MARK: - save: writes to first path only

    /// Verifies that when a merged config has multiple paths, save writes to the first file.
    func testSave_multipleSourcePaths_writesToFirstFile() async throws {
        let yaml1 = minimalYAML(
            context: "ctx-a", cluster: "cluster-a", server: "https://a.example.com")
        let yaml2 = minimalYAML(
            context: "ctx-b", cluster: "cluster-b", server: "https://b.example.com")
        let url1 = try temporaryFile(contents: yaml1)
        let url2 = try temporaryFile(contents: yaml2)
        defer {
            try? FileManager.default.removeItem(at: url1)
            try? FileManager.default.removeItem(at: url2)
        }

        var config = try await sut.loadFromPaths([url1, url2])
        try await sut.setActiveContext("ctx-b", in: &config)
        try await sut.save(config)

        // Reload from the first file only — it should have ctx-a as stored but current-context = ctx-b
        let reloadedFirst = try await sut.loadFromPaths([url1])
        XCTAssertEqual(
            reloadedFirst.currentContext, "ctx-b",
            "First file should have updated current-context")
    }

    // MARK: - save: error on no paths

    /// Verifies that saving a config with no paths throws an ioError.
    func testSave_noPaths_throwsIOError() async throws {
        let yaml = minimalYAML(context: "ctx", cluster: "cluster", server: "https://example.com")
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try await sut.loadFromPaths([url])
        // Simulate a config with no paths by removing path information.
        // We model this by creating a KubeConfig with empty paths.
        let emptyPathConfig = KubeConfig(
            contexts: config.contexts,
            currentContext: config.currentContext,
            raw: config.raw,
            paths: []
        )

        do {
            try await sut.save(emptyPathConfig)
            XCTFail("Expected ioError for empty paths")
        } catch let error as CubeliteError {
            if case .ioError = error {
                // Expected
            } else {
                XCTFail("Expected CubeliteError.ioError, got: \(error)")
            }
        }
    }

    // MARK: - setActiveContext + save: idempotent

    /// Switching to the already-active context and saving is a no-op in terms of outcome.
    func testSetActiveContext_sameContext_thenSave_isIdempotent() async throws {
        let yaml = minimalYAML(
            context: "ctx-only", cluster: "cluster", server: "https://127.0.0.1:6443")
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        var config = try await sut.loadFromPaths([url])
        let originalCurrent = config.currentContext

        try await sut.setActiveContext("ctx-only", in: &config)
        try await sut.save(config)

        let reloaded = try await sut.loadFromPaths([url])
        XCTAssertEqual(reloaded.currentContext, originalCurrent)
    }

    // MARK: - Helpers

    private func temporaryFile(contents: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-save-test-\(UUID().uuidString).yaml")
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
        users:
        - name: user-\(context)
          user:
            token: token-for-\(context)
        """
    }

    private func twoContextYAML() -> String {
        """
        apiVersion: v1
        kind: Config
        current-context: ctx-a
        contexts:
        - name: ctx-a
          context:
            cluster: cluster-a
            user: user-a
        - name: ctx-b
          context:
            cluster: cluster-b
            user: user-b
        clusters:
        - name: cluster-a
          cluster:
            server: https://k8s-test-a.example
        - name: cluster-b
          cluster:
            server: https://k8s-test-b.example
        users:
        - name: user-a
          user:
            token: token-a
        - name: user-b
          user:
            token: token-b
        """
    }
}

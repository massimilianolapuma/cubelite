import XCTest
@testable import cubelite

// MARK: - FirstLaunchTests

final class FirstLaunchTests: XCTestCase {

    private let sut = KubeconfigService()

    // MARK: - Kubeconfig Detection

    /// Verifies that `loadFromPaths` succeeds and returns at least one context
    /// when a valid kubeconfig file is present on disk.
    func testKubeconfigDetection_existingFile_returnsContexts() async throws {
        let yaml = minimalYAML(context: "prod-ctx", cluster: "prod-cluster", server: "https://k8s.example.com")
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try await sut.loadFromPaths([url])

        XCTAssertFalse(config.contexts.isEmpty, "At least one context should be returned")
        XCTAssertEqual(config.contexts.first, "prod-ctx")
        XCTAssertEqual(config.currentContext, "prod-ctx")
    }

    /// Verifies that a non-existent kubeconfig path throws an error
    /// (simulating an absent ~/.kube/config on first launch).
    func testKubeconfigDetection_missingFile_throwsError() async throws {
        let url = URL(fileURLWithPath: "/tmp/cubelite-firstlaunch-nonexistent-\(UUID().uuidString).yaml")

        do {
            _ = try await sut.loadFromPaths([url])
            XCTFail("Expected an error for a missing kubeconfig path")
        } catch {
            // Any error signals that the file was not loadable — expected.
            XCTAssertNotNil(error)
        }
    }

    /// Verifies that multiple contexts in a kubeconfig are all reported
    /// so the onboarding screen can display the correct count.
    func testKubeconfigDetection_multipleContexts_allReported() async throws {
        let yaml = twoContextYAML()
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try await sut.loadFromPaths([url])

        XCTAssertEqual(config.contexts.count, 2, "Both contexts should be reported")
        XCTAssertTrue(config.contexts.contains("ctx-a"))
        XCTAssertTrue(config.contexts.contains("ctx-b"))
    }

    /// Verifies that a single-context kubeconfig produces a count of 1,
    /// which the onboarding card renders as "1 context discovered".
    func testKubeconfigDetection_singleContext_countIsOne() async throws {
        let yaml = minimalYAML(context: "only-ctx", cluster: "only-cluster", server: "https://127.0.0.1:6443")
        let url = try temporaryFile(contents: yaml)
        defer { try? FileManager.default.removeItem(at: url) }

        let config = try await sut.loadFromPaths([url])

        XCTAssertEqual(config.contexts.count, 1)
    }

    // MARK: - Onboarding Completion Flag

    /// Verifies that the "hasCompletedOnboarding" key can be written to
    /// UserDefaults and persists its value.
    func testOnboardingFlag_writingTrue_persists() {
        let key = "hasCompletedOnboarding"
        let defaults = UserDefaults.standard
        let original = defaults.bool(forKey: key)
        defer { defaults.set(original, forKey: key) }

        defaults.set(true, forKey: key)

        XCTAssertTrue(defaults.bool(forKey: key))
    }

    /// Verifies that a brand-new UserDefaults key returns `false` by default,
    /// matching the expected initial state for first-time users.
    func testOnboardingFlag_freshKey_defaultsToFalse() {
        let key = "hasCompletedOnboarding.test.\(UUID().uuidString)"
        let defaults = UserDefaults.standard
        defer { defaults.removeObject(forKey: key) }

        XCTAssertFalse(defaults.bool(forKey: key), "A key that has never been written should default to false")
    }

    /// Verifies round-trip: writing false then true reflects both states.
    func testOnboardingFlag_toggle_roundTrip() {
        let key = "hasCompletedOnboarding.test.\(UUID().uuidString)"
        let defaults = UserDefaults.standard
        defer { defaults.removeObject(forKey: key) }

        defaults.set(false, forKey: key)
        XCTAssertFalse(defaults.bool(forKey: key))

        defaults.set(true, forKey: key)
        XCTAssertTrue(defaults.bool(forKey: key))
    }

    // MARK: - Feature Highlights Content

    /// Verifies that the features list always contains exactly three items.
    func testFeatureHighlights_hasThreeItems() {
        XCTAssertEqual(FirstLaunchView.featureHighlights.count, 3)
    }

    /// Verifies that context discovery is mentioned in the feature highlights.
    func testFeatureHighlights_mentionsContextDiscovery() {
        let labels = FirstLaunchView.featureHighlights.map(\.label)

        XCTAssertTrue(
            labels.contains(where: { $0.localizedCaseInsensitiveContains("contexts") }),
            "Feature list should mention Kubernetes contexts"
        )
    }

    /// Verifies that menu bar integration is mentioned in the feature highlights.
    func testFeatureHighlights_mentionsMenuBar() {
        let labels = FirstLaunchView.featureHighlights.map(\.label)

        XCTAssertTrue(
            labels.contains(where: { $0.localizedCaseInsensitiveContains("menu bar") }),
            "Feature list should mention native macOS menu bar"
        )
    }

    /// Verifies that monitoring (pods/deployments) is mentioned in the feature highlights.
    func testFeatureHighlights_mentionsMonitoring() {
        let labels = FirstLaunchView.featureHighlights.map(\.label)

        XCTAssertTrue(
            labels.contains(where: {
                $0.localizedCaseInsensitiveContains("pods") ||
                $0.localizedCaseInsensitiveContains("deployments") ||
                $0.localizedCaseInsensitiveContains("monitor")
            }),
            "Feature list should mention resource monitoring"
        )
    }

    /// Verifies every FeatureItem has a non-empty icon and label.
    func testFeatureHighlights_allItemsHaveIconAndLabel() {
        for item in FirstLaunchView.featureHighlights {
            XCTAssertFalse(item.icon.isEmpty, "Feature icon should not be empty")
            XCTAssertFalse(item.label.isEmpty, "Feature label should not be empty")
        }
    }

    // MARK: - Helpers

    private func temporaryFile(contents: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-firstlaunch-test-\(UUID().uuidString).yaml")
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

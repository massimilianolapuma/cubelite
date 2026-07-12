import XCTest

/// End-to-end flows against a mock kubeconfig (no live cluster needed).
///
/// Infrastructure: each test writes a fixture kubeconfig with two contexts
/// pointing at an unreachable localhost server and injects it via the
/// `KUBECONFIG` environment variable; onboarding state is driven through
/// the UserDefaults argument domain (`-hasCompletedOnboarding`).
@MainActor
final class CubeliteE2ETests: XCTestCase {

    private var app: XCUIApplication!
    private var kubeconfigURL: URL!

    override func setUp() async throws {
        continueAfterFailure = false
        kubeconfigURL = try Self.writeFixtureKubeconfig()
        app = XCUIApplication()
        app.launchEnvironment["KUBECONFIG"] = kubeconfigURL.path
    }

    override func tearDown() async throws {
        app = nil
        if let kubeconfigURL {
            try? FileManager.default.removeItem(at: kubeconfigURL)
        }
    }

    // MARK: - Fixture

    /// Two contexts against an unreachable local server: discovery and all
    /// UI flows work, network calls fail fast and must be handled.
    private static func writeFixtureKubeconfig() throws -> URL {
        let yaml = """
            apiVersion: v1
            kind: Config
            current-context: prod-fixture
            contexts:
              - name: prod-fixture
                context: { cluster: prod, user: fixture-user, namespace: default }
              - name: staging-fixture
                context: { cluster: staging, user: fixture-user, namespace: default }
            clusters:
              - name: prod
                cluster: { server: "https://127.0.0.1:59999" }
              - name: staging
                cluster: { server: "https://127.0.0.1:59998" }
            users:
              - name: fixture-user
                user:
                  token: fixture-token
            """
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cubelite-e2e-\(UUID().uuidString).yaml")
        try yaml.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func launchPastOnboarding() {
        app.launchArguments += ["-hasCompletedOnboarding", "YES"]
        app.launch()
    }

    // MARK: - First launch

    func testFirstLaunch_discoversFixtureContextsAndCompletes() throws {
        app.launchArguments += ["-hasCompletedOnboarding", "NO"]
        app.launch()

        XCTAssertTrue(
            app.staticTexts["Welcome to CubeLite"].waitForExistence(timeout: 5),
            "Onboarding should greet on first launch")
        XCTAssertTrue(
            app.staticTexts["2 contexts discovered"].waitForExistence(timeout: 5),
            "Fixture kubeconfig contexts should be discovered")

        app.buttons["Get Started"].click()
        XCTAssertTrue(
            app.buttons["rail-all-clusters"].waitForExistence(timeout: 5),
            "Completing onboarding should land on the unified shell")
    }

    // MARK: - Shell

    func testShell_railListsFixtureContexts() throws {
        launchPastOnboarding()

        XCTAssertTrue(
            app.buttons["rail-context-prod-fixture"].waitForExistence(timeout: 5),
            "Rail should show the first fixture context")
        XCTAssertTrue(
            app.buttons["rail-context-staging-fixture"].exists,
            "Rail should show the second fixture context")
        XCTAssertTrue(
            app.staticTexts["WORKLOADS"].exists,
            "Unified sidebar sections should render")
    }

    func testShell_selectingClusterShowsItInHeader() throws {
        launchPastOnboarding()

        let avatar = app.buttons["rail-context-staging-fixture"]
        XCTAssertTrue(avatar.waitForExistence(timeout: 5))
        avatar.click()

        XCTAssertTrue(
            app.staticTexts["staging-fixture"].waitForExistence(timeout: 5),
            "Header should show the selected context even when unreachable")
    }

    func testShell_allClustersDashboardOpens() throws {
        launchPastOnboarding()

        let home = app.buttons["rail-all-clusters"]
        XCTAssertTrue(home.waitForExistence(timeout: 5))
        home.click()

        XCTAssertTrue(
            app.staticTexts["All Clusters"].waitForExistence(timeout: 5),
            "All Clusters dashboard should open from the rail home button")
    }

    // MARK: - Command palette

    func testPalette_opensWithCmdKAndClosesWithEscape() throws {
        launchPastOnboarding()
        XCTAssertTrue(app.buttons["rail-all-clusters"].waitForExistence(timeout: 5))

        app.typeKey("k", modifierFlags: .command)
        let input = app.textFields["palette-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5), "Cmd+K should open the palette")

        app.typeKey(.escape, modifierFlags: [])
        let gone = XCTWaiter.wait(
            for: [
                XCTNSPredicateExpectation(
                    predicate: NSPredicate(format: "exists == false"), object: input)
            ],
            timeout: 5)
        XCTAssertEqual(gone, .completed, "Escape should close the palette")
    }

    func testPalette_filtersFixtureContexts() throws {
        launchPastOnboarding()
        XCTAssertTrue(app.buttons["rail-all-clusters"].waitForExistence(timeout: 5))

        app.typeKey("k", modifierFlags: .command)
        let input = app.textFields["palette-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.typeText("staging")

        XCTAssertTrue(
            app.staticTexts["staging-fixture"].waitForExistence(timeout: 5),
            "Palette should list the matching fixture context")
    }
}

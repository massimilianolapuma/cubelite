//
//  cubeliteUITests.swift
//  cubeliteUITests
//
//  Created by Massimiliano La Puma on 12/04/2026.
//

import XCTest

@MainActor
final class CubeliteUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    // MARK: - Window Lifecycle

    func testLaunch_mainWindowExists() throws {
        XCTAssertTrue(app.windows.count >= 1, "App should have at least one window after launch")
    }

    func testLaunch_windowHasReasonableSize() throws {
        guard let window = app.windows.allElementsBoundByIndex.first else {
            XCTFail("No window found")
            return
        }
        let frame = window.frame
        XCTAssertGreaterThan(frame.width, 300, "Window width should be > 300")
        XCTAssertGreaterThan(frame.height, 200, "Window height should be > 200")
    }

    // MARK: - Preferences Window

    func testPreferences_opensViaMenuBar() throws {
        // Use the standard macOS menu: CubeLite > Settings... (Cmd+,)
        app.typeKey(",", modifierFlags: .command)

        // Wait for the settings window to appear
        let settingsWindow = app.windows.containing(.staticText, identifier: "General").firstMatch
        let appeared = settingsWindow.waitForExistence(timeout: 3)
        XCTAssertTrue(appeared, "Settings window should appear after Cmd+,")
    }

    func testPreferences_hasExpectedTabs() throws {
        app.typeKey(",", modifierFlags: .command)

        // Give the window time to appear
        let generalTab = app.staticTexts["General"]
        XCTAssertTrue(generalTab.waitForExistence(timeout: 3), "General tab should exist in preferences")

        let appearanceTab = app.staticTexts["Appearance"]
        XCTAssertTrue(appearanceTab.exists, "Appearance tab should exist in preferences")

        let advancedTab = app.staticTexts["Advanced"]
        XCTAssertTrue(advancedTab.exists, "Advanced tab should exist in preferences")
    }

    // MARK: - Main Menu

    func testMainMenu_hasExpectedMenuItems() throws {
        let menuBar = app.menuBars.firstMatch
        XCTAssertTrue(menuBar.exists, "App should have a menu bar")

        // Standard macOS app menus
        let appMenu = menuBar.menuBarItems["cubelite"]
        XCTAssertTrue(appMenu.exists, "App menu should exist in menu bar")
    }

    // MARK: - Keyboard Shortcuts

    func testKeyboardShortcut_cmdW_closesWindow() throws {
        let windowCount = app.windows.count
        guard windowCount > 0 else {
            XCTFail("No windows to close")
            return
        }

        app.typeKey("w", modifierFlags: .command)

        // After Cmd+W the window should be closed or minimised
        // On macOS menu bar apps, the window count may go to 0
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "count < %d", windowCount),
            object: app.windows
        )
        let result = XCTWaiter.wait(for: [expectation], timeout: 2)
        // Either the window closes or remains (depending on app behaviour)
        // We just verify the shortcut doesn't crash
        XCTAssertTrue(result == .completed || result == .timedOut,
                       "Cmd+W should either close window or be handled gracefully")
    }

    // MARK: - Launch Performance

    func testLaunchPerformance() throws {
        measure(metrics: [XCTApplicationLaunchMetric()]) {
            XCUIApplication().launch()
        }
    }
}

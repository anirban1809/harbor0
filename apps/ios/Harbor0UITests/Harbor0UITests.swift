import XCTest

final class Harbor0UITests: XCTestCase {
    @MainActor
    func testSignInTabsThemesTrashPreviewAndSignOut() throws {
        let app = XCUIApplication()
        app.launchEnvironment["HARBOR_API_URL"] = "http://127.0.0.1:18987"
        app.launch()
        if app.buttons["tab-settings"].waitForExistence(timeout: 3) { signOut(app) }
        let email = app.textFields["email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText("ios-test@example.test")
        let password = app.secureTextFields["password"]
        password.tap(); password.typeText("bad-password")
        app.buttons["signIn"].tap()
        XCTAssertTrue(app.staticTexts["signInError"].waitForExistence(timeout: 5))
        password.tap()
        password.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "bad-password".count))
        password.typeText("fixture-password")
        app.buttons["signIn"].tap()
        XCTAssertTrue(app.buttons["folder-Documents"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["folder-Studio assets"].exists)
        XCTAssertFalse(app.buttons["folder-Design archive"].exists)
        capture(app, "Harbor · Drive")
        app.buttons["folder-Documents"].tap()
        XCTAssertTrue(app.staticTexts["No files yet"].waitForExistence(timeout: 5))
        app.buttons["addFiles"].tap()
        app.buttons["New folder"].tap()
        let name = "iPhone test " + UUID().uuidString.prefix(6)
        app.alerts.textFields.firstMatch.typeText(String(name))
        app.alerts.buttons["Create"].tap()
        XCTAssertTrue(app.buttons["folder-" + name].waitForExistence(timeout: 5))

        app.buttons["tab-sync"].tap()
        XCTAssertTrue(app.buttons["sync-Studio assets"].waitForExistence(timeout: 5))
        capture(app, "Harbor · Sync")
        app.buttons["sync-Studio assets"].tap()
        XCTAssertTrue(app.buttons["file-Shared brief.txt"].waitForExistence(timeout: 5))
        app.buttons["tab-drive"].tap()
        XCTAssertTrue(app.buttons["folder-" + name].waitForExistence(timeout: 5), "Drive should retain its folder")
        app.buttons["tab-sync"].tap()
        XCTAssertTrue(app.buttons["file-Shared brief.txt"].waitForExistence(timeout: 5), "Sync should retain its folder")
        app.buttons["tab-backups"].tap()
        XCTAssertTrue(app.buttons["backup-Design archive"].waitForExistence(timeout: 5))
        capture(app, "Harbor · Backups")
        app.buttons["backup-Design archive"].tap()
        XCTAssertTrue(app.buttons["file-Saved brief.txt"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["addFiles"].exists, "Connected backups must be read only")
        app.buttons["backupHistory"].tap()
        XCTAssertTrue(app.staticTexts["Automatic backup"].waitForExistence(timeout: 5))

        app.buttons["tab-trash"].tap()
        XCTAssertTrue(app.buttons["restore-trash-note"].waitForExistence(timeout: 5))
        capture(app, "Harbor · Trash")
        app.buttons["restore-trash-note"].tap()
        XCTAssertTrue(app.staticTexts["Trash is empty"].waitForExistence(timeout: 5))
        app.buttons["tab-drive"].tap()
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["file-Old notes.txt"].waitForExistence(timeout: 5))
        app.buttons["file-Old notes.txt"].press(forDuration: 1)
        app.buttons["Move to trash"].tap()
        app.sheets.buttons["Move to trash"].tap()
        app.buttons["tab-trash"].tap()
        XCTAssertTrue(app.buttons["delete-trash-note"].waitForExistence(timeout: 5))
        app.buttons["delete-trash-note"].tap()
        app.sheets.buttons["Delete permanently"].tap()
        XCTAssertTrue(app.staticTexts["Trash is empty"].waitForExistence(timeout: 5))

        app.buttons["tab-settings"].tap()
        let mode = app.segmentedControls["appearanceMode"]
        XCTAssertTrue(mode.waitForExistence(timeout: 5))
        mode.buttons["Light"].tap()
        reveal(app.buttons["theme-ocean"], in: app)
        app.buttons["theme-ocean"].tap()
        reveal(app.buttons["saveAppearance"], in: app)
        app.buttons["saveAppearance"].tap()
        XCTAssertTrue(app.staticTexts["appearanceSaved"].waitForExistence(timeout: 5))
        capture(app, "Ocean · Settings")
        app.buttons["tab-drive"].tap()
        XCTAssertTrue(app.buttons["file-Welcome.txt"].waitForExistence(timeout: 5))
        capture(app, "Ocean · Drive")
        app.buttons["file-Welcome.txt"].tap()
        XCTAssertTrue(app.buttons["closePreview"].waitForExistence(timeout: 10))
        app.buttons["closePreview"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tab-settings"].waitForExistence(timeout: 10))
        app.buttons["tab-settings"].tap()
        XCTAssertTrue(app.buttons["theme-ocean"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["theme-ocean"].isSelected, "Saved theme should survive relaunch")
        XCTAssertTrue(mode.buttons["Light"].isSelected)
        mode.buttons["Dark"].tap()
        reveal(app.buttons["theme-violet"], in: app)
        app.buttons["theme-violet"].tap()
        capture(app, "Violet · Dark settings")
        app.buttons["tab-sync"].tap()
        capture(app, "Violet · Dark sync")
        signOut(app)
        XCTAssertTrue(email.waitForExistence(timeout: 5))
    }

    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<7 {
            if element.exists && element.isHittable { return }
            app.collectionViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    @MainActor private func signOut(_ app: XCUIApplication) {
        app.buttons["tab-settings"].tap()
        let button = app.buttons["signOut"]
        reveal(button, in: app); button.tap()
        let confirmation = app.sheets["Sign out of harbor0?"].buttons["Sign out"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5)); confirmation.tap()
    }
}

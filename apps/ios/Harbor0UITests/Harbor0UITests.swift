import XCTest

final class Harbor0UITests: XCTestCase {
    @MainActor
    func testSignInNavigationFilesTrashThemesPreviewAndSignOut() throws {
        let app = XCUIApplication()
        app.launchEnvironment["HARBOR_API_URL"] = "http://127.0.0.1:18987"
        app.launch()
        if app.buttons["tab-more"].waitForExistence(timeout: 3) { signOut(app) }
        let email = app.textFields["email"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText("ios-test@example.test")
        let password = app.secureTextFields["password"]
        password.tap(); password.typeText("bad-password")
        app.buttons["signIn"].tap()
        XCTAssertTrue(app.staticTexts["Email or password is incorrect."].waitForExistence(timeout: 5))
        password.tap()
        password.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: "bad-password".count))
        password.typeText("fixture-password")
        app.buttons["signIn"].tap()

        // My Drive → Cloud shows cloud files only; sync and backup roots have their own segments.
        XCTAssertTrue(app.buttons["folder-Documents"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["folder-Studio assets"].exists)
        XCTAssertFalse(app.buttons["folder-Design archive"].exists)
        capture(app, "Harbor · Drive")
        app.buttons["folder-Documents"].tap()
        XCTAssertTrue(app.staticTexts["This folder is empty"].waitForExistence(timeout: 5))
        app.buttons["newMenu"].tap()
        app.buttons["menu-New folder"].tap()
        let field = app.textFields["nameField"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        let name = "iPhone test " + UUID().uuidString.prefix(6)
        field.typeText(String(name))
        app.buttons["confirm-Create"].tap()
        XCTAssertTrue(app.buttons["folder-" + name].waitForExistence(timeout: 5))

        app.buttons["crumb-My Drive"].tap()
        XCTAssertTrue(app.buttons["place-Synced Folders"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["place-Backups"].exists)
        XCTAssertTrue(app.buttons["place-Archives"].exists)
        XCTAssertFalse(app.buttons["folder-Studio assets"].exists, "Synced folders live under Synced Folders")
        app.buttons["place-Synced Folders"].tap()
        XCTAssertTrue(app.buttons["placeDevice-MacBook Pro"].waitForExistence(timeout: 5))
        app.buttons["placeDevice-MacBook Pro"].tap()
        XCTAssertTrue(app.buttons["folder-Studio assets"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Synced"].exists)
        capture(app, "Harbor · Synced Folders")
        app.buttons["folder-Studio assets"].tap()
        XCTAssertTrue(app.buttons["file-Shared brief.txt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["crumb-Synced Folders"].exists)
        XCTAssertTrue(app.buttons["crumb-MacBook Pro"].exists)
        app.buttons["crumb-My Drive"].tap()
        app.buttons["place-Backups"].tap()
        XCTAssertTrue(app.buttons["placeDevice-MacBook Pro"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["placeDevice-Old PC"].exists, "Backups from a removed device keep their device name")
        // Partial counts read "At least …" at the device level.
        let partial = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS 'At least'"), object: app.buttons["placeDevice-Old PC"])
        XCTAssertEqual(XCTWaiter().wait(for: [partial], timeout: 5), .completed)
        app.buttons["placeDevice-MacBook Pro"].tap()
        XCTAssertTrue(app.buttons["folder-Design archive"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["folder-Old projects"].exists, "Archived folders live under Archives")
        app.buttons["folder-Design archive"].tap()
        XCTAssertTrue(app.buttons["file-Saved brief.txt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["crumb-Backups"].exists)
        XCTAssertTrue(app.staticTexts["folderUsage"].waitForExistence(timeout: 5), "A backup folder shows its storage total")
        XCTAssertFalse(app.buttons["newMenu"].exists, "Backups must be read only")
        app.buttons["crumb-My Drive"].tap()
        app.buttons["place-Archives"].tap()
        XCTAssertTrue(app.buttons["placeDevice-MacBook Pro"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["placeDevice-Old PC"].exists)
        app.buttons["placeDevice-MacBook Pro"].tap()
        XCTAssertTrue(app.buttons["folder-Old projects"].waitForExistence(timeout: 5))
        capture(app, "Harbor · Archives")
        app.buttons["folder-Old projects"].tap()
        XCTAssertTrue(app.buttons["file-Plan.txt"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["crumb-Archives"].exists)

        app.buttons["tab-backups"].tap()
        XCTAssertTrue(app.buttons["backup-Design archive"].waitForExistence(timeout: 5))
        capture(app, "Harbor · Backups")
        app.buttons["backup-Design archive"].tap()
        XCTAssertTrue(app.buttons["file-Saved brief.txt"].waitForExistence(timeout: 5))
        app.buttons["backup-tab-history"].tap()
        XCTAssertTrue(app.buttons["run-run-one"].waitForExistence(timeout: 5))

        app.buttons["tab-shared"].tap()
        XCTAssertTrue(app.staticTexts["Q3 report.pdf"].waitForExistence(timeout: 5))
        capture(app, "Harbor · Shared")
        // Search from Shared replaces the page in place; the Shared tab stays active.
        let search = app.textFields["search"]
        search.tap(); search.typeText("brief\n")
        XCTAssertTrue(app.staticTexts["Search results"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Files matching “brief”"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["file-Project brief.pdf"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["tab-shared"].isSelected)
        XCTAssertFalse(app.staticTexts["Q3 report.pdf"].exists)
        capture(app, "Search on Shared")
        app.buttons["clearSearch"].tap()
        XCTAssertTrue(app.staticTexts["Q3 report.pdf"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["tab-shared"].isSelected)

        app.buttons["tab-trash"].tap()
        XCTAssertTrue(app.buttons["actions-Old notes.txt"].waitForExistence(timeout: 5))
        capture(app, "Harbor · Trash")
        app.buttons["actions-Old notes.txt"].tap()
        app.buttons["menu-Restore"].tap()
        XCTAssertTrue(app.staticTexts["Trash is empty"].waitForExistence(timeout: 5))
        app.buttons["tab-drive"].tap()
        if app.buttons["crumb-My Drive"].waitForExistence(timeout: 2) { app.buttons["crumb-My Drive"].tap() }
        XCTAssertTrue(app.buttons["actions-Old notes.txt"].waitForExistence(timeout: 5))
        app.buttons["actions-Old notes.txt"].tap()
        app.buttons["menu-Move to trash"].tap()
        XCTAssertTrue(app.buttons["confirm-Move to trash"].waitForExistence(timeout: 5))
        app.buttons["confirm-Move to trash"].tap()
        app.buttons["tab-trash"].tap()
        XCTAssertTrue(app.buttons["actions-Old notes.txt"].waitForExistence(timeout: 5))
        app.buttons["actions-Old notes.txt"].tap()
        app.buttons["menu-Delete permanently"].tap()
        XCTAssertTrue(app.buttons["confirm-Delete permanently"].waitForExistence(timeout: 5))
        app.buttons["confirm-Delete permanently"].tap()
        XCTAssertTrue(app.staticTexts["Trash is empty"].waitForExistence(timeout: 5))

        openSettings(app)
        app.buttons["mode-light"].tap()
        reveal(app.buttons["theme-ocean"], in: app)
        app.buttons["theme-ocean"].tap()
        XCTAssertTrue(app.staticTexts["Saved to your account."].waitForExistence(timeout: 5))
        capture(app, "Ocean · Settings")
        app.buttons["tab-drive"].tap()
        XCTAssertTrue(app.buttons["folder-Documents"].waitForExistence(timeout: 5))
        // Unit tests may have added files above it; bring it clear of the tab bar.
        app.scrollViews.firstMatch.swipeUp()
        XCTAssertTrue(app.buttons["file-Welcome.txt"].waitForExistence(timeout: 5))
        capture(app, "Ocean · Drive")
        app.buttons["file-Welcome.txt"].tap()
        XCTAssertTrue(app.buttons["closePreview"].waitForExistence(timeout: 10))
        app.buttons["closePreview"].tap()

        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["tab-more"].waitForExistence(timeout: 10))
        openSettings(app)
        reveal(app.buttons["theme-ocean"], in: app)
        XCTAssertTrue(app.buttons["theme-ocean"].isSelected, "Saved theme should survive relaunch")
        XCTAssertTrue(app.buttons["mode-light"].isSelected)
        app.buttons["mode-dark"].tap()
        app.buttons["theme-default"].tap()
        capture(app, "Harbor · Dark settings")
        signOut(app)
        XCTAssertTrue(email.waitForExistence(timeout: 5))
    }

    /// Saves light-mode search screenshots to build/screenshots when /tmp/harbor0-capture names that directory.
    @MainActor
    func testCaptureSearchScreenshots() throws {
        guard let target = try? String(contentsOfFile: "/tmp/harbor0-capture", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !target.isEmpty else { throw XCTSkip("Screenshot capture is opt-in.") }
        let app = XCUIApplication()
        app.launchEnvironment["HARBOR_API_URL"] = "http://127.0.0.1:18987"
        app.launch()
        if !app.buttons["tab-more"].waitForExistence(timeout: 4) {
            let email = app.textFields["email"]
            XCTAssertTrue(email.waitForExistence(timeout: 10))
            email.tap(); email.typeText("ios-test@example.test")
            let password = app.secureTextFields["password"]
            password.tap(); password.typeText("fixture-password\n")
        }
        func save(_ name: String) throws {
            try app.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: target).appendingPathComponent(name + ".png"))
        }
        let search = app.textFields["search"]
        XCTAssertTrue(app.buttons["tab-shared"].waitForExistence(timeout: 10))
        app.buttons["tab-shared"].tap()
        search.tap(); search.typeText("brief")
        XCTAssertTrue(app.buttons["file-Project brief.pdf"].waitForExistence(timeout: 5))
        app.keyboards.buttons.firstMatch.exists ? app.swipeDown() : ()
        sleep(1)
        try save("light-search-shared")
        app.buttons["tab-trash"].tap()
        search.tap(); search.typeText("notes")
        XCTAssertTrue(app.staticTexts["Items in Trash matching “notes”"].waitForExistence(timeout: 5))
        sleep(1)
        try save("light-search-trash")
        app.buttons["clearSearch"].tap()
    }

    @MainActor private func openSettings(_ app: XCUIApplication) {
        app.buttons["tab-more"].tap()
        let link = app.buttons["more-settings"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        XCTAssertTrue(app.buttons["mode-light"].waitForExistence(timeout: 5))
    }
    @MainActor private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<7 {
            if element.exists && element.isHittable { return }
            app.scrollViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
    }
    @MainActor private func capture(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
    }
    @MainActor private func signOut(_ app: XCUIApplication) {
        app.buttons["accountMenu"].tap()
        let button = app.buttons["signOut"]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
    }
}

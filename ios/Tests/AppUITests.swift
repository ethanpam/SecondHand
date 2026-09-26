import XCTest

final class AppUITests: XCTestCase {
    @MainActor
    func testProfilePersistsAndCoreScreensAreAvailable() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Profile"].waitForExistence(timeout: 20))
        app.tabBars.buttons["Profile"].tap()
        let edit = app.buttons["profile.edit"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        let firstName = app.textFields["profile.firstName"]
        XCTAssertTrue(firstName.waitForExistence(timeout: 5))
        firstName.tap()
        if let value = firstName.value as? String, value != "First name", !value.isEmpty {
            firstName.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        firstName.typeText("Test Iowa")
        if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        let confirm = app.switches["profile.confirmed"]
        for _ in 0..<8 {
            if confirm.isHittable && confirm.frame.maxY < app.frame.maxY - 70 { break }
            app.swipeUp()
        }
        XCTAssertTrue(confirm.isHittable)
        attachScreenshot(app, name: "Profile confirmation before tap")
        // SwiftUI exposes the entire Form row as the switch accessibility frame.
        // Tap its trailing control, rather than the row's centered text label.
        if confirm.value as? String != "1" {
            confirm.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        }
        let confirmationEnabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: confirm)
        let confirmationResult = XCTWaiter.wait(for: [confirmationEnabled], timeout: 5)
        attachScreenshot(app, name: "Profile confirmation after tap")
        XCTAssertEqual(confirmationResult, .completed)
        XCTAssertEqual(confirm.value as? String, "1")
        XCTAssertTrue(app.buttons["profile.save"].isEnabled)
        app.buttons["profile.save"].tap()
        XCTAssertTrue(app.navigationBars["Review your profile"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["Overview"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Welcome back, Test Iowa"].exists)
        attachScreenshot(app, name: "Overview with synthetic test profile")

        app.buttons["renewal.edit"].tap()
        XCTAssertTrue(app.navigationBars["Renewal details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.switches["Return-by date"].exists)
        XCTAssertTrue(app.switches["Benefits end date"].exists)
        app.buttons["Cancel"].tap()

        app.tabBars.buttons["Documents"].tap()
        XCTAssertTrue(app.staticTexts["A home for your paperwork"].waitForExistence(timeout: 5))
        attachScreenshot(app, name: "Documents empty state")
        app.tabBars.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["A little less typing"].waitForExistence(timeout: 5))

        // Make the temporary browser grant concrete without contacting the government website.
        let authorize = app.buttons["Allow contact autofill for 10 minutes"]
        for _ in 0..<5 where !authorize.isHittable { app.swipeUp() }
        XCTAssertTrue(authorize.isHittable)
        XCTAssertTrue(authorize.isEnabled)
        authorize.tap()
        let revoke = app.buttons["Revoke contact access now"]
        XCTAssertTrue(revoke.waitForExistence(timeout: 8))
        revoke.tap()
        XCTAssertTrue(authorize.waitForExistence(timeout: 5))

        // Deletion must remove persisted records and the sharing grant, including after reopening.
        let delete = app.buttons["Delete all app data"]
        for _ in 0..<8 {
            if delete.isHittable && delete.frame.maxY < app.frame.maxY - 90 { break }
            app.swipeUp()
        }
        delete.tap()
        XCTAssertTrue(app.staticTexts["Permanently delete all app data?"].waitForExistence(timeout: 5))
        // The underlying Settings button has the same label. Only the confirmation
        // dialog's destructive button is hittable while the dialog is presented.
        let confirmDelete = try XCTUnwrap(
            app.buttons.matching(identifier: "Delete all app data").allElementsBoundByIndex.first(where: { $0.isHittable }),
            "The destructive confirmation button should be visible and hittable."
        )
        confirmDelete.tap()
        XCTAssertTrue(app.buttons["Unlock Second Hand"].waitForExistence(timeout: 5))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.staticTexts["Your next step starts here"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Welcome back, Test Iowa"].exists)
        attachScreenshot(app, name: "Overview empty state")
    }

    @MainActor
    private func attachScreenshot(_ app: XCUIApplication, name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

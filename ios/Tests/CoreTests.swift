import XCTest
import CryptoKit
@testable import SecondHand

final class CoreTests: XCTestCase {
    func testVaultRoundTripAndPlaintextDoesNotAppearOnDisk() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let vault = try SecureVault(directory: directory, key: key)
        var data = AppData()
        data.profile.firstName = "TEST_PRIVATE_NAME_927"
        try vault.save(data)
        XCTAssertEqual(try vault.load(), data)
        let ciphertext = try Data(contentsOf: directory.appendingPathComponent("profile.sealed"))
        XCTAssertNil(ciphertext.range(of: Data(data.profile.firstName.utf8)))
        let wrongKeyVault = try SecureVault(directory: directory, key: SymmetricKey(size: .bits256))
        XCTAssertThrowsError(try wrongKeyVault.load())
    }

    func testCiphertextTamperingAndCrossFileSwapAreRejected() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try SecureVault(directory: directory, key: SymmetricKey(size: .bits256))
        try vault.write(Data("private document".utf8), named: "a.sealed")
        let a = directory.appendingPathComponent("a.sealed")
        let b = directory.appendingPathComponent("b.sealed")
        var bytes = try Data(contentsOf: a)
        try bytes.write(to: b)
        XCTAssertThrowsError(try vault.read(named: "b.sealed"))
        bytes[bytes.count / 2] ^= 1
        try bytes.write(to: a)
        XCTAssertThrowsError(try vault.read(named: "a.sealed"))
    }

    func testNewerSchemaFailsWithoutOverwritingExistingData() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try SecureVault(directory: directory, key: SymmetricKey(size: .bits256))
        var data = AppData()
        data.schemaVersion = 999
        try vault.save(data)
        XCTAssertThrowsError(try vault.load())
        XCTAssertNotNil(try vault.read(named: "profile.sealed"))
    }

    func testAutofillExpiresAndOnlyContainsContactFields() {
        let now = Date()
        XCTAssertFalse(AutofillSession(expiresAt: now, fields: [:]).isValid(now: now))
        XCTAssertFalse(AutofillSession(expiresAt: now.addingTimeInterval(-1), fields: [:]).isValid(now: now))
        XCTAssertFalse(AutofillSession(expiresAt: now.addingTimeInterval(3600), fields: [:]).isValid(now: now))
        XCTAssertTrue(AutofillSession(expiresAt: now.addingTimeInterval(600), fields: [:]).isValid(now: now))
        var profile = PersonalProfile()
        profile.firstName = "Sample"
        profile.email = "sample@example.invalid"
        profile.phone = "5155550100"
        profile.monthlyIncome = "1000"
        profile.notes = "private"
        profile.household = [HouseholdMember(name: "Other", relationship: "spouse")]
        XCTAssertEqual(profile.contactFields, ["firstName": "Sample", "state": "IA"])
    }

    func testRemindersUseNoticeDatesAndRemoveCompletedSteps() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let now = calendar.date(from: DateComponents(year: 2026, month: 9, day: 1))!
        var plan = RenewalPlan()
        plan.remindersEnabled = true
        XCTAssertTrue(ReminderScheduler.planned(for: plan, now: now, calendar: calendar).isEmpty)
        plan.dueDate = calendar.date(from: DateComponents(year: 2026, month: 9, day: 15))!
        plan.documentsDueDate = plan.dueDate
        plan.interviewDate = calendar.date(from: DateComponents(year: 2026, month: 9, day: 10, hour: 14))!
        let planned = ReminderScheduler.planned(for: plan, now: now, calendar: calendar)
        XCTAssertEqual(planned.filter { $0.id.contains("renewal") }.count, 4)
        XCTAssertTrue(planned.allSatisfy { $0.date > now })
        XCTAssertEqual(planned.filter { $0.id.contains("interview") }.count, 2)
        plan.status = .submitted
        plan.interviewCompleted = true
        plan.documentsSubmitted = true
        XCTAssertTrue(ReminderScheduler.planned(for: plan, now: now, calendar: calendar).isEmpty)
        plan.status = .approved
        plan.interviewCompleted = false
        XCTAssertTrue(ReminderScheduler.planned(for: plan, now: now, calendar: calendar).isEmpty)
    }

    func testDeadlineCalendarDaysRatherThanTwentyFourHours() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        let late = calendar.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 23))!
        var plan = RenewalPlan()
        plan.dueDate = calendar.date(from: DateComponents(year: 2026, month: 11, day: 2, hour: 1))!
        XCTAssertEqual(plan.daysUntilDue(now: late, calendar: calendar), 1)
    }

    @MainActor
    func testProfileValidationRejectsMalformedMoneyAndZip() throws {
        var profile = PersonalProfile()
        profile.monthlyIncome = "-1"
        XCTAssertThrowsError(try AppStore.validate(profile))
        profile.monthlyIncome = "1234.56"
        profile.postalCode = "50309-1234"
        XCTAssertNoThrow(try AppStore.validate(profile))
        profile.postalCode = "503"
        XCTAssertThrowsError(try AppStore.validate(profile))
    }
}

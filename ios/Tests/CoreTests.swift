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

    func testLegacyEncryptedProfileDecodesWithoutInventingPhoneTypes() throws {
        var original = AppData()
        original.profile.firstName = "Legacy"
        original.profile.phone = "5155550100"
        original.profile.notes = "Keep this private"
        original.profile.monthlyIncome = "900"
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        var profile = try XCTUnwrap(object["profile"] as? [String: Any])
        for key in ["middleName", "homePhone", "mobilePhone"] { profile.removeValue(forKey: key) }
        object["profile"] = profile
        object.removeValue(forKey: "importedReceiptIDs")
        object.removeValue(forKey: "importedReceiptConfirmations")
        object.removeValue(forKey: "renewalStartedAt")
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try SecureVault(directory: directory, key: SymmetricKey(size: .bits256))
        try vault.write(JSONSerialization.data(withJSONObject: object), named: "profile.sealed")
        let restored = try vault.load()
        XCTAssertEqual(restored, original)
        XCTAssertEqual(restored.profile.homePhone, "")
        XCTAssertEqual(restored.profile.mobilePhone, "")
        XCTAssertNil(restored.profile.applicationFields["phone"])
        try vault.save(restored)
        XCTAssertEqual(try vault.load(), original)
    }

    func testApplicationSnapshotIncludesOnlyExplicitApprovedFields() {
        var profile = PersonalProfile()
        profile.firstName = "Example"
        profile.middleName = "M"
        profile.email = "example@example.invalid"
        profile.phone = "reference phone"
        profile.homePhone = "5155550100"
        profile.mobilePhone = "5155550101"
        profile.monthlyIncome = "1250.50"
        profile.monthlyHousingCost = "700"
        profile.notes = "private note"
        profile.household = [HouseholdMember(name: "Other", relationship: "child")]
        XCTAssertEqual(profile.applicationFields, ["firstName": "Example", "middleName": "M", "email": "example@example.invalid",
            "homePhone": "5155550100", "mobilePhone": "5155550101", "state": "IA",
            "monthlyIncome": "1250.50", "monthlyHousingCost": "700"])
        XCTAssertTrue(Set(profile.applicationFields.keys).isSubset(of: IowaApplicationBridge.allowedFieldKeys))
        profile.mobilePhone = " \n "
        XCTAssertNil(profile.applicationFields["mobilePhone"])
    }

    func testConfirmedCompleteHomeAddressDerivesYesOnlyForApplicationSharing() throws {
        let now = Date()
        var profile = PersonalProfile()
        profile.addressLine1 = " 123 Test Way "
        profile.city = " Demo City "
        profile.state = " ia "
        profile.postalCode = " 50309 "
        profile.reviewedAt = now
        let fields = profile.applicationFields(now: now)
        XCTAssertEqual(fields["hasHomeAddress"], "yes")
        XCTAssertEqual(fields["addressLine1"], profile.addressLine1)
        XCTAssertTrue(Set(fields.keys).isSubset(of: IowaApplicationBridge.allowedFieldKeys))
        XCTAssertNil(profile.contactFields["hasHomeAddress"])
        let encoded = try JSONEncoder().encode(profile)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertNil(object["hasHomeAddress"], "The answer is derived, not a persisted preference")
        XCTAssertEqual(try JSONDecoder().decode(PersonalProfile.self, from: encoded).applicationFields(now: now)["hasHomeAddress"], "yes")
    }

    func testHomeAddressAnswerRequiresRecentConfirmationAndCompleteValidAddress() {
        let now = Date()
        var complete = PersonalProfile()
        complete.addressLine1 = "123 Test Way"
        complete.city = "Demo City"
        complete.state = "IA"
        complete.postalCode = "50309"
        complete.reviewedAt = now.addingTimeInterval(-24 * 60 * 60 + 1)
        XCTAssertEqual(complete.applicationFields(now: now)["hasHomeAddress"], "yes")

        for reviewedAt in [nil, now.addingTimeInterval(1), now.addingTimeInterval(-24 * 60 * 60)] as [Date?] {
            var profile = complete
            profile.reviewedAt = reviewedAt
            XCTAssertNil(profile.applicationFields(now: now)["hasHomeAddress"])
        }
        let invalidValues: [(WritableKeyPath<PersonalProfile, String>, String)] = [
            (\.addressLine1, " \n "), (\.city, ""), (\.state, ""), (\.state, "ZZ"), (\.state, "Iowa"),
            (\.postalCode, ""), (\.postalCode, "503"), (\.postalCode, "50309-1234"), (\.postalCode, "５０３０９")
        ]
        for (keyPath, value) in invalidValues {
            var profile = complete
            profile[keyPath: keyPath] = value
            XCTAssertNil(profile.applicationFields(now: now)["hasHomeAddress"], "Incomplete or invalid addresses must not infer either answer")
        }
    }

    func testApplicationSessionRejectsUnsupportedOrIncompleteHomeAddressAnswers() {
        let now = Date()
        let address = ["addressLine1": "123 Test Way", "city": "Demo City", "state": "IA", "postalCode": "50309"]
        func session(_ fields: [String: String]) -> AutofillSession {
            AutofillSession(expiresAt: now.addingTimeInterval(600), fields: fields)
        }
        XCTAssertTrue(session(address).isValid(now: now), "Older snapshots without a home-address answer remain valid")
        var fields = address
        fields["hasHomeAddress"] = "yes"
        XCTAssertTrue(session(fields).isValid(now: now))
        for answer in ["no", "true", "", "Yes"] {
            fields["hasHomeAddress"] = answer
            XCTAssertFalse(session(fields).isValid(now: now))
        }
        fields["hasHomeAddress"] = "yes"
        fields.removeValue(forKey: "city")
        XCTAssertFalse(session(fields).isValid(now: now))
    }

    func testReadingExpiredSessionNeverDeletesTheSharedFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try SecureVault(directory: directory, key: SymmetricKey(size: .bits256))
        let now = Date()
        let expired = AutofillSession(expiresAt: now.addingTimeInterval(-1), fields: ["firstName": "Expired"])
        try vault.write(JSONEncoder().encode(expired), named: "session.sealed")
        let previousBytes = try vault.read(named: "session.sealed")
        XCTAssertNil(try vault.loadAutofillSession(now: now))
        XCTAssertEqual(try vault.read(named: "session.sealed"), previousBytes)
        let refreshed = AutofillSession(expiresAt: now.addingTimeInterval(600), fields: ["firstName": "Current"])
        try vault.write(JSONEncoder().encode(refreshed), named: "session.sealed")
        XCTAssertEqual(try vault.loadAutofillSession(now: now)?.fields, refreshed.fields)
    }

    func testApplicationBridgeRejectsUntrustedRoutesAndURLInjection() {
        let base = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/"
        XCTAssertTrue(IowaApplicationBridge.allowsApplicationPage(base + "enterPersonalInfo"))
        XCTAssertTrue(IowaApplicationBridge.allowsApplicationPage(base + "applicationConfirmation"))
        for suffix in ["", "login", "myAccount", "editProfile", "create-account", "sign_in", "enterPersonalInfo?next=login",
                       "enterPersonalInfo#login", "enterPersonalInfo?", "enterPersonalInfo#", "../login", "%2e%2e/login",
                       "enterPersonalInfo%2Flogin", "enterPersonalInfo/", "enterPersonalInfo;account=foo"] {
            XCTAssertFalse(IowaApplicationBridge.allowsApplicationPage(base + suffix), suffix)
        }
        for url in [base.replacingOccurrences(of: "https:", with: "http:") + "enterPersonalInfo",
                    base.replacingOccurrences(of: "hhsservices.iowa.gov", with: "hhsservices.iowa.gov.evil.invalid") + "enterPersonalInfo",
                    base.replacingOccurrences(of: "hhsservices.iowa.gov", with: "user@hhsservices.iowa.gov") + "enterPersonalInfo",
                    base.replacingOccurrences(of: "hhsservices.iowa.gov", with: "hhsservices.iowa.gov:8443") + "enterPersonalInfo"] {
            XCTAssertFalse(IowaApplicationBridge.allowsApplicationPage(url), url)
        }
    }

    func testReceiptValidationRequiresKnownOriginUUIDAndConstrainedConfirmation() throws {
        let page = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/applicationConfirmation"
        let id = UUID().uuidString
        let valid = try XCTUnwrap(ApplicationReceipt(receiptID: id, confirmationNumber: "  IA-123 456 \n", pageURL: page))
        XCTAssertEqual(valid.confirmationNumber, "IA-123 456")
        XCTAssertTrue(valid.isValid)
        XCTAssertNil(ApplicationReceipt(receiptID: "not-a-uuid", confirmationNumber: "IA-123", pageURL: page))
        XCTAssertNil(ApplicationReceipt(receiptID: id, confirmationNumber: "IA-123", pageURL: "https://example.invalid/"))
        for number in ["", "12", String(repeating: "A", count: 81), "A\n123", "IA_123", "ABC<script>", " --- ", "é123"] {
            XCTAssertNil(ApplicationReceipt(receiptID: id, confirmationNumber: number, pageURL: page), number)
        }
    }

    func testReceiptPersistsSeparatelyAndImportIsIdempotentAcrossRestart() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try SecureVault(directory: directory, key: SymmetricKey(size: .bits256))
        let initial = AppData()
        try vault.save(initial)
        let page = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/applicationConfirmation"
        let receipt = try XCTUnwrap(ApplicationReceipt(receiptID: UUID().uuidString, confirmationNumber: "IA-TEST-123", pageURL: page))
        try vault.savePendingReceipt(receipt)
        XCTAssertEqual(try vault.load(), initial, "Safari receipt must never edit the main vault")
        XCTAssertEqual(try vault.loadPendingReceipts(), [receipt])
        let sealed = try Data(contentsOf: directory.appendingPathComponent("receipt-\(receipt.id.uuidString).sealed"))
        XCTAssertNil(sealed.range(of: Data(receipt.confirmationNumber.utf8)))
        let retry = try XCTUnwrap(ApplicationReceipt(receiptID: receipt.id.uuidString, confirmationNumber: receipt.confirmationNumber,
                                                    pageURL: page, now: Date().addingTimeInterval(1)))
        try vault.savePendingReceipt(retry)
        XCTAssertEqual(try vault.loadPendingReceipts(), [receipt])
        var next = try vault.load()
        XCTAssertTrue(next.importReceipt(receipt))
        XCTAssertEqual(next.renewal.status, .submitted)
        XCTAssertEqual(next.renewal.confirmationNumber, "IA-TEST-123")
        XCTAssertEqual(next.history.first?.title, "Reported from Safari")
        XCTAssertEqual(next.importedReceiptIDs, [receipt.id])
        try vault.save(next)
        // Simulate app interruption after the commit but before removal of the receipt file.
        var restarted = try vault.load()
        XCTAssertFalse(restarted.importReceipt(try XCTUnwrap(vault.loadPendingReceipts().first)))
        XCTAssertEqual(restarted, next)
        let conflict = try XCTUnwrap(ApplicationReceipt(receiptID: receipt.id.uuidString, confirmationNumber: "DIFFERENT-123", pageURL: page))
        XCTAssertThrowsError(try vault.savePendingReceipt(conflict))
        XCTAssertEqual(try vault.loadPendingReceipts(), [receipt])
    }

    func testRepeatedConfirmationWithDifferentReceiptIDPreservesAdvancedStatus() throws {
        let page = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/applicationConfirmation"
        for status in [RenewalStatus.submitted, .awaitingDecision, .approved] {
            var data = AppData()
            data.renewal.status = status
            data.renewal.confirmationNumber = "IA-TEST-123"
            let receipt = try XCTUnwrap(ApplicationReceipt(receiptID: UUID().uuidString, confirmationNumber: "IA-TEST-123", pageURL: page))
            XCTAssertTrue(data.importReceipt(receipt))
            XCTAssertEqual(data.renewal.status, status)
            XCTAssertTrue(data.history.isEmpty)
            XCTAssertEqual(data.importedReceiptIDs, [receipt.id])
            let repeated = try XCTUnwrap(ApplicationReceipt(receiptID: UUID().uuidString, confirmationNumber: "IA-TEST-123", pageURL: page))
            XCTAssertTrue(data.importReceipt(repeated))
            XCTAssertEqual(data.renewal.status, status)
            XCTAssertTrue(data.history.isEmpty)
            XCTAssertEqual(data.importedReceiptIDs, [receipt.id, repeated.id])
            XCTAssertEqual(data.importedReceiptConfirmations, ["IA-TEST-123"])
        }
    }

    func testDifferentReceiptDoesNotReplaceExistingOrAdvancedPlan() throws {
        let page = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/applicationConfirmation"
        for status in RenewalStatus.allCases {
            var data = AppData()
            data.renewal.status = status
            data.renewal.confirmationNumber = "CURRENT-456"
            let originalPlan = data.renewal
            let receipt = try XCTUnwrap(ApplicationReceipt(receiptID: UUID().uuidString, confirmationNumber: "OLD-123", pageURL: page))
            XCTAssertTrue(data.importReceipt(receipt))
            XCTAssertEqual(data.renewal, originalPlan)
            XCTAssertEqual(data.history.count, 1)
            XCTAssertTrue(try XCTUnwrap(data.history.first).detail.contains("left unchanged"))
            let repeated = try XCTUnwrap(ApplicationReceipt(receiptID: UUID().uuidString, confirmationNumber: "OLD-123", pageURL: page))
            XCTAssertTrue(data.importReceipt(repeated))
            XCTAssertEqual(data.history.count, 1)
            XCTAssertEqual(data.renewal, originalPlan)
        }
    }

    func testReceiptFromBeforeNewRenewalIsRecordedWithoutChangingCurrentPlan() throws {
        let now = Date()
        var data = AppData()
        data.renewalStartedAt = now
        let page = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/applicationConfirmation"
        let stale = try XCTUnwrap(ApplicationReceipt(receiptID: UUID().uuidString, confirmationNumber: "OLD-123", pageURL: page,
                                                    now: now.addingTimeInterval(-30)))
        XCTAssertTrue(data.importReceipt(stale))
        XCTAssertEqual(data.renewal, RenewalPlan())
        XCTAssertEqual(data.history.count, 1)
        let restored = try JSONDecoder().decode(AppData.self, from: JSONEncoder().encode(data))
        XCTAssertEqual(restored.renewalStartedAt, now)
        XCTAssertEqual(restored.importedReceiptConfirmations, ["OLD-123"])
        let current = try XCTUnwrap(ApplicationReceipt(receiptID: UUID().uuidString, confirmationNumber: "NEW-456", pageURL: page,
                                                      now: now.addingTimeInterval(1)))
        XCTAssertTrue(data.importReceipt(current))
        XCTAssertEqual(data.renewal.status, .submitted)
        XCTAssertEqual(data.renewal.confirmationNumber, "NEW-456")
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

    @MainActor
    func testNewApplicationFieldsHaveLengthLimits() throws {
        var profile = PersonalProfile()
        profile.middleName = String(repeating: "A", count: 251)
        XCTAssertThrowsError(try AppStore.validate(profile))
        profile.middleName = "M"
        profile.mobilePhone = String(repeating: "1", count: 251)
        XCTAssertThrowsError(try AppStore.validate(profile))
        profile.mobilePhone = "5155550100"
        profile.homePhone = String(repeating: "1", count: 251)
        XCTAssertThrowsError(try AppStore.validate(profile))
        profile.homePhone = "5155550101"
        XCTAssertNoThrow(try AppStore.validate(profile))
    }
}

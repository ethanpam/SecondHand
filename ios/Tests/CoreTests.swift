import XCTest
import CryptoKit
@testable import SecondHand

final class CoreTests: XCTestCase {
    func testWebsiteApprovalScopesAndSessionMigration() throws {
        let origin = "https://forms.example.test"
        let url = origin + "/apply?step=1"
        XCTAssertEqual(WebsiteApproval.origin(url), origin)
        XCTAssertTrue(WebsiteApproval.allowsPage(url))
        for raw in ["http://forms.example.test/a", "https://person@forms.example.test/a", "https://forms.example.test:444/a", "https://127.0.0.1/a", "https://localhost/a", origin + "/login", origin + "/checkout", origin + "/a#signin"] {
            XCTAssertFalse(WebsiteApproval.allowsPage(raw), raw)
        }
        let fields = ["firstName": "Example", "ssn": "000-12-3456", "annualIncome": "68450", "monthlyIncome": "1000", "hasHomeAddress": "yes"]
        var session = AutofillSession(expiresAt: Date().addingTimeInterval(600), fields: fields)
        let basic = WebsiteApproval(origin: origin)
        XCTAssertNil(session.fields(for: url, approvals: [basic]))
        session.approvedSitesEnabled = true
        XCTAssertNil(session.fields(for: url, approvals: []))
        XCTAssertEqual(session.fields(for: url, approvals: [basic]), ["firstName": "Example"])
        let sensitive = WebsiteApproval(origin: origin, includeSensitive: true)
        XCTAssertEqual(session.fields(for: url, approvals: [sensitive])?["ssn"], fields["ssn"])
        XCTAssertNil(session.fields(for: "https://sub.forms.example.test/apply", approvals: [sensitive]))
        XCTAssertNil(session.fields(for: origin + "/login", approvals: [sensitive]))
        XCTAssertNil(session.fields(for: "https://hhsservices.iowa.gov/apspssp/ssp.portal/login/personalInfoSignup", approvals: [WebsiteApproval(origin: WebsiteApproval.iowaOrigin, includeSensitive: true)]))
        session.approvedSitesEnabled = nil
        let old = try JSONDecoder().decode(AutofillSession.self, from: JSONEncoder().encode(session))
        XCTAssertNil(old.fields(for: url, approvals: [sensitive]))
        session.expiresAt = Date().addingTimeInterval(-1)
        XCTAssertNil(session.fields(for: url, approvals: [sensitive]))
    }

    func testWebsiteApprovalsAreEncryptedAndRejectWildcards() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let vault = try SecureVault(directory: directory, key: SymmetricKey(size: .bits256))
        let site = WebsiteApproval(origin: "https://private.example.test", includeSensitive: true)
        try vault.saveWebsiteApprovals([site])
        XCTAssertEqual(try vault.loadWebsiteApprovals(), [site])
        let disk = try Data(contentsOf: directory.appendingPathComponent("sites.sealed"))
        XCTAssertFalse(String(decoding: disk, as: UTF8.self).contains(site.origin))
        for invalid in [[site, site], [WebsiteApproval(origin: "https://*.example.test")], [WebsiteApproval(origin: WebsiteApproval.iowaOrigin)]] {
            XCTAssertThrowsError(try vault.saveWebsiteApprovals(invalid))
        }
        try vault.saveWebsiteApprovals([])
        XCTAssertTrue(try vault.loadWebsiteApprovals().isEmpty)
    }

    func testAppPINValidationAndSaltedCredentials() throws {
        for invalid in ["", "123", "12345", "123456", "abcd", "１２３４"] {
            XCTAssertThrowsError(try AppAuthentication(pin: invalid))
        }
        var first = try AppAuthentication(pin: "0123")
        let second = try AppAuthentication(pin: "0123")
        XCTAssertNotEqual(first.salt, second.salt)
        XCTAssertNotEqual(first.digest, second.digest)
        XCTAssertNoThrow(try first.verify("0123"))
        XCTAssertThrowsError(try first.verify("0124"))
    }

    func testLegacyPINLengthIsPreservedForMigration() throws {
        let credentials = try AppAuthentication(pin: "1234")
        XCTAssertEqual(credentials.requiredDigits, 4)
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(credentials)) as? [String: Any])
        legacy.removeValue(forKey: "pinLength")
        let restored = try JSONDecoder().decode(AppAuthentication.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertEqual(restored.requiredDigits, 6)
    }

    func testAppPINThrottleSurvivesSerializationAndResetsOnSuccess() throws {
        var credentials = try AppAuthentication(pin: "1234")
        let now = Date()
        for _ in 0..<5 { XCTAssertThrowsError(try credentials.verify("0000", now: now)) }
        credentials = try JSONDecoder().decode(AppAuthentication.self, from: JSONEncoder().encode(credentials))
        XCTAssertThrowsError(try credentials.verify("1234", now: now.addingTimeInterval(29)))
        XCTAssertNoThrow(try credentials.verify("1234", now: now.addingTimeInterval(31)))
        XCTAssertEqual(credentials.failures, 0)
        XCTAssertEqual(credentials.retryAfter, .distantPast)
    }

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

    func testHomeAddressAnswerIsSharedOnlyWhenTheApplicantSavedOne() {
        var profile = PersonalProfile()
        profile.firstName = "Avery"
        profile.lastName = "Example"
        profile.addressLine1 = "123 Test Way"
        profile.city = "Demo City"
        profile.state = "IA"
        profile.postalCode = "50309"
        profile.reviewedAt = Date()
        XCTAssertEqual(profile.hasHomeAddress, .unanswered)
        XCTAssertNil(profile.applicationFields["hasHomeAddress"], "A complete, recently confirmed address never implies an answer")
        profile.hasHomeAddress = .yes
        XCTAssertEqual(profile.applicationFields["hasHomeAddress"], "yes")
        profile.hasHomeAddress = .no
        XCTAssertEqual(profile.applicationFields["hasHomeAddress"], "no")
        XCTAssertEqual(profile.applicationFields["addressLine1"], "123 Test Way")
        XCTAssertTrue(Set(profile.applicationFields.keys).isSubset(of: IowaApplicationBridge.allowedFieldKeys))
        XCTAssertNil(profile.contactFields["hasHomeAddress"])

        var withoutAddress = PersonalProfile()
        withoutAddress.firstName = "Avery"
        withoutAddress.hasHomeAddress = .yes
        XCTAssertEqual(withoutAddress.applicationFields["hasHomeAddress"], "yes", "The saved answer doesn't depend on the address fields")
    }

    func testHomeAddressAnswerPersistsAndOlderProfilesDecodeAsUnanswered() throws {
        var profile = PersonalProfile()
        profile.firstName = "Avery"
        profile.hasHomeAddress = .no
        let encoded = try JSONEncoder().encode(profile)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(object["hasHomeAddress"] as? String, "no")
        XCTAssertEqual(try JSONDecoder().decode(PersonalProfile.self, from: encoded), profile)

        object.removeValue(forKey: "hasHomeAddress")
        let legacy = try JSONDecoder().decode(PersonalProfile.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(legacy.hasHomeAddress, .unanswered)
        XCTAssertNil(legacy.applicationFields["hasHomeAddress"])

        object["hasHomeAddress"] = "maybe"
        XCTAssertThrowsError(try JSONDecoder().decode(PersonalProfile.self, from: JSONSerialization.data(withJSONObject: object)))
    }

    func testApplicationSessionAcceptsOnlyAnExplicitHomeAddressAnswer() {
        let now = Date()
        func session(_ fields: [String: String]) -> AutofillSession {
            AutofillSession(expiresAt: now.addingTimeInterval(600), fields: fields)
        }
        XCTAssertTrue(session(["firstName": "Avery"]).isValid(now: now), "Snapshots without a home-address answer remain valid")
        for answer in ["yes", "no"] {
            XCTAssertTrue(session(["hasHomeAddress": answer]).isValid(now: now), answer)
        }
        for answer in ["true", "", "Yes", " yes", "maybe"] {
            XCTAssertFalse(session(["hasHomeAddress": answer]).isValid(now: now), answer)
        }
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
    func testSSNAndAnnualIncomeMigrationValidationAndSharing() throws {
        var profile = PersonalProfile()
        profile.ssn = "000-12-3456"
        profile.annualIncome = [AnnualIncomeEntry(amount: "68450.00", year: "2025", source: "W-2", category: "Wages")]
        XCTAssertNoThrow(try AppStore.validate(profile))
        let encoded = try JSONEncoder().encode(profile)
        XCTAssertEqual(try JSONDecoder().decode(PersonalProfile.self, from: encoded), profile)
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        legacy.removeValue(forKey: "ssn")
        legacy.removeValue(forKey: "annualIncome")
        let migrated = try JSONDecoder().decode(PersonalProfile.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertEqual(migrated.ssn, "")
        XCTAssertTrue(migrated.annualIncome.isEmpty)
        XCTAssertFalse(String(describing: profile.applicationFields).contains("000-12-3456"))
        XCTAssertFalse(String(describing: profile.applicationFields).contains("68450"))
        let shared = profile.applicationFields(sharingSSN: true, annualIncomeID: profile.annualIncome[0].id)
        XCTAssertEqual(shared["ssn"], "000-12-3456")
        XCTAssertEqual(shared["annualIncome"], "68450.00")
        XCTAssertEqual(shared["annualIncomeYear"], "2025")
        XCTAssertNil(profile.applicationFields(sharingSSN: false, annualIncomeID: UUID())["annualIncome"])
        XCTAssertNil(profile.applicationFields(sharingSSN: false, annualIncomeID: nil)["ssn"])
        XCTAssertTrue(Set(shared.keys).isSubset(of: IowaApplicationBridge.allowedFieldKeys))
        profile.ssn = "123"
        XCTAssertThrowsError(try AppStore.validate(profile))
        profile.ssn = "000-12-3456"
        profile.annualIncome[0].year = "25"
        XCTAssertThrowsError(try AppStore.validate(profile))
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

package com.ethanpam.secondhand.core

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID

class CoreTests {
    private val page = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/applicationConfirmation"
    private fun receipt(number: String = "IA-123", time: Long = 10_000) =
        ApplicationReceipt(UUID.randomUUID().toString(), number, page, time)

    @Test fun legacyProfilePreservesGenericPhoneWithoutGuessingType() {
        val original = AppData(profile = PersonalProfile(firstName = "Example", phone = "5155550100", notes = "private", monthlyIncome = "900"))
        val json = JSONObject(ModelCodec.encode(original).toString(Charsets.UTF_8))
        val profile = json.getJSONObject("profile")
        listOf("middleName", "homePhone", "mobilePhone").forEach(profile::remove)
        listOf("importedReceiptIDs", "importedReceiptConfirmations", "renewalStartedAt").forEach(json::remove)
        val restored = ModelCodec.decode(json.toString().toByteArray())
        assertEquals(original, restored)
        assertEquals("", restored.profile.homePhone)
        assertEquals("", restored.profile.mobilePhone)
        assertFalse(restored.profile.applicationFields.containsKey("phone"))
        assertEquals(restored, ModelCodec.decode(ModelCodec.encode(restored)))
    }

    @Test fun snapshotSharesOnlyExplicitApplicationFields() {
        val profile = PersonalProfile(firstName = "A", middleName = "B", lastName = "C", email = "a@example.invalid",
            phone = "never-share", homePhone = "5155550100", mobilePhone = "5155550101", monthlyIncome = "1000",
            monthlyHousingCost = "500", notes = "private", household = listOf(HouseholdMember(name = "Private")))
        assertEquals(setOf("firstName", "middleName", "lastName", "email", "homePhone", "mobilePhone", "state", "monthlyIncome", "monthlyHousingCost"), profile.applicationFields.keys)
        assertTrue(IowaApplicationBridge.allowedFieldKeys.containsAll(profile.applicationFields.keys))
        assertFalse(profile.applicationFields.values.contains("never-share"))
        assertFalse(profile.applicationFields.values.contains("private"))
        assertFalse(profile.copy(mobilePhone = " \n ").applicationFields.containsKey("mobilePhone"))
    }

    @Test fun modelRoundTripAndUnknownSchemaFailsClosed() {
        val original = AppData(profile = PersonalProfile(firstName = "Example", middleName = "M", mobilePhone = "5155550100", reviewedAt = 1000),
            renewal = RenewalPlan(dueDate = "2026-10-01", interviewDate = 2000, status = RenewalStatus.AWAITING_DECISION),
            documents = listOf(SavedDocument(name = "Proof.pdf", mimeType = "application/pdf", byteCount = 50)),
            history = listOf(ActivityEntry(title = "Saved", detail = "Local")), renewalStartedAt = 500)
        assertEquals(original, ModelCodec.decode(ModelCodec.encode(original)))
        assertThrows(VaultException::class.java) { ModelCodec.decode(ModelCodec.encode(original.copy(schemaVersion = 999))) }
        assertThrows(Exception::class.java) { ModelCodec.decode("not json".toByteArray()) }
        assertThrows(Exception::class.java) { ModelCodec.decode(ModelCodec.encode(original.copy(profile = original.profile.copy(monthlyIncome = "-1")))) }
    }

    @Test fun applicationURLRejectsAuthenticationAndOriginInjection() {
        val base = "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/"
        assertTrue(IowaApplicationBridge.allowsApplicationPage(base + "enterPersonalInfo"))
        for (suffix in listOf("", "login", "profile", "myAccount", "create-account", "sign_in", "enterPersonalInfo?next=login",
            "enterPersonalInfo#login", "enterPersonalInfo?", "enterPersonalInfo#", "../login", "%2e%2e/login",
            "enterPersonalInfo%2Flogin", "enterPersonalInfo/", "enterPersonalInfo;account=x"))
            assertFalse(suffix, IowaApplicationBridge.allowsApplicationPage(base + suffix))
        for (url in listOf(base.replace("https:", "http:") + "enterPersonalInfo", base.replace("hhsservices.iowa.gov", "evil.invalid") + "enterPersonalInfo",
            base.replace("hhsservices.iowa.gov", "user@hhsservices.iowa.gov") + "enterPersonalInfo",
            base.replace("hhsservices.iowa.gov", "hhsservices.iowa.gov:8443") + "enterPersonalInfo"))
            assertFalse(url, IowaApplicationBridge.allowsApplicationPage(url))
    }

    @Test fun receiptRejectsMalformedIdentifiersAndUntrustedPages() {
        assertTrue(receipt().isValid())
        for (number in listOf("", "12", "A".repeat(81), "A\n123", "IA_123", "ABC<script>", "---", "é123"))
            assertFalse(number, receipt(number).isValid())
        assertFalse(receipt().copy(id = "1-1-1-1-1").isValid())
        assertFalse(receipt().copy(pageURL = "https://example.invalid/").isValid())
    }

    @Test fun repeatedReceiptCannotDuplicateHistoryOrDowngradeStatus() {
        val first = receipt()
        val submitted = AppData().importReceipt(first)
        assertEquals(RenewalStatus.SUBMITTED, submitted.renewal.status)
        assertEquals("IA-123", submitted.renewal.confirmationNumber)
        assertEquals(1, submitted.history.size)
        assertEquals(submitted, submitted.importReceipt(first))
        for (status in listOf(RenewalStatus.SUBMITTED, RenewalStatus.AWAITING_DECISION, RenewalStatus.APPROVED)) {
            val advanced = submitted.copy(renewal = submitted.renewal.copy(status = status))
            val retry = advanced.importReceipt(receipt())
            assertEquals(status, retry.renewal.status)
            assertEquals(advanced.history, retry.history)
            assertEquals(2, retry.importedReceiptIDs.size)
            assertEquals(listOf("IA-123"), retry.importedReceiptConfirmations)
        }
        assertEquals(submitted, ModelCodec.decode(ModelCodec.encode(submitted)))
    }

    @Test fun unrelatedAndStaleReceiptsDoNotReplaceCurrentPlan() {
        val current = RenewalPlan(status = RenewalStatus.APPROVED, confirmationNumber = "CURRENT-456")
        val result = AppData(renewal = current).importReceipt(receipt())
        assertEquals(current, result.renewal)
        assertEquals(1, result.history.size)
        val freshPlan = AppData(renewalStartedAt = 20_000)
        val stale = freshPlan.importReceipt(receipt(time = 10_000))
        assertEquals(RenewalPlan(), stale.renewal)
        val timely = stale.importReceipt(receipt(number = "NEW-789", time = 21_000))
        assertEquals(RenewalStatus.SUBMITTED, timely.renewal.status)
        assertEquals("NEW-789", timely.renewal.confirmationNumber)
    }

    @Test fun renewalCountsCalendarDatesAcrossDST() {
        val zone = ZoneId.of("America/Chicago")
        val now = ZonedDateTime.of(2026, 11, 1, 23, 0, 0, 0, zone).toInstant().toEpochMilli()
        assertEquals(1L, RenewalPlan(dueDate = "2026-11-02").daysUntilDue(now, zone))
        assertNull(RenewalPlan().daysUntilDue(now, zone))
    }

    @Test fun remindersUseActualNoticeAndRemoveCompletedSteps() {
        val zone = ZoneId.of("UTC")
        val now = LocalDate.parse("2026-09-01").atStartOfDay(zone).toInstant().toEpochMilli()
        assertTrue(ReminderPlanner.planned(RenewalPlan(remindersEnabled = true), now, zone).isEmpty())
        val plan = RenewalPlan(dueDate = "2026-09-15", documentsDueDate = "2026-09-15", remindersEnabled = true,
            interviewDate = ZonedDateTime.of(2026, 9, 10, 14, 0, 0, 0, zone).toInstant().toEpochMilli())
        val planned = ReminderPlanner.planned(plan, now, zone)
        assertEquals(4, planned.count { it.id.startsWith("renewal") })
        assertEquals(2, planned.count { it.id.startsWith("interview") })
        assertTrue(planned.all { it.triggerAt > now })
        assertTrue(ReminderPlanner.planned(plan.copy(status = RenewalStatus.SUBMITTED, interviewCompleted = true, documentsSubmitted = true), now, zone).isEmpty())
        assertTrue(ReminderPlanner.planned(plan.copy(status = RenewalStatus.APPROVED), now, zone).isEmpty())
        assertTrue(ReminderPlanner.planned(plan.copy(remindersEnabled = false), now, zone).isEmpty())
    }

    @Test fun profileValidationRejectsInvalidAmountsZIPAndOversizedFields() {
        assertThrows(VaultException::class.java) { ProfileValidation.validate(PersonalProfile(monthlyIncome = "-1")) }
        assertThrows(VaultException::class.java) { ProfileValidation.validate(PersonalProfile(monthlyHousingCost = "$100")) }
        assertThrows(VaultException::class.java) { ProfileValidation.validate(PersonalProfile(postalCode = "503")) }
        assertThrows(VaultException::class.java) { ProfileValidation.validate(PersonalProfile(mobilePhone = "1".repeat(251))) }
        ProfileValidation.validate(PersonalProfile(monthlyIncome = "1234.56", postalCode = "50309-1234"))
        assertThrows(VaultException::class.java) { ProfileValidation.validate(RenewalPlan(dueDate = "2026-02-30")) }
    }

    @Test fun sharingExpiresAndRejectsImplausiblyLongGrants() {
        assertFalse(AutofillSession(expiresAt = 1000, fields = emptyMap()).isValid(1000))
        assertFalse(AutofillSession(expiresAt = 999, fields = emptyMap()).isValid(1000))
        assertFalse(AutofillSession(expiresAt = 601001, fields = emptyMap()).isValid(1000))
        assertTrue(AutofillSession(expiresAt = 601000, fields = emptyMap()).isValid(1000))
    }

    @Test fun documentSignaturesRejectArbitraryHTMLAndSupportPDFImages() {
        assertEquals("application/pdf", DocumentTypes.detect("%PDF-1.7\n".toByteArray()))
        assertEquals("image/jpeg", DocumentTypes.detect(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte())))
        assertNull(DocumentTypes.detect("<html>not an image</html>".toByteArray()))
        assertNull(DocumentTypes.detect(byteArrayOf()))
    }
}

package com.ethanpam.secondhand.core

import java.net.URI
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.UUID

/** All instants use Unix epoch milliseconds; notice-only dates use ISO yyyy-MM-dd. */
data class HouseholdMember(val id: String = UUID.randomUUID().toString(), val name: String = "", val relationship: String = "")

data class PersonalProfile(
    val firstName: String = "", val middleName: String = "", val lastName: String = "",
    val email: String = "", val phone: String = "", val homePhone: String = "", val mobilePhone: String = "",
    val addressLine1: String = "", val addressLine2: String = "", val city: String = "", val state: String = "IA",
    val postalCode: String = "", val household: List<HouseholdMember> = emptyList(),
    val monthlyIncome: String = "", val monthlyHousingCost: String = "", val notes: String = "", val reviewedAt: Long? = null
) {
    val displayName: String get() = if (firstName.isBlank()) "Your next step starts here" else "Welcome back, $firstName"
    val applicationFields: Map<String, String> get() = mapOf(
        "firstName" to firstName, "middleName" to middleName, "lastName" to lastName, "email" to email,
        "homePhone" to homePhone, "mobilePhone" to mobilePhone, "addressLine1" to addressLine1,
        "addressLine2" to addressLine2, "city" to city, "state" to state, "postalCode" to postalCode,
        "monthlyIncome" to monthlyIncome, "monthlyHousingCost" to monthlyHousingCost
    ).filterValues { it.isNotBlank() }
}

enum class RenewalStatus(val title: String, val storedValue: String) {
    PREPARING("Preparing", "preparing"), SUBMITTED("Submitted", "submitted"),
    AWAITING_DECISION("Awaiting a decision", "awaitingDecision"), APPROVED("Approved", "approved")
}

data class RenewalPlan(
    val dueDate: String? = null, val benefitsEndDate: String? = null,
    val interviewDate: Long? = null, val documentsDueDate: String? = null,
    val status: RenewalStatus = RenewalStatus.PREPARING, val confirmationNumber: String = "",
    val interviewCompleted: Boolean = false, val documentsSubmitted: Boolean = false,
    val remindersEnabled: Boolean = false, val notes: String = ""
) {
    fun daysUntilDue(now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): Long? =
        dueDate?.let { ChronoUnit.DAYS.between(Instant.ofEpochMilli(now).atZone(zone).toLocalDate(), LocalDate.parse(it)) }
}

data class SavedDocument(val id: String = UUID.randomUUID().toString(), val name: String,
                         val mimeType: String, val importedAt: Long = System.currentTimeMillis(), val byteCount: Long)
data class ActivityEntry(val id: String = UUID.randomUUID().toString(), val date: Long = System.currentTimeMillis(),
                         val title: String, val detail: String)

data class AppData(
    val schemaVersion: Int = 1, val profile: PersonalProfile = PersonalProfile(), val renewal: RenewalPlan = RenewalPlan(),
    val documents: List<SavedDocument> = emptyList(), val history: List<ActivityEntry> = emptyList(),
    val importedReceiptIDs: List<String> = emptyList(), val importedReceiptConfirmations: List<String> = emptyList(),
    val renewalStartedAt: Long? = null
) {
    fun withActivity(title: String, detail: String, now: Long = System.currentTimeMillis()): AppData =
        copy(history = (listOf(ActivityEntry(date = now, title = title, detail = detail)) + history).take(100))

    fun importReceipt(receipt: ApplicationReceipt): AppData {
        require(receipt.isValid()) { "Invalid application receipt" }
        if (receipt.id in importedReceiptIDs) return this
        val duplicate = receipt.confirmationNumber in importedReceiptConfirmations
        val next = copy(importedReceiptIDs = importedReceiptIDs + receipt.id,
            importedReceiptConfirmations = if (duplicate) importedReceiptConfirmations else importedReceiptConfirmations + receipt.confirmationNumber)
        if (duplicate || (renewal.confirmationNumber.trim() == receipt.confirmationNumber && renewal.status != RenewalStatus.PREPARING)) return next
        val attach = (renewalStartedAt == null || receipt.recordedAt >= renewalStartedAt) && renewal.status == RenewalStatus.PREPARING &&
            (renewal.confirmationNumber.isBlank() || renewal.confirmationNumber.trim() == receipt.confirmationNumber)
        val plan = if (attach) renewal.copy(status = RenewalStatus.SUBMITTED, confirmationNumber = receipt.confirmationNumber) else renewal
        val association = if (attach) "Your renewal plan was marked submitted." else "Your current renewal plan was left unchanged."
        return next.copy(renewal = plan).withActivity("Reported from application assistant",
            "Confirmation: ${receipt.confirmationNumber}. Entered by you. $association This is not an agency status sync.", receipt.recordedAt)
    }
}

data class AutofillSession(val id: String = UUID.randomUUID().toString(), val expiresAt: Long, val fields: Map<String, String>) {
    fun isValid(now: Long = System.currentTimeMillis()): Boolean = expiresAt > now && expiresAt - now <= 600_000
}

data class ApplicationReceipt(val id: String, val confirmationNumber: String, val pageURL: String,
                              val recordedAt: Long = System.currentTimeMillis()) {
    fun isValid(): Boolean = validUUID(id) && confirmationNumber.matches(Regex("[A-Za-z0-9][A-Za-z0-9 -]{1,78}[A-Za-z0-9]")) &&
        IowaApplicationBridge.allowsApplicationPage(pageURL) && recordedAt > 0
}

fun validUUID(value: String): Boolean = value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))

object IowaApplicationBridge {
    val allowedFieldKeys: Set<String> = setOf("firstName", "middleName", "lastName", "email", "homePhone", "mobilePhone",
        "addressLine1", "addressLine2", "city", "state", "postalCode", "monthlyIncome", "monthlyHousingCost")
    fun allowsApplicationPage(value: String): Boolean = runCatching {
        require(value.length <= 1_000)
        val url = URI(value)
        require(url.scheme.equals("https", true) && url.host.equals("hhsservices.iowa.gov", true))
        require(url.port == -1 || url.port == 443)
        require(url.rawUserInfo == null && url.rawQuery == null && url.rawFragment == null)
        val prefix = "/apspssp/ssp.portal/applyForBenefits/"
        require(url.rawPath.startsWith(prefix))
        val route = url.rawPath.removePrefix(prefix)
        require(route.length in 1..200 && route.matches(Regex("[A-Za-z][A-Za-z0-9_-]*(/[A-Za-z][A-Za-z0-9_-]*)*")))
        val compact = route.lowercase().replace(Regex("[^a-z0-9]"), "")
        require(listOf("signup", "register", "registration", "account", "profile", "login", "logon", "signin",
            "authentication", "password", "recovery", "logout").none { it in compact })
        true
    }.getOrDefault(false)
}

object IowaResources {
    const val portal = "https://hhsservices.iowa.gov/apspssp/ssp.portal"
    const val apply = "https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap"
    const val snap = "https://hhs.iowa.gov/assistance-programs/food-assistance/snap"
}

class VaultException(message: String) : Exception(message)

object ProfileValidation {
    fun validate(profile: PersonalProfile) {
        val strings = listOf(profile.firstName, profile.middleName, profile.lastName, profile.email, profile.phone, profile.homePhone,
            profile.mobilePhone, profile.addressLine1, profile.addressLine2, profile.city, profile.state, profile.postalCode)
        if (strings.any { it.length > 250 } || profile.notes.length > 10_000 || profile.household.size > 30 ||
            profile.household.any { !validUUID(it.id) || it.name.length > 250 || it.relationship.length > 250 })
            throw VaultException("One of your entries is too long. Shorten it and try again.")
        if (profile.email.isNotEmpty() && (!profile.email.contains('@') || profile.email.any(Char::isWhitespace)))
            throw VaultException("Enter a valid email address, or leave it blank.")
        if (profile.postalCode.isNotEmpty() && !profile.postalCode.matches(Regex("[0-9]{5}(-[0-9]{4})?")))
            throw VaultException("Enter a five-digit ZIP code, optionally followed by four more digits.")
        if (listOf(profile.monthlyIncome, profile.monthlyHousingCost).any { it.isNotEmpty() && !it.matches(Regex("[0-9]{1,9}(\\.[0-9]{1,2})?")) })
            throw VaultException("Enter monthly amounts as numbers, such as 1250.50, without dollar signs or commas.")
    }

    fun validate(plan: RenewalPlan) {
        if (plan.notes.length > 10_000 || plan.confirmationNumber.length > 250) throw VaultException("Shorten your notes or confirmation number.")
        try { listOfNotNull(plan.dueDate, plan.benefitsEndDate, plan.documentsDueDate).forEach { LocalDate.parse(it) } }
        catch (_: Exception) { throw VaultException("Use a valid date from your Iowa HHS notice.") }
        if (plan.interviewDate != null && plan.interviewDate <= 0) throw VaultException("Choose a valid interview date and time.")
    }
}

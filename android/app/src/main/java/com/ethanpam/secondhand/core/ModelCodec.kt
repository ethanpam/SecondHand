package com.ethanpam.secondhand.core

import org.json.JSONArray
import org.json.JSONObject

/** Explicit defaults migrate older local records. Malformed/future records fail closed. */
object ModelCodec {
    fun encode(data: AppData): ByteArray = JSONObject().apply {
        put("schemaVersion", data.schemaVersion)
        put("profile", encodeProfile(data.profile))
        put("renewal", encodeRenewal(data.renewal))
        put("documents", JSONArray(data.documents.map { doc -> JSONObject().apply {
            put("id", doc.id); put("name", doc.name); put("mimeType", doc.mimeType)
            put("importedAt", doc.importedAt); put("byteCount", doc.byteCount)
        } }))
        put("history", JSONArray(data.history.map { entry -> JSONObject().apply {
            put("id", entry.id); put("date", entry.date); put("title", entry.title); put("detail", entry.detail)
        } }))
        put("importedReceiptIDs", JSONArray(data.importedReceiptIDs))
        put("importedReceiptConfirmations", JSONArray(data.importedReceiptConfirmations))
        put("renewalStartedAt", data.renewalStartedAt ?: JSONObject.NULL)
    }.toString().toByteArray(Charsets.UTF_8)

    fun decode(bytes: ByteArray): AppData {
        require(bytes.size <= 2 * 1024 * 1024) { "Vault record is too large" }
        val root = JSONObject(bytes.toString(Charsets.UTF_8))
        val version = if (root.has("schemaVersion")) root.getInt("schemaVersion") else 1
        if (version != 1) throw VaultException("This data was saved by another app version. Update Second Hand before opening it.")
        val data = AppData(schemaVersion = version,
            profile = decodeProfile(root.optionalObject("profile")), renewal = decodeRenewal(root.optionalObject("renewal")),
            documents = root.array("documents").objects().map { doc ->
                SavedDocument(doc.getString("id"), doc.getString("name"), doc.getString("mimeType"), doc.getLong("importedAt"), doc.getLong("byteCount"))
            },
            history = root.array("history").objects().map { entry ->
                ActivityEntry(entry.getString("id"), entry.getLong("date"), entry.getString("title"), entry.getString("detail"))
            },
            importedReceiptIDs = root.array("importedReceiptIDs").strings(),
            importedReceiptConfirmations = root.array("importedReceiptConfirmations").strings(),
            renewalStartedAt = root.optionalLong("renewalStartedAt"))
        ProfileValidation.validate(data.profile)
        ProfileValidation.validate(data.renewal)
        require(data.documents.size <= 50 && data.history.size <= 100)
        require(data.documents.all { validUUID(it.id) && it.name.length <= 250 && it.byteCount in 1..SecureVault.MAX_DOCUMENT_BYTES && it.mimeType.length <= 100 })
        require(data.documents.map { it.id }.distinct().size == data.documents.size)
        require(data.importedReceiptIDs.all(::validUUID))
        return data
    }

    private fun encodeProfile(profile: PersonalProfile): JSONObject = JSONObject().apply {
        listOf("firstName" to profile.firstName, "middleName" to profile.middleName, "lastName" to profile.lastName,
            "email" to profile.email, "phone" to profile.phone, "homePhone" to profile.homePhone, "mobilePhone" to profile.mobilePhone,
            "addressLine1" to profile.addressLine1, "addressLine2" to profile.addressLine2, "city" to profile.city,
            "state" to profile.state, "postalCode" to profile.postalCode, "monthlyIncome" to profile.monthlyIncome,
            "monthlyHousingCost" to profile.monthlyHousingCost, "notes" to profile.notes).forEach { (key, value) -> put(key, value) }
        put("reviewedAt", profile.reviewedAt ?: JSONObject.NULL)
        put("household", JSONArray(profile.household.map { member -> JSONObject().apply {
            put("id", member.id); put("name", member.name); put("relationship", member.relationship)
        } }))
    }

    private fun decodeProfile(obj: JSONObject): PersonalProfile = PersonalProfile(
        firstName = obj.string("firstName"), middleName = obj.string("middleName"), lastName = obj.string("lastName"),
        email = obj.string("email"), phone = obj.string("phone"), homePhone = obj.string("homePhone"), mobilePhone = obj.string("mobilePhone"),
        addressLine1 = obj.string("addressLine1"), addressLine2 = obj.string("addressLine2"), city = obj.string("city"),
        state = obj.string("state", "IA"), postalCode = obj.string("postalCode"),
        monthlyIncome = obj.string("monthlyIncome"), monthlyHousingCost = obj.string("monthlyHousingCost"), notes = obj.string("notes"),
        reviewedAt = obj.optionalLong("reviewedAt"), household = obj.array("household").objects().map {
            HouseholdMember(it.getString("id"), it.string("name"), it.string("relationship"))
        })

    private fun encodeRenewal(plan: RenewalPlan): JSONObject = JSONObject().apply {
        put("dueDate", plan.dueDate ?: JSONObject.NULL); put("benefitsEndDate", plan.benefitsEndDate ?: JSONObject.NULL)
        put("interviewDate", plan.interviewDate ?: JSONObject.NULL); put("documentsDueDate", plan.documentsDueDate ?: JSONObject.NULL)
        put("status", plan.status.storedValue); put("confirmationNumber", plan.confirmationNumber)
        put("interviewCompleted", plan.interviewCompleted); put("documentsSubmitted", plan.documentsSubmitted)
        put("remindersEnabled", plan.remindersEnabled); put("notes", plan.notes)
    }

    private fun decodeRenewal(obj: JSONObject): RenewalPlan = RenewalPlan(
        dueDate = obj.optionalString("dueDate"), benefitsEndDate = obj.optionalString("benefitsEndDate"),
        interviewDate = obj.optionalLong("interviewDate"), documentsDueDate = obj.optionalString("documentsDueDate"),
        status = RenewalStatus.entries.first { it.storedValue == obj.string("status", "preparing") },
        confirmationNumber = obj.string("confirmationNumber"), interviewCompleted = obj.bool("interviewCompleted"),
        documentsSubmitted = obj.bool("documentsSubmitted"), remindersEnabled = obj.bool("remindersEnabled"), notes = obj.string("notes"))

    private fun JSONObject.string(key: String, default: String = ""): String = if (has(key) && !isNull(key)) getString(key) else default
    private fun JSONObject.optionalString(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null
    private fun JSONObject.optionalLong(key: String): Long? = if (has(key) && !isNull(key)) getLong(key) else null
    private fun JSONObject.bool(key: String): Boolean = if (has(key) && !isNull(key)) getBoolean(key) else false
    private fun JSONObject.array(key: String): JSONArray = if (has(key) && !isNull(key)) getJSONArray(key) else JSONArray()
    private fun JSONObject.optionalObject(key: String): JSONObject = if (has(key) && !isNull(key)) getJSONObject(key) else JSONObject()
    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
    private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
}

package com.ethanpam.secondhand.core

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.annotation.MainThread
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.UUID

data class AppState(val data: AppData = AppData(), val isUnlocked: Boolean = false,
                    val isLoading: Boolean = false, val errorMessage: String? = null, val autofillExpiresAt: Long? = null)

/** Call from the main thread after device authentication. Disk/Keystore work runs on IO. */
@MainThread
class AppStore private constructor(context: Context, private val vaultFactory: (Context) -> SecureVault) {
    constructor(context: Context) : this(context, SecureVault::open)

    companion object {
        /** Instrumentation-only dependency seam; never selected by an Intent or app setting. */
        internal fun forTesting(context: Context, testID: String): AppStore =
            AppStore(context) { SecureVault.openForTesting(it, testID) }
    }

    private val context = context.applicationContext
    private val mutableState = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = mutableState.asStateFlow()
    val data: AppData get() = mutableState.value.data
    val isUnlocked: Boolean get() = mutableState.value.isUnlocked
    private val mutex = Mutex()
    private var vault: SecureVault? = null
    private var generation = 0L
    private var sharing: AutofillSession? = null

    suspend fun unlock(): Boolean = mutex.withLock {
        if (isUnlocked) return@withLock true
        val expected = generation
        mutableState.value = mutableState.value.copy(isLoading = true, errorMessage = null)
        try {
            val (storage, restored) = withContext(Dispatchers.IO) {
                val storage = vaultFactory(context)
                storage to storage.load()
            }
            if (expected != generation) return@withLock false
            vault = storage
            mutableState.value = AppState(data = restored, isUnlocked = true)
            try { withContext(Dispatchers.IO) { ReminderScheduler.synchronize(context, restored.renewal) } }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) {
                if (expected == generation) mutableState.value = mutableState.value.copy(errorMessage = "Your data opened, but reminders could not be scheduled. Review your notification settings.")
            }
            expected == generation && isUnlocked
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (expected == generation) {
                vault = null
                mutableState.value = AppState(errorMessage = if (error is VaultException) error.message else
                    "Your protected data could not be opened. Unlock your device and try again. Existing data has not been replaced.")
            }
            false
        } finally {
            if (expected == generation) mutableState.value = mutableState.value.copy(isLoading = false)
        }
    }

    fun lock() {
        generation++
        sharing = null
        vault = null
        mutableState.value = AppState()
    }

    fun clearError() { mutableState.value = mutableState.value.copy(errorMessage = null) }

    suspend fun saveProfile(profile: PersonalProfile) = safely("Your profile could not be saved. Try again.") {
        ProfileValidation.validate(profile)
        mutex.withLock {
            storage()
            revokeAutofill()
            val next = data.copy(profile = profile.copy(household = profile.household.map { it.copy() }))
                .withActivity("Profile updated", if (profile.reviewedAt == null) "Saved on this device." else "You confirmed your information is current.")
            commit(next)
        }
    }

    suspend fun saveRenewal(plan: RenewalPlan) = safely("Your renewal plan could not be saved. Try again.") {
        ProfileValidation.validate(plan)
        if (plan.remindersEnabled && !ReminderScheduler.canPostNotifications(context))
            throw VaultException("Allow notifications in Android Settings, or save with reminders switched off.")
        mutex.withLock {
            storage()
            val title = if (data.renewal.status == plan.status) "Renewal plan updated" else plan.status.title
            commit(data.copy(renewal = plan).withActivity(title, "Recorded by you. Check your Iowa HHS notice for official case information."))
            synchronizeReminders(plan)
        }
    }

    suspend fun startNewRenewal() = safely("A new renewal could not be started. Try again.") {
        mutex.withLock {
            storage()
            val previous = data.renewal
            val detail = "${previous.dueDate ?: "No return-by date"} · ${previous.status.title}" +
                if (previous.confirmationNumber.isEmpty()) "" else " · Confirmation: ${previous.confirmationNumber}"
            val next = data.copy(renewal = RenewalPlan(), renewalStartedAt = System.currentTimeMillis())
                .withActivity("Previous renewal archived", detail)
            revokeAutofill()
            commit(next)
            synchronizeReminders(next.renewal)
        }
    }

    fun authorizeAutofill() {
        storage()
        val now = System.currentTimeMillis()
        val profile = data.profile
        if (profile.firstName.isBlank() && profile.lastName.isBlank()) throw VaultException("Add your name to your profile first.")
        if (profile.reviewedAt == null || profile.reviewedAt > now || now - profile.reviewedAt >= 86_400_000)
            throw VaultException("Review your profile and confirm it is current before allowing application sharing.")
        val session = AutofillSession(expiresAt = now + 600_000, fields = profile.applicationFields.toMap())
        sharing = session
        mutableState.value = mutableState.value.copy(autofillExpiresAt = session.expiresAt)
    }

    fun revokeAutofill() {
        sharing = null
        mutableState.value = mutableState.value.copy(autofillExpiresAt = null)
    }

    fun currentAssistantGrant(): AutofillSession? {
        if (!isUnlocked) return null
        val session = sharing ?: return null
        if (!session.isValid()) { revokeAutofill(); return null }
        return session.copy(fields = session.fields.toMap())
    }

    fun applicationFields(pageURL: String, keys: Collection<String>): Map<String, String> {
        if (!IowaApplicationBridge.allowsApplicationPage(pageURL) || keys.isEmpty() || keys.size > IowaApplicationBridge.allowedFieldKeys.size ||
            keys.toSet().size != keys.size || !IowaApplicationBridge.allowedFieldKeys.containsAll(keys))
            throw VaultException("This application page or field request is not supported.")
        val session = currentAssistantGrant() ?: throw VaultException("Open Settings and authorize a new application sharing session.")
        return session.fields.filter { (key, value) -> key in keys && value.isNotBlank() && value.length <= 250 }
    }

    suspend fun recordReceipt(confirmationNumber: String, pageURL: String, receiptID: String = UUID.randomUUID().toString()): Boolean =
        safely("Your confirmation could not be saved. Keep a copy and enter it in your renewal plan.") {
            mutex.withLock {
                storage()
                currentAssistantGrant() ?: throw VaultException("Authorize a new application sharing session before saving this confirmation.")
                val receipt = ApplicationReceipt(receiptID, confirmationNumber.trim(), pageURL)
                if (!receipt.isValid()) throw VaultException("Enter a confirmation number of 3–80 letters, numbers, spaces, or hyphens.")
                val next = data.importReceipt(receipt)
                if (next != data) {
                    commit(next)
                    synchronizeReminders(next.renewal)
                }
                true
            }
        }

    suspend fun importDocument(uri: Uri): SavedDocument = safely("Choose a PDF or supported image smaller than 20 MB.") {
        mutex.withLock {
            val storage = storage()
            val expected = generation
            if (data.documents.size >= 50) throw VaultException("You can keep up to 50 documents. Remove an older file before adding another.")
            require(uri.scheme == "content")
            val (document, bytes) = withContext(Dispatchers.IO) { readImport(uri) }
            var committed = false
            try {
                requireCurrent(expected)
                durableIO { storage.writeDocument(document.id, bytes) }
                requireCurrent(expected)
                commit(data.copy(documents = listOf(document) + data.documents)
                    .withActivity("Document saved", "Stored on this device. It has not been sent to Iowa HHS."))
                committed = true
                document
            } finally {
                bytes.fill(0)
                if (!committed) durableIO { runCatching { storage.deleteDocument(document.id) } }
            }
        }
    }

    suspend fun readDocument(document: SavedDocument): ByteArray = safely("This document could not be opened. Unlock the app and try again.") {
        mutex.withLock {
            val storage = storage()
            val expected = generation
            if (data.documents.none { it.id == document.id }) throw VaultException("This document is no longer saved.")
            val bytes = withContext(Dispatchers.IO) { storage.readDocument(document.id) }
            if (expected != generation || !isUnlocked) { bytes.fill(0); throw VaultException("Unlock Second Hand to view this document.") }
            bytes
        }
    }

    suspend fun deleteDocument(document: SavedDocument) = safely("The document could not be removed. Try again.") {
        mutex.withLock {
            val storage = storage()
            val previous = data
            val expected = generation
            if (previous.documents.none { it.id == document.id }) return@withLock
            commit(previous.copy(documents = previous.documents.filterNot { it.id == document.id }))
            try { durableIO { storage.deleteDocument(document.id) } }
            catch (error: Exception) {
                durableIO { storage.save(previous) }
                if (generation == expected && isUnlocked) mutableState.value = mutableState.value.copy(data = previous)
                throw error
            }
        }
    }

    suspend fun deleteAllData() = safely("Some data could not be removed. Unlock the app and try deleting it again.") {
        mutex.withLock {
            val storage = storage()
            revokeAutofill()
            try {
                durableIO { ReminderScheduler.clear(context); storage.deleteAll() }
            } finally { lock() }
        }
    }

    private fun storage(): SecureVault = vault?.takeIf { isUnlocked } ?: throw VaultException("Unlock Second Hand to access your information.")
    private fun requireCurrent(expected: Long) {
        if (generation != expected || !isUnlocked) throw VaultException("The app locked. Unlock Second Hand to continue.")
    }

    private suspend fun commit(next: AppData) {
        val storage = storage()
        val expected = generation
        durableIO { storage.save(next) }
        // The disk commit succeeded. A simultaneous background lock must not be
        // reported as a failed write or cause callers to roll back document blobs.
        if (expected != generation || !isUnlocked) return
        if (next.profile != data.profile || next.renewalStartedAt != data.renewalStartedAt) revokeAutofill()
        mutableState.value = mutableState.value.copy(data = next)
    }

    private suspend fun synchronizeReminders(plan: RenewalPlan) {
        val expected = generation
        try { withContext(Dispatchers.IO) { ReminderScheduler.synchronize(context, plan) } }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) {
            if (generation == expected && isUnlocked) mutableState.value = mutableState.value.copy(
                errorMessage = "Your plan was saved, but reminders could not be scheduled. Open the plan to try again.")
        }
    }

    private suspend fun <T> safely(message: String, block: suspend () -> T): T = try { block() }
        catch (error: CancellationException) { throw error }
        catch (error: VaultException) { throw error }
        catch (_: Exception) { throw VaultException(message) }

    // Once an atomic mutation starts, finish it and its bookkeeping even if the
    // calling screen is disposed. Lock generation still prevents memory exposure.
    private suspend fun <T> durableIO(block: () -> T): T = withContext(NonCancellable) { withContext(Dispatchers.IO) { block() } }

    private fun readImport(uri: Uri): Pair<SavedDocument, ByteArray> {
        val resolver = context.contentResolver
        var name = "Document"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) require(cursor.getLong(sizeIndex) <= SecureVault.MAX_DOCUMENT_BYTES)
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex)
            }
        }
        val bytes = resolver.openInputStream(uri)?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                require(total <= SecureVault.MAX_DOCUMENT_BYTES)
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        } ?: throw VaultException("This file could not be opened.")
        try {
            require(bytes.isNotEmpty())
            val mime = DocumentTypes.detect(bytes) ?: throw VaultException("Choose a PDF, JPEG, PNG, GIF, WebP, or HEIF image.")
            val cleanName = name.filterNot { it.isISOControl() || it in '\u202A'..'\u202E' || it in '\u2066'..'\u2069' }.take(250).ifBlank { "Document" }
            return SavedDocument(name = cleanName, mimeType = mime, byteCount = bytes.size.toLong()) to bytes
        } catch (error: Exception) { bytes.fill(0); throw error }
    }
}

object DocumentTypes {
    fun detect(bytes: ByteArray): String? {
        fun begins(value: ByteArray): Boolean = bytes.size >= value.size && value.indices.all { bytes[it] == value[it] }
        if (begins("%PDF-".toByteArray())) return "application/pdf"
        if (begins(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte()))) return "image/jpeg"
        if (begins(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))) return "image/png"
        if (begins("GIF87a".toByteArray()) || begins("GIF89a".toByteArray())) return "image/gif"
        if (bytes.size >= 12 && bytes.copyOfRange(0, 4).contentEquals("RIFF".toByteArray()) && bytes.copyOfRange(8, 12).contentEquals("WEBP".toByteArray())) return "image/webp"
        if (bytes.size >= 12 && bytes.copyOfRange(4, 8).contentEquals("ftyp".toByteArray()) &&
            bytes.copyOfRange(8, 12).toString(Charsets.US_ASCII) in setOf("heic", "heix", "hevc", "hevx", "mif1")) return "image/heif"
        return null
    }
}

package com.ethanpam.secondhand.core

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import java.util.UUID

/** Synthetic-only, isolated files + Keystore alias: never clears the app's user vault. */
@RunWith(AndroidJUnit4::class)
class ProtectedStorageInstrumentedTest {
    private lateinit var testContext: Context
    private lateinit var testDirectory: File
    private lateinit var testID: String

    @Before fun isolateStorage() {
        val target = InstrumentationRegistry.getInstrumentation().targetContext
        assumeTrue(target.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        testID = UUID.randomUUID().toString()
        testDirectory = File(target.noBackupFilesDir, "instrumentation-$testID").apply { mkdirs() }
        testContext = object : ContextWrapper(target) {
            override fun getNoBackupFilesDir(): File = testDirectory
            override fun getApplicationContext(): Context = this
        }
    }

    @After fun cleanOnlySyntheticStorage() {
        if (::testContext.isInitialized) {
            runCatching { SecureVault.openForTesting(testContext, testID).deleteAll() }
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("${testContext.packageName}.instrumentation.$testID.vault.v1") }
        }
        if (::testDirectory.isInitialized) testDirectory.deleteRecursively()
    }

    @Test fun actualKeystoreEncryptsProfileAndDocumentsAndRejectsSwaps() {
        val vault = SecureVault.openForTesting(testContext, testID)
        val marker = "SYNTHETIC-PRIVATE-TEST-9472"
        val data = AppData(profile = PersonalProfile(firstName = marker))
        vault.save(data)
        assertEquals(data, SecureVault.openForTesting(testContext, testID).load())
        val bytes = File(testDirectory, "vault-v1/profile.sealed").readBytes()
        assertFalse(bytes.toString(Charsets.ISO_8859_1).contains(marker))
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey("${testContext.packageName}.instrumentation.$testID.vault.v1", null)
        assertNull("Keystore secret material must not be exportable", key.encoded)

        val first = UUID.randomUUID().toString()
        val second = UUID.randomUUID().toString()
        val pdf = "%PDF-1.7\nSynthetic test document\n%%EOF".toByteArray()
        vault.writeDocument(first, pdf)
        assertArrayEquals(pdf, vault.readDocument(first))
        val original = File(testDirectory, "vault-v1/document-$first.sealed")
        original.copyTo(File(testDirectory, "vault-v1/document-$second.sealed"))
        assertThrows(Exception::class.java) { vault.readDocument(second) }
        val tampered = bytes.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() }
        File(testDirectory, "vault-v1/profile.sealed").writeBytes(tampered)
        assertThrows(Exception::class.java) { SecureVault.openForTesting(testContext, testID).load() }
        assertArrayEquals(tampered, File(testDirectory, "vault-v1/profile.sealed").readBytes())
        vault.deleteDocument(first)
        assertFalse(original.exists())
    }

    @Test fun storeLockReloadAndGrantRevocationUseProtectedStorage() = runBlocking {
        withContext(Dispatchers.Main) {
            val store = AppStore.forTesting(testContext, testID)
            assertTrue(store.unlock())
            assertNull("Framework reminder calls must not be hidden by invalid test package identity", store.state.value.errorMessage)
            val profile = PersonalProfile(firstName = "Synthetic", middleName = "M", phone = "reference-only",
                homePhone = "5155550100", monthlyIncome = "1000", notes = "never-share",
                household = listOf(HouseholdMember(name = "Private")), reviewedAt = System.currentTimeMillis())
            store.saveProfile(profile)
            store.authorizeAutofill()
            val grant = requireNotNull(store.currentAssistantGrant())
            assertEquals("5155550100", grant.fields["homePhone"])
            assertFalse(grant.fields.containsKey("phone"))
            assertFalse(grant.fields.values.contains("never-share"))
            store.lock()
            assertFalse(store.state.value.isUnlocked)
            assertEquals(AppData(), store.state.value.data)
            assertNull(store.currentAssistantGrant())
            assertTrue(store.unlock())
            assertEquals(profile, store.state.value.data.profile)
            assertNull(store.currentAssistantGrant())
            store.authorizeAutofill()
            val beforeEdit = requireNotNull(store.currentAssistantGrant()).id
            store.saveProfile(profile.copy(middleName = "Changed"))
            assertNull(store.currentAssistantGrant())
            store.authorizeAutofill()
            assertNotEquals(beforeEdit, requireNotNull(store.currentAssistantGrant()).id)
            store.revokeAutofill()
            assertNull(store.currentAssistantGrant())
            store.lock()
        }
    }
}

package com.ethanpam.secondhand.core

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.util.UUID
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class SecureVault private constructor(private val directory: File, private val cipher: VaultCipher, private val keyAlias: String) {
    fun load(): AppData {
        val file = File(directory, "profile.sealed")
        if (!file.exists()) {
            check(directory.listFiles().orEmpty().none { it.name.endsWith(".sealed") })
            return AppData()
        }
        require(file.length() <= 2 * 1024 * 1024 + 100)
        val plaintext = cipher.open(file.readBytes(), "profile")
        return try { ModelCodec.decode(plaintext) } finally { plaintext.fill(0) }
    }

    fun save(data: AppData) {
        val plaintext = ModelCodec.encode(data)
        try {
            require(plaintext.size <= 2 * 1024 * 1024)
            atomicWrite(File(directory, "profile.sealed"), cipher.seal(plaintext, "profile"))
        } finally { plaintext.fill(0) }
    }

    fun writeDocument(id: String, bytes: ByteArray) {
        require(bytes.size.toLong() in 1..MAX_DOCUMENT_BYTES)
        atomicWrite(documentFile(id), cipher.seal(bytes, "document:$id"))
    }

    fun readDocument(id: String): ByteArray {
        val file = documentFile(id)
        require(file.length() in 1..MAX_DOCUMENT_BYTES + 100)
        return cipher.open(file.readBytes(), "document:$id").also { require(it.size.toLong() in 1..MAX_DOCUMENT_BYTES) }
    }

    fun deleteDocument(id: String) { Files.deleteIfExists(documentFile(id).toPath()) }
    private fun documentFile(id: String): File {
        require(validUUID(id))
        return File(directory, "document-$id.sealed")
    }

    fun deleteAll() {
        directory.listFiles()?.forEach { Files.delete(it.toPath()) }
        // Remove key only after every encrypted record was successfully removed.
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        keyStore.deleteEntry(keyAlias)
    }

    companion object {
        const val MAX_DOCUMENT_BYTES = 20L * 1024 * 1024

        fun open(context: Context): SecureVault = openWithAlias(context, "${context.packageName}.vault.v1")

        internal fun openForTesting(context: Context, testID: String): SecureVault {
            require(validUUID(testID))
            return openWithAlias(context, "${context.packageName}.instrumentation.$testID.vault.v1")
        }

        private fun openWithAlias(context: Context, keyAlias: String): SecureVault {
            val root = File(context.noBackupFilesDir, "vault-v1")
            check(root.isDirectory || root.mkdirs())
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val existing = keyStore.getKey(keyAlias, null) as? SecretKey
            val key = existing ?: run {
                // Never silently replace an absent key if encrypted data remains.
                check(root.listFiles().orEmpty().none { it.name.endsWith(".sealed") })
                KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                    init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setRandomizedEncryptionRequired(true).setUnlockedDeviceRequired(true).build())
                }.generateKey()
            }
            return SecureVault(root, VaultCipher(key), keyAlias)
        }

        /** Same-directory atomic replacement; failure never falls back to plaintext. */
        internal fun atomicWrite(file: File, bytes: ByteArray) {
            val temporary = File(file.parentFile, ".${UUID.randomUUID()}.tmp")
            try {
                FileOutputStream(temporary).use { output -> output.write(bytes); output.fd.sync() }
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } finally {
                // Cleanup is best-effort and cannot turn a completed commit into a reported failure.
                temporary.delete()
            }
        }
    }
}

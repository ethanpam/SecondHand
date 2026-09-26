package com.ethanpam.secondhand.core

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Versioned, authenticated envelope; AAD prevents swapping profile/document records. */
class VaultCipher(private val key: SecretKey) {
    fun seal(plaintext: ByteArray, record: String): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        require(cipher.iv.size == 12)
        cipher.updateAAD(aad(record))
        return MAGIC + cipher.iv + cipher.doFinal(plaintext)
    }

    fun open(envelope: ByteArray, record: String): ByteArray {
        require(envelope.size >= MAGIC.size + 12 + 16 && envelope.copyOfRange(0, MAGIC.size).contentEquals(MAGIC))
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, envelope.copyOfRange(MAGIC.size, MAGIC.size + 12)))
        cipher.updateAAD(aad(record))
        return cipher.doFinal(envelope, MAGIC.size + 12, envelope.size - MAGIC.size - 12)
    }

    private fun aad(record: String) = "secondhand:envelope-v1:$record".toByteArray(Charsets.UTF_8)
    companion object { private val MAGIC = byteArrayOf(0x53, 0x48, 0x56, 0x01) }
}

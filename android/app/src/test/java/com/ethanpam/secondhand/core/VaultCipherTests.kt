package com.ethanpam.secondhand.core

import org.junit.Assert.*
import org.junit.Test
import javax.crypto.KeyGenerator

class VaultCipherTests {
    private fun key() = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    @Test fun encryptedRoundTripHasFreshNonceAndNoPlaintext() {
        val cipher = VaultCipher(key())
        val plaintext = "PRIVATE-NAME-AND-DOCUMENT-72591".toByteArray()
        val first = cipher.seal(plaintext, "profile")
        val second = cipher.seal(plaintext, "profile")
        assertArrayEquals(plaintext, cipher.open(first, "profile"))
        assertFalse(first.contentEquals(second))
        assertFalse(first.toString(Charsets.ISO_8859_1).contains(plaintext.toString(Charsets.UTF_8)))
    }

    @Test fun tamperingWrongKeyAndCrossRecordSwapsAreRejected() {
        val cipher = VaultCipher(key())
        val sealed = cipher.seal("Private document".toByteArray(), "document:one")
        assertThrows(Exception::class.java) { cipher.open(sealed, "document:two") }
        assertThrows(Exception::class.java) { VaultCipher(key()).open(sealed, "document:one") }
        val tampered = sealed.copyOf()
        tampered[tampered.lastIndex] = (tampered.last().toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { cipher.open(tampered, "document:one") }
    }

    @Test fun unknownEnvelopeAndPlaintextNeverFallBackToUnencryptedReads() {
        val cipher = VaultCipher(key())
        val bytes = cipher.seal("private".toByteArray(), "profile")
        bytes[3] = 99
        assertThrows(Exception::class.java) { cipher.open(bytes, "profile") }
        assertThrows(Exception::class.java) { cipher.open("{\"firstName\":\"private\"}".toByteArray(), "profile") }
    }
}

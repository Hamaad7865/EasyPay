package com.restopos.core.mra

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.util.Base64
import javax.crypto.Cipher

// Held to mra/fixtures/crypto.json, values worked out with openssl, as
// mra/crypto.cjs is.
class MraCryptoTest {
    private val fx = Json.parseToJsonElement(repoFile("mra/fixtures/crypto.json").readText()).jsonObject
    private fun s(o: String, k: String) = fx[o]!!.jsonObject[k]!!.jsonPrimitive.content
    private fun hex(h: String) = h.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun theHashIsTheFixtures() {
        val h = MraCrypto.previousNoteHash(Chained(s("hash", "dateTime"), s("hash", "totalAmtPaid"), s("hash", "brn"), s("hash", "invoiceIdentifier")))
        assertEquals(s("hash", "expected"), h)
    }

    @Test fun theFirstInvoiceOfAKindHasNoPrevious() = assertEquals("0", MraCrypto.previousNoteHash(null))

    @Test fun aesIsTheFixtures() {
        assertEquals(s("aes", "cipherBase64"), MraCrypto.aesEncrypt(hex(s("aes", "keyHex")), s("aes", "plain")))
        assertEquals(s("aes", "plain"), MraCrypto.aesDecrypt(hex(s("aes", "keyHex")), s("aes", "cipherBase64")))
    }

    @Test fun theMrasKeyIsUnwrapped() {
        val k = MraCrypto.unwrapKey(s("unwrap", "keyFromMra"), hex(s("unwrap", "ourKeyHex")))
        assertEquals(s("unwrap", "invoiceKeyBase64"), Base64.getEncoder().encodeToString(k))
    }

    @Test fun aKeyOfAnotherLengthIsRefused() {
        val ours = ByteArray(32)
        val wrapped = MraCrypto.aesEncrypt(ours, Base64.getEncoder().encodeToString(ByteArray(16)))
        assertThrows(IllegalArgumentException::class.java) { MraCrypto.unwrapKey(wrapped, ours) }
    }

    // RSA with PKCS#1 v1.5 pads at random: what the public key seals, the private one opens
    @Test fun theLoginIsSealedWithThePublicKey() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val sealed = MraCrypto.rsaEncrypt(pair.public, """{"username":"u"}""")
        val c = Cipher.getInstance("RSA/ECB/PKCS1Padding").apply { init(Cipher.DECRYPT_MODE, pair.private) }
        assertEquals("""{"username":"u"}""", String(c.doFinal(Base64.getDecoder().decode(sealed)), Charsets.UTF_8))
    }

    // a made-up certificate (mra/fixtures/test-cert.pem), read as the MRA's .crt is read
    @Test fun theCertificatesKeyIsRead() {
        val key = MraCrypto.publicKeyOf(repoFile("mra/fixtures/test-cert.pem").readBytes())
        assertEquals("RSA", key.algorithm)
        assertTrue(MraCrypto.rsaEncrypt(key, "x").isNotEmpty())
    }

    @Test fun aNewKeyIs32RandomBytes() {
        val a = MraCrypto.newAesKey(); val b = MraCrypto.newAesKey()
        assertEquals(32, a.size)
        assertTrue(!a.contentEquals(b))
    }
}

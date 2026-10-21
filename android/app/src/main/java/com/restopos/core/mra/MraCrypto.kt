package com.restopos.core.mra

import java.security.MessageDigest
import java.security.PublicKey
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

// The cryptography of the MRA e-invoicing system (its technical guide v1.3),
// as mra/crypto.cjs does it and held to the same fixed values
// (mra/fixtures/crypto.json):
//   - sign-in: our own random AES-256 key goes with the login in a JSON sealed
//     with the MRA's public key (RSA, PKCS#1 v1.5), then base64;
//   - the MRA answers with a key for invoices: base64 of AES-256-ECB, under
//     our key, of the base64 of the 32 bytes that encrypt invoices;
//   - an invoice list is AES-256-ECB (PKCS#7 padding) under those 32 bytes,
//     then base64;
//   - each invoice carries sha256 of the one before it of its kind, in
//     capital hex: its date and time, amount paid, BRN and number; "0" for
//     the first.
object MraCrypto {
    fun previousNoteHash(prev: Chained?): String {
        if (prev == null) return "0"
        val joined = prev.dateTime + prev.totalAmtPaid + prev.brn + prev.invoiceIdentifier
        return MessageDigest.getInstance("SHA-256").digest(joined.toByteArray(Charsets.UTF_8))
            .joinToString("") { (it.toInt() and 0xFF).toString(16).padStart(2, '0') }.uppercase()
    }

    fun newAesKey(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }

    fun aesEncrypt(key: ByteArray, plain: String): String =
        b64(aes(Cipher.ENCRYPT_MODE, key).doFinal(plain.toByteArray(Charsets.UTF_8)))

    fun aesDecrypt(key: ByteArray, base64: String): String =
        String(aes(Cipher.DECRYPT_MODE, key).doFinal(Base64.getDecoder().decode(base64)), Charsets.UTF_8)

    // the MRA's `key` from the sign-in, as the 32 bytes that encrypt invoices
    fun unwrapKey(keyFromMra: String, ourKey: ByteArray): ByteArray {
        val k = Base64.getDecoder().decode(aesDecrypt(ourKey, keyFromMra).trim())
        require(k.size == 32) { "the key from the MRA is ${k.size} bytes, not 32" }
        return k
    }

    // the public key of the MRA's certificate (.crt, PEM or DER)
    fun publicKeyOf(certificate: ByteArray): PublicKey =
        CertificateFactory.getInstance("X.509").generateCertificate(certificate.inputStream()).publicKey

    fun rsaEncrypt(key: PublicKey, plain: String): String =
        b64(Cipher.getInstance("RSA/ECB/PKCS1Padding").apply { init(Cipher.ENCRYPT_MODE, key) }.doFinal(plain.toByteArray(Charsets.UTF_8)))

    // Java's "PKCS5Padding" is PKCS#7 for AES
    private fun aes(mode: Int, key: ByteArray) =
        Cipher.getInstance("AES/ECB/PKCS5Padding").apply { init(mode, SecretKeySpec(key, "AES")) }

    private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)
}

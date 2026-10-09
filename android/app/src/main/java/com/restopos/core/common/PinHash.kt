package com.restopos.core.common

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

// A staff PIN is checked here, on the tablet, with no network (spec 7.2),
// against the hash the back office stored:
//   pbkdf2-sha256$<iterations>$<salt, base64>$<hash, base64>
// The back office's copy of this is web/lib/pin.ts; they must agree.
object PinHash {
    fun matches(pin: String, stored: String?): Boolean {
        val parts = stored?.split('$') ?: return false
        if (parts.size != 4 || parts[0] != "pbkdf2-sha256") return false
        val iterations = parts[1].toIntOrNull()?.takeIf { it in 1..1_000_000 } ?: return false
        return runCatching {
            val salt = Base64.getDecoder().decode(parts[2])
            val want = Base64.getDecoder().decode(parts[3])
            val spec = PBEKeySpec(pin.toCharArray(), salt, iterations, want.size * 8)
            val got = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
            MessageDigest.isEqual(got, want)
        }.getOrDefault(false)
    }

    // A PIN is set on the tablet too (the first-run set-up): it is hashed
    // here, as web/lib/pin.ts hashes one, and only the hash is sent. The
    // server takes nothing of another shape (0089, pin_hash_ok).
    const val ROUNDS = 20_000
    fun isPin(pin: String): Boolean = pin.length == 4 && pin.all { it in '0'..'9' }

    // Only a test gives the salt.
    fun make(pin: String, salt: ByteArray = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }): String {
        val hash = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(PBEKeySpec(pin.toCharArray(), salt, ROUNDS, 256)).encoded
        val b64 = Base64.getEncoder()
        return listOf("pbkdf2-sha256", ROUNDS.toString(), b64.encodeToString(salt), b64.encodeToString(hash)).joinToString("$")
    }
}

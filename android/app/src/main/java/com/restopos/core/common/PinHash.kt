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
}

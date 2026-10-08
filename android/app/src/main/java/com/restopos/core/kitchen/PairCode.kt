package com.restopos.core.kitchen

import java.security.SecureRandom
import java.util.Random

// The code a kitchen tablet shows, made once when it is set up as a kitchen
// screen. Someone reads it off that screen and types it into the back office,
// under Printers; the tills sign what they send with it. Eight characters
// with no letter or digit that can be taken for another (no I, O, 0 or 1):
// the same ones the back office's page takes.
object PairCode {
    const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    const val LENGTH = 8

    fun make(random: Random = SecureRandom()): String =
        (1..LENGTH).map { ALPHABET[random.nextInt(ALPHABET.length)] }.joinToString("")

    // What was typed, as a code: spaces and dashes dropped, letters made
    // capital. Null when it is not one.
    fun tidy(typed: String?): String? {
        val t = typed.orEmpty().filterNot { it.isWhitespace() || it == '-' }.uppercase()
        return t.takeIf { it.length == LENGTH && it.all { ch -> ch in ALPHABET } }
    }
}

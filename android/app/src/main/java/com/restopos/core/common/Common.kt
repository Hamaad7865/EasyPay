package com.restopos.core.common

import java.security.SecureRandom
import java.util.UUID

// MUR integer cents. No Float/Double for money or quantities, ever (spec 15).
// Quantities are Int thousandths: 1.5 kg = 1500, 2 burgers = 2000.
object Money {
    fun format(cents: Long): String =
        "Rs " + "%,d".format(cents / 100) + if (cents % 100 == 0L) "" else ".%02d".format(cents % 100)

    fun parseRs(input: String): Long? {
        val v = input.replace(",", "").trim().toDoubleOrNull() ?: return null
        if (v < 0) return null
        return Math.round(v * 100)
    }
}

// Client-generated UUIDv7 for everything created on device (spec 5.3/15):
// 48-bit millis + 74 random bits. java.util.randomUUID is v4 (random order),
// which would scatter Room/outbox indexes and hurt sync ordering.
object Uuid7 {
    private val random = SecureRandom()
    fun next(): String {
        val ms = System.currentTimeMillis()
        val rand = ByteArray(10).also { random.nextBytes(it) }
        var msb = (ms shl 16) or ((rand[0].toLong() and 0xFF shl 8) or (rand[1].toLong() and 0xFF))
        var lsb = 0L
        for (i in 2..9) lsb = (lsb shl 8) or (rand[i].toLong() and 0xFF)
        msb = (msb and -0xF001L) or 0x7000L // version 7
        lsb = (lsb and Long.MIN_VALUE.inv() ushr 2 or (2L shl 62)) // variant 10
        return UUID(msb, lsb).toString()
    }
}

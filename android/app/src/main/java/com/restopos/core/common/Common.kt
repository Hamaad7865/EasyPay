package com.restopos.core.common

import java.security.SecureRandom
import java.util.UUID

// MUR integer cents. No Float/Double for money or quantities, ever (spec 15).
// Quantities are Int thousandths: 1.5 kg = 1500, 2 burgers = 2000.
object Money {
    // How many decimals the restaurant shows and prints: 0, 1 or 2. Set from
    // the settings the back office sends (POS settings > Decimals).
    @Volatile var decimals: Int = 2

    fun format(cents: Long): String = (if (cents < 0) "-" else "") + "Rs " + plain(Math.abs(cents))
    // an amount that is taken off: "-Rs 100.00", and plain "Rs 0.00" for nothing

    // the number alone, for the columns of a receipt
    fun plain(cents: Long, places: Int = decimals): String {
        val neg = cents < 0
        val v = Math.abs(cents)
        val body = when (places) {
            0 -> "%,d".format(java.util.Locale.US, (v + 50) / 100)
            1 -> "%,d.%d".format(java.util.Locale.US, (v + 5) / 100, ((v + 5) % 100) / 10)
            else -> "%,d.%02d".format(java.util.Locale.US, v / 100, v % 100)
        }
        return (if (neg) "-" else "") + body
    }

    // What a total is rounded by so it can be paid with the decimals shown:
    // to the rupee with none, to ten cents with one, not at all with two.
    fun roundingFor(total: Long, places: Int = decimals): Long {
        val unit = when (places) { 0 -> 100L; 1 -> 10L; else -> 1L }
        if (unit == 1L) return 0
        val rounded = (total + unit / 2) / unit * unit
        return rounded - total
    }

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

    // When an id made here was created (its first 48 bits), or null for an id
    // that is not a v7.
    fun millis(id: String): Long? {
        val hex = id.replace("-", "")
        if (hex.length != 32 || hex[12] != '7') return null
        return hex.substring(0, 12).toLongOrNull(16)
    }
}

// How a table is called on screen: "Table 4" for a number, the name itself
// when it already says what it is ("Terrace 2", "Bar").
fun tableLabel(name: String): String = if (name.firstOrNull()?.isDigit() == true) "Table $name" else name

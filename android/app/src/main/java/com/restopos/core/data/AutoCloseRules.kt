package com.restopos.core.data

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// When a till closes a day nobody closed, and as of what moment
// (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md).
//
// The cut-off is the first moment at the set time after the day began (it
// was opened, or, with no PINs, its first sale). The day closes once the
// till has been quiet for thirty minutes after the cut-off: no touch, no key
// and nothing that moved money. It is dated by money: at the cut-off when
// nothing moved money since, else thirty minutes after the last thing that
// did, never later than the stretch it was found in. Nothing is written in
// between, so the figures are the same either way.
object AutoCloseRules {
    const val QUIET_MS = 30 * 60_000L
    private val TIME = Regex("^([01][0-9]|2[0-3]):([0-5][0-9])$")

    fun parse(text: String?): LocalTime? = text?.let { TIME.matchEntire(it) }?.let { LocalTime.of(it.groupValues[1].toInt(), it.groupValues[2].toInt()) }

    fun format(at: LocalTime): String = "%02d:%02d".format(at.hour, at.minute)

    fun cutoff(dayFrom: Long, at: LocalTime, zone: ZoneId): Long {
        val start = Instant.ofEpochMilli(dayFrom).atZone(zone)
        var cut = start.toLocalDate().atTime(at).atZone(zone)
        if (!cut.isAfter(start)) cut = cut.plusDays(1)
        return cut.toInstant().toEpochMilli()
    }

    // `lastMoney`: the last sale, refund, cash in or out or count since the
    // day began, or null. `quietFrom` to `quietTo`: a stretch with no touch
    // in it. The moment to close the day as of, or null for not yet.
    fun decide(dayFrom: Long, at: LocalTime, zone: ZoneId, lastMoney: Long?, quietFrom: Long, quietTo: Long): Long? {
        val cut = cutoff(dayFrom, at, zone)
        val wrote = lastMoney?.takeIf { it > cut }
        val from = maxOf(quietFrom, cut, wrote ?: Long.MIN_VALUE)
        if (quietTo - from < QUIET_MS) return null
        return if (wrote == null) cut else minOf(wrote + QUIET_MS, quietTo)
    }

    // What the next person at the till is told, once. `counted` is false for
    // a till with no days, which has no drawer to count.
    fun notice(number: Int, at: Long, carried: Int, zone: ZoneId, counted: Boolean = true): String {
        val time = DateTimeFormatter.ofPattern("d MMM, HH:mm", Locale.UK).format(Instant.ofEpochMilli(at).atZone(zone))
        val drawer = if (counted) " The drawer was not counted." else ""
        val orders = when (carried) {
            0 -> ""
            1 -> " 1 order still unpaid was carried over."
            else -> " $carried orders still unpaid were carried over."
        }
        return "The day was closed automatically ($time, no. $number).$drawer$orders"
    }
}

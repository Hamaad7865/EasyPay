package com.restopos.core.data

import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// When a takeaway is picked up, or a delivery is due: the time turned to on
// the clock while the order is taken (tickets.due_at), and what the kitchen
// is told of it.
object Pickup {
    private val HM = DateTimeFormatter.ofPattern("HH:mm", Locale.US)

    // The moment a time on the clock means: today at that hour and minute;
    // the minute it is now can still be picked. A time that has passed is
    // refused (null), unless it passed more than half a day ago: that is
    // tomorrow's. At ten to midnight, 00:15 is in twenty-five minutes, and
    // the time an order gets by itself can be past midnight too.
    fun at(hour: Int, minute: Int, now: Long, zone: ZoneId): Long? {
        val today: LocalDate = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val time = LocalTime.of(hour.coerceIn(0, 23), minute.coerceIn(0, 59))
        val at = today.atTime(time).atZone(zone).toInstant().toEpochMilli()
        return when {
            at + 59_999 >= now -> at
            now - at > 12 * 3_600_000L -> today.plusDays(1).atTime(time).atZone(zone).toInstant().toEpochMilli()
            else -> null
        }
    }

    fun time(at: Long, zone: ZoneId = ZoneId.systemDefault()): String = HM.format(Instant.ofEpochMilli(at).atZone(zone))

    // The line on the kitchen's paper and on a kitchen screen's card, for an
    // order of that kind (dine | counter | takeaway | delivery | tab).
    fun says(kind: String?, due: Long?, zone: ZoneId = ZoneId.systemDefault()): String? = when {
        due == null -> null
        kind == "takeaway" -> "PICK UP ${time(due, zone)}"
        kind == "delivery" -> "DELIVERY ${time(due, zone)}"
        else -> null
    }
}

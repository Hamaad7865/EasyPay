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

    // The moment a time on the clock means: today at that hour and minute.
    // Null when it has already passed; the minute it is now can still be picked.
    fun at(hour: Int, minute: Int, now: Long, zone: ZoneId): Long? {
        val today: LocalDate = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val at = today.atTime(LocalTime.of(hour.coerceIn(0, 23), minute.coerceIn(0, 59))).atZone(zone).toInstant().toEpochMilli()
        return at.takeIf { it + 59_999 >= now }
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

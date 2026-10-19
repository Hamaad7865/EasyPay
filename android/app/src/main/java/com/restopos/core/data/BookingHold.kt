package com.restopos.core.data

import java.time.Instant
import java.time.ZoneId

// When a booking holds its table on the floor, and when "today's" bookings
// turn over. A confirmed booking held its table all day whatever its time: a
// lunchtime party that never came (and nobody marked) kept the table from
// walk-ins all afternoon, and an evening booking held it at noon.
object BookingHold {
    // from an hour before it until half an hour after (mine, unconfirmed by the owner)
    const val BEFORE_MS = 60 * 60_000L
    const val AFTER_MS = 30 * 60_000L

    fun holds(bookedFor: Long, now: Long): Boolean = now in (bookedFor - BEFORE_MS)..(bookedFor + AFTER_MS)

    // How long until midnight, when "today" is the next day.
    fun untilTomorrow(now: Long, zone: ZoneId): Long {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        return today.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli() - now
    }
}

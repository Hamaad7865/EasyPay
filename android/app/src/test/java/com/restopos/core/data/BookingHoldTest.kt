package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

// A booking holds its table from an hour before it until half an hour after:
// a lunchtime party that never came no longer keeps the table from walk-ins
// all afternoon, and a dinner booking does not hold it at noon.
class BookingHoldTest {
    private val zone = ZoneId.of("Indian/Mauritius")
    private fun at(h: Int, m: Int) = LocalDateTime.of(2026, 10, 20, h, m).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun aBookingHoldsItsTableAroundItsTime() {
        val lunch = at(12, 30)
        assertFalse(BookingHold.holds(lunch, at(11, 29)))
        assertTrue(BookingHold.holds(lunch, at(11, 30)))
        assertTrue(BookingHold.holds(lunch, at(12, 59)))
        assertTrue(BookingHold.holds(lunch, at(13, 0)))
        assertFalse(BookingHold.holds(lunch, at(13, 1)))
    }

    // The bookings of "today" turn over at midnight, on a tablet left on the floor overnight.
    @Test
    fun theDayTurnsOverAtMidnight() {
        assertEquals(30 * 60_000L, BookingHold.untilTomorrow(at(23, 30), zone))
        assertEquals(24 * 3_600_000L, BookingHold.untilTomorrow(at(0, 0), zone))
    }
}

package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

// When a takeaway is picked up: the time turned to on the clock, and what the
// kitchen is told of it. The owner: "at what time will the customer pick up
// his order", and "in the kitchen receipt it should say, the time the
// customer will pick up the order".
class PickupTest {
    private val zone = ZoneId.of("Indian/Mauritius")
    private fun at(h: Int, m: Int, s: Int = 0) = LocalDateTime.of(2026, 10, 13, h, m, s).atZone(zone).toInstant().toEpochMilli()

    @Test
    fun aTimeLaterTodayIsTodayAtThatTime() {
        assertEquals(at(18, 30), Pickup.at(18, 30, at(17, 5, 40), zone))
        assertEquals(at(23, 59), Pickup.at(23, 59, at(0, 0), zone))
    }

    @Test
    fun theMinuteItIsNowCanStillBePicked() {
        assertEquals(at(17, 5), Pickup.at(17, 5, at(17, 5, 40), zone))
    }

    @Test
    fun aTimeAlreadyPastIsRefused() {
        assertNull(Pickup.at(17, 4, at(17, 5, 40), zone))
        assertNull(Pickup.at(18, 0, at(19, 0), zone))
        assertNull(Pickup.at(12, 0, at(23, 50), zone))
    }

    // An order rung up at ten to midnight is given 00:05 by itself; the clock must take that time too.
    @Test
    fun lateInTheEveningATimeOfTheSmallHoursIsTomorrows() {
        val tomorrow = { h: Int, m: Int -> LocalDateTime.of(2026, 10, 14, h, m).atZone(zone).toInstant().toEpochMilli() }
        assertEquals(tomorrow(0, 15), Pickup.at(0, 15, at(23, 50), zone))
        assertEquals(tomorrow(0, 3), Pickup.at(0, 3, at(23, 55), zone))
        assertEquals(tomorrow(1, 30), Pickup.at(1, 30, at(21, 0), zone))
    }

    @Test
    fun theKitchenIsToldWhenATakeawayIsPickedUp() {
        assertEquals("PICK UP 18:30", Pickup.says("takeaway", at(18, 30), zone))
        assertEquals("PICK UP 09:05", Pickup.says("takeaway", at(9, 5), zone))
        assertEquals("DELIVERY 18:30", Pickup.says("delivery", at(18, 30), zone))
    }

    @Test
    fun anOrderThatIsNotCollectedOrHasNoTimeSaysNothing() {
        assertNull(Pickup.says("dine", at(18, 30), zone))
        assertNull(Pickup.says("counter", at(18, 30), zone))
        assertNull(Pickup.says(null, at(18, 30), zone))
        assertNull(Pickup.says("takeaway", null, zone))
    }
}

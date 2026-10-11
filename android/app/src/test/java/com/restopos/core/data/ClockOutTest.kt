package com.restopos.core.data

import com.restopos.core.database.PunchEntity
import org.junit.Assert.assertEquals
import org.junit.Test

// Closing a till's day clocks out everyone still clocked in who clocked in on that till.
class ClockOutTest {
    private var n = 0
    private fun punch(who: String, kind: String, at: Long, till: String? = "t1", gone: Boolean = false) =
        PunchEntity("p${n++}", "tenant", "store", till, who, kind, at, deleted_at = if (gone) "2026-10-11" else null)

    @Test fun `whoever is still clocked in on this till is clocked out, in the order they came`() {
        val punches = listOf(
            punch("aisha", "in", 100), punch("ben", "in", 200), punch("ben", "out", 300),
            punch("chloe", "in", 50), punch("ben", "in", 400),
        )
        assertEquals(listOf("chloe", "aisha", "ben"), ClockOut.stillIn(punches, "t1"))
    }

    @Test fun `someone who clocked out, or never clocked in, is left alone`() {
        assertEquals(emptyList<String>(), ClockOut.stillIn(listOf(punch("aisha", "in", 100), punch("aisha", "out", 200)), "t1"))
        assertEquals(emptyList<String>(), ClockOut.stillIn(emptyList(), "t1"))
        // the order they are kept in does not matter: the moment does
        assertEquals(emptyList<String>(), ClockOut.stillIn(listOf(punch("aisha", "out", 200), punch("aisha", "in", 100)), "t1"))
    }

    @Test fun `someone who clocked in at another till is not sent home by this one closing`() {
        val punches = listOf(punch("aisha", "in", 100, till = "t1"), punch("ben", "in", 150, till = "t2"), punch("chloe", "in", 160, till = null))
        // a punch that names no till (made before punches named one) is the store's, and is clocked out
        assertEquals(listOf("aisha", "chloe"), ClockOut.stillIn(punches, "t1"))
        assertEquals(listOf("ben", "chloe"), ClockOut.stillIn(punches, "t2"))
        // clocked in here this morning, out and in again at the other till: theirs now
        val moved = punches + punch("aisha", "out", 300, till = "t1") + punch("aisha", "in", 310, till = "t2")
        assertEquals(listOf("chloe"), ClockOut.stillIn(moved, "t1"))
    }

    @Test fun `a punch that was removed is not one`() {
        assertEquals(listOf("aisha"), ClockOut.stillIn(listOf(punch("aisha", "in", 100), punch("aisha", "out", 200, gone = true)), "t1"))
        assertEquals(emptyList<String>(), ClockOut.stillIn(listOf(punch("aisha", "in", 100, gone = true)), "t1"))
    }

    @Test fun `the closing says who`() {
        assertEquals("", ClockOut.said(emptyList()))
        assertEquals("Aisha was clocked out.", ClockOut.said(listOf("Aisha")))
        assertEquals("Aisha and Ben were clocked out.", ClockOut.said(listOf("Aisha", "Ben")))
        assertEquals("Aisha, Ben and 1 other were clocked out.", ClockOut.said(listOf("Aisha", "Ben", "Chloe")))
        assertEquals("Aisha, Ben and 2 others were clocked out.", ClockOut.said(listOf("Aisha", "Ben", "Chloe", "Dev")))
    }
}

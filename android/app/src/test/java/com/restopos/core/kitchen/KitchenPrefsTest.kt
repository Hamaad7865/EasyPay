package com.restopos.core.kitchen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// What a kitchen may set on its own screen: after how many minutes a ticket
// turns amber and then red. A ticket that is late and does not look it is a
// table left waiting.
class KitchenPrefsTest {
    private val min = 60_000L

    @Test
    fun aTicketIsFreshThenAmberThenRed() {
        val p = KitchenPrefs()
        assertEquals(KitchenPrefs.Tone.Fresh, p.tone(0))
        assertEquals(KitchenPrefs.Tone.Fresh, p.tone(8 * min - 1))
        assertEquals(KitchenPrefs.Tone.Amber, p.tone(8 * min))
        assertEquals(KitchenPrefs.Tone.Amber, p.tone(15 * min - 1))
        assertEquals(KitchenPrefs.Tone.Red, p.tone(15 * min))
        assertEquals(KitchenPrefs.Tone.Red, p.tone(3 * 60 * min))
        assertFalse(p.late(15 * min - 1))
        assertTrue(p.late(15 * min))
    }

    @Test
    fun aBarSetsItsOwnMinutes() {
        val bar = KitchenPrefs(amberMin = 3, redMin = 5)
        assertEquals(KitchenPrefs.Tone.Amber, bar.tone(3 * min))
        assertEquals(KitchenPrefs.Tone.Red, bar.tone(5 * min))
    }

    // a clock that was wrong, or put right, must not make a ticket older than nothing
    @Test
    fun anAgeBelowNothingIsFresh() {
        assertEquals(KitchenPrefs.Tone.Fresh, KitchenPrefs().tone(-5 * min))
    }

    @Test
    fun redNeverComesBeforeAmberAndTheMinutesStayInRange() {
        assertEquals(8 to 15, KitchenPrefs.tidy(8, 15))
        // red is at least a minute after amber
        assertEquals(10 to 11, KitchenPrefs.tidy(10, 4))
        assertEquals(10 to 11, KitchenPrefs.tidy(10, 10))
        assertEquals(1 to 2, KitchenPrefs.tidy(0, 0))
        assertEquals(119 to 120, KitchenPrefs.tidy(500, 500))
        assertEquals(5 to 120, KitchenPrefs.tidy(5, 900))
    }

    @Test
    fun byDefaultATicketShowsEverythingAndSounds() {
        val p = KitchenPrefs()
        assertTrue(p.covers && p.waiter && p.kind && p.remark && p.sound)
        assertFalse(p.largeText)
    }
}

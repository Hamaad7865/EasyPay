package com.restopos.core.guest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// An add-on is taken several times only where it is marked. The owner: "not
// all add ons are quantifiable. For example Eggs can 1 2 3 4 5. But mayo cant
// be 1 2 3 4 5. We need a checkbox to mark this add on is quantifiable and
// how many we can add".
class SeveralTest {
    @Test
    fun eggsMarkedUpToFiveStopAtFive() {
        var picked = mapOf("egg" to 1)
        repeat(6) { picked = OptionRules.more(picked, "egg", max = 0, most = 5) }
        assertEquals(mapOf("egg" to 5), picked)
    }

    @Test
    fun mayoIsOneOrNone() {
        assertEquals(mapOf("mayo" to 1), OptionRules.more(mapOf("mayo" to 1), "mayo", max = 0, most = 1))
        assertFalse(OptionRules.several(1))
        assertFalse(OptionRules.several(0))
        assertTrue(OptionRules.several(5))
    }

    @Test
    fun aTapStillPicksItAndTakesItOff() {
        val one = OptionRules.tap(emptyMap(), "mayo", min = 0, max = 0)
        assertEquals(mapOf("mayo" to 1), one)
        assertEquals(emptyMap<String, Int>(), OptionRules.tap(one, "mayo", min = 0, max = 0))
    }

    @Test
    fun eachOneStillCountsTowardsTheGroupsMost() {
        // up to three in the group: two eggs and a mayo fill it, whatever the eggs' own number
        val full = mapOf("egg" to 2, "mayo" to 1)
        assertEquals(full, OptionRules.more(full, "egg", max = 3, most = 5))
        assertEquals(mapOf("egg" to 3), OptionRules.more(mapOf("egg" to 2), "egg", max = 3, most = 5))
    }

    @Test
    fun withNoNumberSaidTheMostIsTheServers() {
        assertEquals(mapOf("rice" to 30), OptionRules.more(mapOf("rice" to 29), "rice", max = 0))
        assertEquals(mapOf("rice" to 99), OptionRules.more(mapOf("rice" to 99), "rice", max = 0))
    }
}

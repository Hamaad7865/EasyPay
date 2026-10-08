package com.restopos.feature.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Help says how to use the screens this till has. The kitchen display and
// bookings are the premium tier's: a restaurant on another plan is not sent
// looking for them.
class HelpTest {
    private fun titles(shop: Boolean, premium: Boolean) = helpFor(shop, premium).map { it.first }
    private fun all(shop: Boolean, premium: Boolean) = helpFor(shop, premium).joinToString(" ") { it.second }

    @Test
    fun aPremiumRestaurantIsToldAboutBoth() {
        assertTrue(titles(shop = false, premium = true).containsAll(listOf("The kitchen display", "Bookings")))
        assertTrue(all(shop = false, premium = true).contains("kitchen display"))
    }

    @Test
    fun anotherPlanIsToldAboutNeither() {
        val t = titles(shop = false, premium = false)
        assertFalse(t.contains("The kitchen display"))
        assertFalse(t.contains("Bookings"))
        // nor, in passing, that an order is on a display it has not got
        assertFalse(all(shop = false, premium = false).contains("kitchen display"))
    }

    @Test
    fun andLosesNothingElse() {
        val premium = titles(shop = false, premium = true)
        assertEquals(premium - setOf("The kitchen display", "Bookings"), titles(shop = false, premium = false))
        // sending to the kitchen and its printers are everyone's
        assertTrue(titles(shop = false, premium = false).contains("A printer does not print"))
        assertTrue(all(shop = false, premium = false).contains("Send to kitchen"))
    }

    @Test
    fun aShopsHelpDoesNotDependOnItsPlan() {
        assertEquals(helpFor(shop = true, premium = true), helpFor(shop = true, premium = false))
    }
}

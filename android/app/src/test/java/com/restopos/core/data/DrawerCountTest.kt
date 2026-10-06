package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Typing the cash counted in the drawer. The amount that is recorded closes
// the day and prints on the Z report, so the field must never record a figure
// nobody meant: not a default with a digit stuck on its end, and not Rs 0 from
// a field left empty.
class DrawerCountTest {
    private fun type(vararg keys: String, start: Long? = null, places: Int = 2): String? =
        keys.fold(null as String?) { typed, k -> DrawerCount.key(typed, k, start, places) }

    @Test
    fun theFieldStartsOnWhatTheDrawerShouldHold() {
        assertEquals(1_245_050L, DrawerCount.start(1_245_050, figures = true))
        assertEquals(1_245_050L, DrawerCount.counted(null, 1_245_050, figures = true))
    }

    @Test
    fun someoneWhoMayNotSeeTheFigureStartsOnNothing() {
        assertNull(DrawerCount.start(1_245_050, figures = false))
        assertNull(DrawerCount.counted(null, 1_245_050, figures = false))
        // and what they type is theirs
        assertEquals(120_000L, DrawerCount.counted("1200", 1_245_050, figures = false))
    }

    @Test
    fun aDrawerThatShouldHoldLessThanNothingStartsOnZero() {
        // more was paid out than the float and the cash sales together
        assertEquals(0L, DrawerCount.start(-35_000, figures = true))
        assertEquals(0L, DrawerCount.counted(null, -35_000, figures = true))
    }

    @Test
    fun withNoFigureYetThereIsNothingToStartOn() {
        assertNull(DrawerCount.start(null, figures = true))
        assertNull(DrawerCount.counted(null, null, figures = true))
    }

    @Test
    fun theFirstDigitReplacesTheStartingAmount() {
        // 12,450 on the field and a 5 pressed is 5, not 124,505
        assertEquals("5", type("5", start = 1_245_000))
        assertEquals("520", type("5", "2", "0", start = 1_245_000))
        assertEquals(52_000L, DrawerCount.counted(type("5", "2", "0", start = 1_245_000), 1_245_000, true))
    }

    @Test
    fun whatIsTypedWinsOverTheStartingAmount() {
        assertEquals(1_200_000L, DrawerCount.counted("12000", 1_245_000, figures = true))
    }

    @Test
    fun deleteEditsTheStartingAmount() {
        assertEquals("1245", type("del", start = 1_245_000))
        assertEquals("12450.", type("del", start = 1_245_050)) // Rs 12,450.50 is typed 12450.5
        assertEquals("12450.2", type("del", start = 1_245_025))
        // with nothing to start on, there is nothing to delete
        assertEquals("", type("del"))
        assertEquals("1", type("1", "2", "del"))
    }

    @Test
    fun clearEmptiesTheFieldAndAnEmptyFieldIsNoAmount() {
        assertEquals("", type("clear", start = 1_245_000))
        assertNull(DrawerCount.counted("", 1_245_000, figures = true))
        assertNull(DrawerCount.cents(""))
        // an empty drawer is said by typing 0
        assertEquals(0L, DrawerCount.counted(type("clear", "0", start = 1_245_000), 1_245_000, true))
        // deleting everything is the same as clearing
        assertNull(DrawerCount.counted(type("7", "del"), 1_245_000, true))
    }

    @Test
    fun centsAreTypedAfterThePoint() {
        assertEquals(125_050L, DrawerCount.cents(type("1", "2", "5", "0", ".", "5")!!))
        assertEquals(125_005L, DrawerCount.cents(type("1", "2", "5", "0", ".", "0", "5")!!))
        assertEquals(125_000L, DrawerCount.cents(type("1", "2", "5", "0", ".")!!))
        // no more than two, and one point
        assertEquals("1.25", type("1", ".", "2", "5", "9"))
        assertEquals("1.2", type("1", ".", ".", "2"))
        // the point first is "0."
        assertEquals("0.", type(".", start = 1_245_000))
        assertEquals(50L, DrawerCount.cents(type(".", "5")!!))
    }

    @Test
    fun aRestaurantWithNoDecimalsTypesWholeRupees() {
        assertNull(type(".", start = 1_245_000, places = 0)) // the point does nothing, and the field is as it was
        assertEquals("12", type("1", ".", "2", places = 0))
        assertEquals("1245", type("del", start = 1_245_050, places = 0)) // 12,450.50 shows as 12,451
        assertEquals("12450.", type("del", start = 1_245_050, places = 1))
    }

    @Test
    fun zerosInFrontAreNotKept() {
        assertEquals("0", type("0", "0"))
        assertEquals("0", type("00"))
        assertEquals("7", type("0", "7"))
        assertEquals("700", type("7", "00"))
        assertEquals("0.05", type("0", ".", "0", "5"))
    }

    @Test
    fun theAmountStopsAtSevenFigures() {
        assertEquals("1234567", type("1", "2", "3", "4", "5", "6", "7", "8"))
        assertEquals("1234560", type("1", "2", "3", "4", "5", "6", "00")) // the second 0 has no room
        assertEquals("1234567.89", type("1", "2", "3", "4", "5", "6", "7", ".", "8", "9", "1"))
    }

    @Test
    fun aKeyThatIsNotOnThePadChangesNothing() {
        assertNull(DrawerCount.key(null, "x", 1_245_000, 2))
        assertNull(DrawerCount.key(null, "", 1_245_000, 2))
        assertEquals("12", DrawerCount.key("12", "-", 1_245_000, 2))
    }

    @Test
    fun anAmountReadsBackAsItWouldBeTyped() {
        assertEquals("12450", DrawerCount.text(1_245_000, 2))
        assertEquals("12450.5", DrawerCount.text(1_245_050, 2))
        assertEquals("12450.05", DrawerCount.text(1_245_005, 2))
        assertEquals("0", DrawerCount.text(0, 2))
        assertEquals("0", DrawerCount.text(-500, 2))
        // every amount typed back comes to the same amount
        listOf(0L, 5L, 50L, 100L, 1_245_050L, 999_999_999L).forEach { assertEquals(it, DrawerCount.cents(DrawerCount.text(it, 2))) }
    }

    @Test
    fun whatIsTypedIsGroupedForReading() {
        assertEquals("1,250.5", DrawerCount.shown("1250.5"))
        assertEquals("1,250.", DrawerCount.shown("1250."))
        assertEquals("999", DrawerCount.shown("999"))
        assertEquals("1,234,567", DrawerCount.shown("1234567"))
        assertEquals("0.05", DrawerCount.shown("0.05"))
        assertEquals("", DrawerCount.shown(""))
    }

    @Test
    fun countingByNoteAndCoinIsOffUnlessTheRestaurantAsksForIt() {
        assertFalse(PosSettings.parse(null).drawerByNotes)
        assertFalse(PosSettings.parse("""{"decimals":2}""").drawerByNotes)
        assertFalse(PosSettings.parse("""{"drawerByNotes":"yes"}""").drawerByNotes)
        assertTrue(PosSettings.parse("""{"drawerByNotes":true}""").drawerByNotes)
    }
}

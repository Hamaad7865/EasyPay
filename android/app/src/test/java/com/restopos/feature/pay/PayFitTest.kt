package com.restopos.feature.pay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The pay screen on a tablet that is not tall. The change to give is the one
// figure on it a cashier reads to a customer: it is never the thing that is
// squeezed.
class PayFitTest {
    @Test
    fun theQuickAmountsTakeWhatRoomIsLeft() {
        // room for both rows at their usual height
        assertEquals(2, PayFit.quickRows(116f))
        assertEquals(54f, PayFit.quickKey(116f, 2), 0.01f)
        assertEquals(54f, PayFit.quickKey(300f, 2), 0.01f)
        // less: both rows, a little lower, down to the least a key is drawn at
        assertEquals(2, PayFit.quickRows(96f))
        assertEquals(44f, PayFit.quickKey(96f, 2), 0.01f)
        assertEquals(2, PayFit.quickRows(88f))
        assertEquals(40f, PayFit.quickKey(88f, 2), 0.01f)
        // less still: one row, at its usual height again as long as there is room for it
        assertEquals(1, PayFit.quickRows(87.9f))
        assertEquals(54f, PayFit.quickKey(87.9f, 1), 0.01f)
        assertEquals(1, PayFit.quickRows(40f))
        assertEquals(40f, PayFit.quickKey(40f, 1), 0.01f)
        // no room for a key anyone could press: none, not a sliver of one
        assertEquals(0, PayFit.quickRows(39.9f))
        assertEquals(0f, PayFit.quickKey(39.9f, 0), 0.01f)
        assertEquals(0, PayFit.quickRows(-12f))
    }

    @Test
    fun aKeyIsNeverDrawnLowerThanCanBePressed() {
        for (room in 0..400) {
            val rows = PayFit.quickRows(room.toFloat())
            if (rows > 0) {
                val key = PayFit.quickKey(room.toFloat(), rows)
                assertTrue("$room dp: $rows rows of $key", key >= PayFit.KEY_MIN && key <= PayFit.KEY)
                // and the rows with their gaps fit the room
                assertTrue(rows * key + (rows - 1) * PayFit.GAP <= room + 0.01f)
            }
        }
    }

    // What each part takes, in dp, as it is drawn (measured from the code:
    // paddings, the heights given, and a line of text at about 1.2 its size).
    private val usual = 40f + 87f + 80f + 74f + 3 * 18f   // the side's padding, the amount, one row of payment types, Charge, three gaps
    private val lowered = 24f + 46f + 58f + 62f + 3 * 10f  // the same on a side that is short
    private val tendered = 79f
    private val change = 62f
    private val column = tendered + 10f + 54f + 8f + 54f + 10f + change // Tendered, two rows of quick amounts, Change

    // The emulator the screen was drawn on: nothing changes there.
    @Test
    fun aTallTabletIsDrawnAsBefore() {
        val side = 700f
        assertFalse(PayFit.short(side))
        val row = side - usual
        assertFalse(PayFit.tight(row))
        assertTrue(row >= column)
        assertEquals(2, PayFit.quickRows(row - tendered - change - 20f))
    }

    // A tablet about 690 dp tall leaves this side about 550: at the usual
    // sizes the keypad's row was 215 dp against a column of 277, and Change
    // was squeezed. Lowered, the whole column fits.
    @Test
    fun aTabletThatIsNotTallShowsTheWholeColumn() {
        val side = 550f
        assertTrue(side - usual < column)
        assertTrue(PayFit.short(side))
        val row = side - lowered
        assertTrue(row >= column)
        assertFalse(PayFit.tight(row))
    }

    // A tablet 600 dp tall leaves about 465: Tendered and Change are whole,
    // and one row of quick amounts fits between them.
    @Test
    fun aLowTabletKeepsTenderedAndChangeAndOneRowOfAmounts() {
        val side = 465f
        assertTrue(PayFit.short(side))
        val row = side - lowered
        assertFalse(PayFit.tight(row))
        val room = row - tendered - change - 20f
        assertTrue(room > 0)
        assertEquals(1, PayFit.quickRows(room))
        assertEquals(54f, PayFit.quickKey(room, 1), 0.01f)
    }
}

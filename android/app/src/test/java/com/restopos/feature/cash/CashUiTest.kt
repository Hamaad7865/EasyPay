package com.restopos.feature.cash

import com.restopos.core.print.ShiftDoc
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The amount the cash drawer screen records when the day is closed, or a
// count is recorded for a handover: exactly what the screen shows as Counted.
class CashUiTest {
    // a day whose drawer should hold Rs 12,450.50
    private val doc = ShiftDoc(
        till = "Till 1", openedBy = "Asha", openedAt = 0, closedBy = null, closedAt = null, float = 200_000, payments = emptyList(),
        cashTaken = 1_095_050, cashIn = 0, cashOut = 50_000, moves = emptyList(), expected = 1_245_050, counted = null,
        sales = 12, gross = 1_500_000, refunds = 0, refunded = 0, discounts = 0,
    )

    @Test
    fun untouchedItIsWhatTheDrawerShouldHold() {
        val ui = CashUi(doc = doc, figures = true)
        assertEquals(1_245_050L, ui.start)
        assertEquals(1_245_050L, ui.counted)
    }

    @Test
    fun whatIsTypedIsWhatIsRecorded() {
        assertEquals(1_240_000L, CashUi(doc = doc, figures = true, typed = "12400").counted)
        assertEquals(1_240_025L, CashUi(doc = doc, figures = false, typed = "12400.25").counted)
    }

    @Test
    fun someoneWhoMayNotSeeTheFiguresHasNothingUntilTheyType() {
        val ui = CashUi(doc = doc, figures = false)
        assertNull(ui.start)
        assertNull(ui.counted)
        // once someone allowed shows the figures, the amount starts on what the drawer should hold
        assertEquals(1_245_050L, ui.copy(figures = true).counted)
    }

    @Test
    fun aClearedFieldRecordsNothing() {
        assertNull(CashUi(doc = doc, figures = true, typed = "").counted)
    }

    @Test
    fun byNoteAndCoinItIsTheirSumWhateverWasTyped() {
        // two Rs 2,000 notes, three Rs 500, four Rs 20 coins and seven Rs 1
        val ui = CashUi(doc = doc, figures = true, byNotes = true, typed = "99", counts = mapOf(2000 to 2, 500 to 3, 20 to 4, 1 to 7))
        assertEquals(558_700L, ui.counted)
        // nothing counted yet is Rs 0, not what the drawer should hold
        assertEquals(0L, CashUi(doc = doc, figures = true, byNotes = true).counted)
    }

    @Test
    fun beforeTheDayIsLoadedThereIsNoAmount() {
        assertNull(CashUi(figures = true).counted)
    }
}

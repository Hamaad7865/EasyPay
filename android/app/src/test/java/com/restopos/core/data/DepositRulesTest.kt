package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class DepositRulesTest {
    private val today = LocalDate.parse("2026-10-16")

    @Test fun `numbers count on from the highest this till has`() {
        assertEquals("DM-T1-D000001", DepositRules.next("DM", "T1", emptyList()))
        assertEquals("DM-T1-D000013", DepositRules.next("DM", "T1", listOf("DM-T1-D000002", "DM-T1-D000012", "DM-T1-D000005")))
        // another till's, and one the server gave a suffix, do not confuse it
        assertEquals("DM-T1-D000004", DepositRules.next("DM", "T1", listOf("DM-T2-D000099", "DM-T1-D000003-2")))
    }

    @Test fun `what is left to pay and what a collection takes`() {
        // nothing collected: the total less what was paid
        assertEquals(150000L, DepositRules.toPay(200000, 200000, 200000, 50000))
        assertEquals(0L, DepositRules.toPay(200000, 200000, 200000, 250000))
        // a jacket (2,950) collected and paid for, the deposit's 1,700 used on it: the mug (320) is what is owed
        assertEquals(32000L, DepositRules.toPay(327000, 327000, 32000, 0))
        // with 200 still free on it
        assertEquals(12000L, DepositRules.toPay(327000, 327000, 32000, 20000))
        // a tax on top: the goods left carry their share of it (1,150 total for 1,000 of goods, half left)
        assertEquals(57500L, DepositRules.toPay(115000, 100000, 50000, 0))
        // everything collected: nothing owed
        assertEquals(0L, DepositRules.toPay(327000, 327000, 0, 0))
        assertEquals(50000L, DepositRules.cover(free = 50000, bill = 150000))
        assertEquals(150000L, DepositRules.cover(free = 200000, bill = 150000))
        assertEquals(0L, DepositRules.cover(free = -100, bill = 150000))
    }

    @Test fun `overdue and expiry in whole days`() {
        assertEquals(false, DepositRules.overdue("2026-10-16", today)) // the date itself
        assertEquals(true, DepositRules.overdue("2026-10-15", today))
        assertEquals(1L, DepositRules.daysOver("2026-10-15", today))
        // grace 7: cancelled on the eighth day past, as the server's collect_by + grace < today
        assertEquals(false, DepositRules.expired("2026-10-09", 7, today))
        assertEquals(true, DepositRules.expired("2026-10-08", 7, today))
        assertEquals(true, DepositRules.expired("2026-10-15", 0, today))
        assertEquals(false, DepositRules.expired("not a date", 0, today))
    }

    @Test fun `dates offered`() {
        assertEquals("2026-11-15", DepositRules.collectBy(30, today))
        assertEquals("2027-04-16", DepositRules.noteValidTo(6, today))
        assertNull(DepositRules.noteValidTo(0, today))
        assertEquals("DM-T1-D000004-CN", DepositRules.noteNumber("DM-T1-D000004"))
    }

    @Test fun `the slip says what happens`() {
        assertEquals("If you cancel, the deposit is given back as a credit note.", DepositRules.slipSentence("credit", "show", 7))
        assertEquals("If not collected within 7 days of the date, the goods go back on sale and the deposit is kept by the shop.", DepositRules.slipSentence("keep", "cancel", 7))
        assertEquals("If not collected by the date, the goods go back on sale and the deposit is given back.", DepositRules.slipSentence("refund", "cancel", 0))
    }

    @Test fun `states on the list`() {
        assertEquals("Open", DepositRules.stateWords("open", 0, 0))
        assertEquals("Overdue 3 days", DepositRules.stateWords("open", 0, 3))
        assertEquals("To give back", DepositRules.stateWords("cancelled", 500, 9))
        assertEquals("Collected", DepositRules.stateWords("collected", 0, 0))
        assertEquals("Cancelled", DepositRules.stateWords("cancelled", 0, 0))
    }

    @Test fun `the customer when the shop asks for one`() {
        assertNull(DepositRules.customerMissing(false, null, null))
        assertTrue(DepositRules.customerMissing(true, null, null)!!.startsWith("Pick"))
        assertTrue(DepositRules.customerMissing(true, "Anjali", " ")!!.startsWith("Add the customer's phone"))
        assertNull(DepositRules.customerMissing(true, "Anjali", "5555 1234"))
    }

    @Test fun `paying now`() {
        assertNull(DepositRules.payNowError(0, 150000))
        assertNull(DepositRules.payNowError(150000, 150000))
        assertTrue(DepositRules.payNowError(150001, 150000) != null)
        assertTrue(DepositRules.payNowError(-1, 150000) != null)
    }

    @Test fun `money back goes the way it came, newest first`() {
        val came = listOf("cash" to 50000L, "card" to 70000L)
        assertEquals(listOf("card" to 70000L, "cash" to 30000L), DepositRules.backSplit(100000, came))
        assertEquals(listOf("card" to 40000L), DepositRules.backSplit(40000, came))
        assertEquals(emptyList<Pair<String, Long>>(), DepositRules.backSplit(0, came))
        assertEquals(listOf("cash" to 80000L), DepositRules.backSplit(80000, listOf("cash" to 50000L, "cash" to 30000L)))
    }
}

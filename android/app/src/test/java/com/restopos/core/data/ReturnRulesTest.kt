package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReturnRulesTest {
    private val day = 24L * 3600 * 1000
    private val sold = 1_000_000_000_000L

    @Test fun `the window in whole days`() {
        assertEquals(false, ReturnRules.pastWindow(sold, sold + 7 * day - 1, 7))
        assertEquals(false, ReturnRules.pastWindow(sold, sold + 7 * day + 3600_000, 7)) // the seventh day, whole
        assertEquals(true, ReturnRules.pastWindow(sold, sold + 8 * day, 7))
        assertEquals(true, ReturnRules.pastWindow(sold, sold, 0)) // 0: always
    }

    @Test fun `what Pay says for an exchange, by policy and by the sign of what is due`() {
        assertEquals(ReturnRules.PayState.Pay(27000), ReturnRules.payState("exchange", 59000, 32000))
        assertEquals(ReturnRules.PayState.Even, ReturnRules.payState("exchange", 32000, 32000))
        assertEquals(ReturnRules.PayState.Short(59000), ReturnRules.payState("exchange", 32000, 59000))
        assertEquals(ReturnRules.PayState.Note(27000), ReturnRules.payState("credit", 32000, 59000))
        assertEquals(ReturnRules.PayState.Back(27000), ReturnRules.payState("refund", 32000, 59000))
        // worth more: the customer pays, whatever the policy
        assertEquals(ReturnRules.PayState.Pay(27000), ReturnRules.payState("credit", 59000, 32000))
    }

    @Test fun `what a note may cover on a sale`() {
        assertEquals(17000L, ReturnRules.noteCover(balance = 17000, due = 25000))
        assertEquals(25000L, ReturnRules.noteCover(balance = 40000, due = 25000))
        assertEquals(0L, ReturnRules.noteCover(balance = 0, due = 25000))
    }

    @Test fun `when a note runs out`() {
        assertNull(ReturnRules.validTo(sold, 0))
        val from = java.time.LocalDate.of(2026, 10, 14)
        assertEquals(java.time.LocalDate.of(2027, 4, 14), ReturnRules.validTo(from, 6))
        assertEquals(java.time.LocalDate.of(2027, 2, 28), ReturnRules.validTo(java.time.LocalDate.of(2026, 8, 31), 6))
    }

    @Test fun `the note's number follows its refund's`() {
        assertEquals("DM-T1-CN000012", ReturnRules.noteNumber("DM-T1-R000012"))
    }

    @Test fun `the swap keys are the product's other live variants, the returned one left out`() {
        val vs = listOf(
            ReturnRules.Variant("m", "Navy · M", false), ReturnRules.Variant("l", "Navy · L", false), ReturnRules.Variant("gone", "Red · S", true),
        )
        assertEquals(listOf("l"), ReturnRules.swaps(returned = "m", variants = vs).map { it.id })
        assertEquals(emptyList<ReturnRules.Variant>(), ReturnRules.swaps(returned = null, variants = vs))
    }
}

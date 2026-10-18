package com.restopos.core.data

import com.restopos.core.database.PaymentRow
import com.restopos.core.print.DocAmount
import org.junit.Assert.assertEquals
import org.junit.Test

// Settings, Payments: money taken adds up to what the drawer and the card
// machine hold; a sale on account, a credit note, a deposit used and an
// exchange are shown apart and are not in the total.
class DayPaymentsTest {
    private val names = mapOf("c" to "Cash", "k" to "Card", "a" to "On account", "n" to "Credit note", "d" to "Deposit", "x" to "Exchange")
    private val kinds = mapOf("c" to "cash", "k" to "card", "a" to "account", "n" to "credit_note", "d" to "deposit", "x" to "exchange")
    private var n = 0
    private fun row(type: String, amount: Long, kind: String = "sale") = PaymentRow("p${++n}", "r$n", "S1-T1-$n", kind, 0, type, amount)

    @Test
    fun aSaleOnAccountIsNotMoneyTaken() {
        val f = DayPayments.of(listOf(row("c", 50000), row("a", 86000), row("k", 20000), row("a", 1000)), names, kinds)
        assertEquals(listOf(DocAmount("Cash", 50000, 1), DocAmount("Card", 20000, 1)), f.money)
        assertEquals(70000L, f.total)
        assertEquals(listOf(DocAmount("On account", 87000, 2)), f.noMoney)
    }

    @Test
    fun creditNotesDepositsAndExchangesStayOutToo() {
        val f = DayPayments.of(listOf(row("c", 10000), row("n", 5000), row("d", 7000), row("x", 3000)), names, kinds)
        assertEquals(10000L, f.total)
        assertEquals(setOf("Credit note", "Deposit", "Exchange"), f.noMoney.map { it.name }.toSet())
    }

    @Test
    fun aRefundTakesOffWhatItGaveBack() {
        val f = DayPayments.of(listOf(row("c", 30000), row("c", 10000, "refund"), row("a", 4000, "refund")), names, kinds)
        assertEquals(listOf(DocAmount("Cash", 20000, 2)), f.money)
        assertEquals(20000L, f.total)
        assertEquals(listOf(DocAmount("On account", -4000, 1)), f.noMoney)
    }

    @Test
    fun aTypeNoLongerKnownCountsAsMoneyUnderOther() {
        val f = DayPayments.of(listOf(row("gone", 2500)), names, kinds)
        assertEquals(listOf(DocAmount("Other", 2500, 1)), f.money)
        assertEquals(2500L, f.total)
    }
}

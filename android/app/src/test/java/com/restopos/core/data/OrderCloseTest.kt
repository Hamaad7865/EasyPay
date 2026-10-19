package com.restopos.core.data

import com.restopos.core.database.TicketLineEntity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// An order with nothing left to pay closes: check 1 of a split bill was paid,
// then check 2's items were taken off. Before, nothing closed it and its
// table stayed taken at Rs 0.00 for good.
class OrderCloseTest {
    private fun line(id: String, paid: Boolean = false, voided: Boolean = false) = TicketLineEntity(
        id = id, tenant_id = "t", ticket_id = "o", name_snapshot = id, unit_price = 100, qty = 1000,
        paid = paid, voided_at = if (voided) "2026-10-20T12:00:00Z" else null,
    )

    @Test
    fun paidLinesAndNothingElseIsSettled() = assertTrue(OrderClose.settled(listOf(line("a", paid = true), line("b", voided = true))))

    @Test
    fun aLineStillToPayIsNotSettled() = assertFalse(OrderClose.settled(listOf(line("a", paid = true), line("b"))))

    // an order with nothing on it is freed, not closed as paid
    @Test
    fun nothingOnItIsNotSettled() {
        assertFalse(OrderClose.settled(emptyList()))
        assertFalse(OrderClose.settled(listOf(line("a", voided = true))))
    }
}

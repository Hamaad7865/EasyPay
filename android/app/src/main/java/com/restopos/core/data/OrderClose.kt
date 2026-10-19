package com.restopos.core.data

import com.restopos.core.database.TicketLineEntity

// When an order with nothing left to pay is closed. Only a payment closed an
// order, so one whose last unpaid items were taken off after a part was paid
// (check 1 of a split bill paid, check 2's items taken off) stayed open with
// nothing to pay: its table showed taken at Rs 0.00 for good, and nothing on
// the till could free it. It is now closed as paid, here and on the server
// (ticket.cancel, 0125).
object OrderClose {
    // Something on it was paid and nothing on it is still to pay. An order with
    // nothing on it at all is freed, not closed as paid.
    fun settled(lines: List<TicketLineEntity>): Boolean {
        val live = lines.filter { it.voided_at == null && it.deleted_at == null }
        return live.isNotEmpty() && live.all { it.paid }
    }
}

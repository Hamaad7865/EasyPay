package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Whether the till takes orders and money now, and what gets it going
// (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md, Look only).
class SellGateTest {
    @Test fun a_till_with_no_pins_has_no_days_and_always_sells() {
        assertNull(SellGate.why(usesDays = false, dayOpen = false, lookOnly = false, mayOpen = false))
        assertNull(SellGate.why(usesDays = false, dayOpen = false, lookOnly = false, mayOpen = false, closing = true))
    }

    @Test fun clocked_in_with_the_day_open_it_sells() {
        assertNull(SellGate.why(usesDays = true, dayOpen = true, lookOnly = false, mayOpen = false))
    }

    @Test fun clocked_in_with_no_day_open_it_offers_to_open_it_to_whoever_may() {
        assertEquals(Blocked(SellGate.NOT_OPEN, Offer.OpenDay), SellGate.why(usesDays = true, dayOpen = false, lookOnly = false, mayOpen = true))
        assertEquals(Blocked(SellGate.NOT_OPEN_ASK, Offer.None), SellGate.why(usesDays = true, dayOpen = false, lookOnly = false, mayOpen = false))
    }

    @Test fun in_to_look_it_offers_to_clock_in_open_day_or_not() {
        assertEquals(Blocked(SellGate.LOOKING, Offer.ClockIn), SellGate.why(usesDays = true, dayOpen = false, lookOnly = true, mayOpen = true))
        assertEquals(Blocked(SellGate.LOOKING, Offer.ClockIn), SellGate.why(usesDays = true, dayOpen = true, lookOnly = true, mayOpen = false))
    }

    @Test fun while_the_day_closes_itself_nothing_is_sold() {
        assertEquals(Blocked(SellGate.CLOSING, Offer.None), SellGate.why(usesDays = true, dayOpen = true, lookOnly = false, mayOpen = true, closing = true))
    }

    @Test fun what_is_held_back_is_what_takes_an_order_or_moves_money() {
        listOf("ticket.create", "ticket.add_line", "ticket.send", "ticket.void_line", "receipt.create", "refund.create", "cash.move",
            "drawer.count", "payment.correct", "deposit.pay", "account.pay").forEach { assertTrue(it, it in SellGate.SELLING) }
        listOf("customer.upsert", "item.set_available", "stock.adjust", "kitchen.mark", "shift.close", "day.close", "timeclock.punch",
            "settings.save", "booking.upsert").forEach { assertTrue(it, it !in SellGate.SELLING) }
    }
}

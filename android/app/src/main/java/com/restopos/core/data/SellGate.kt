package com.restopos.core.data

// Whether this till takes orders and money now, and if not, why and what
// gets it going (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md).
// A till with no PINs has no days, and sells. Otherwise it sells while its
// day is open, to someone who came in by clocking in. Someone in to look
// only, a day not open, or a day closing itself at this moment, waits.
data class Blocked(val text: String, val offer: Offer)

enum class Offer { OpenDay, ClockIn, None }

class NotSelling(val blocked: Blocked) : Exception(blocked.text)

object SellGate {
    const val CLOSING = "The day is closing by itself. Try again in a moment."
    const val LOOKING = "You came in to look. Clock in to take orders."
    const val NOT_OPEN = "The day is not open."
    const val NOT_OPEN_ASK = "The day is not open. Someone allowed to open it has to."

    // What takes an order or moves money: the ops held back while the gate
    // is shut. Customers, the menu, stock, bookings, settings and the
    // kitchen go on.
    val SELLING = setOf(
        "ticket.create", "ticket.add_line", "ticket.edit_line", "ticket.void_line", "ticket.cancel", "ticket.update_meta",
        "ticket.merge", "ticket.move_lines", "ticket.place_lines", "ticket.split_line", "ticket.split_merge", "ticket.stage", "ticket.send",
        "receipt.create", "refund.create", "payment.correct", "cash.move", "drawer.count",
        "deposit.create", "deposit.pay", "deposit.give_back", "deposit.cancel", "account.pay",
    )

    fun why(usesDays: Boolean, dayOpen: Boolean, lookOnly: Boolean, mayOpen: Boolean, closing: Boolean = false): Blocked? = when {
        !usesDays -> null
        closing -> Blocked(CLOSING, Offer.None)
        lookOnly -> Blocked(LOOKING, Offer.ClockIn)
        !dayOpen -> if (mayOpen) Blocked(NOT_OPEN, Offer.OpenDay) else Blocked(NOT_OPEN_ASK, Offer.None)
        else -> null
    }
}

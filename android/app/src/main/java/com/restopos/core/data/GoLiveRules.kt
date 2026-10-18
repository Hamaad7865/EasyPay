package com.restopos.core.data

// What Go live does to what a tablet holds, as plain rules (GoLiveRulesTest):
// which kinds of change in its queue were rung up, and so go with the sales,
// and what of each product the sales noted while it was setting up goes back
// on the shelf. docs/superpowers/specs/2026-10-18-tablet-setting-up-design.md
object GoLiveRules {
    // the mark on a stock movement noted while setting up (stock_movements.ref_type)
    const val TRIAL = "trial"

    // What was rung up: taken out of the queue at Go live, with the sales.
    val RUNG_UP = setOf(
        "ticket.create", "ticket.add_line", "ticket.edit_line", "ticket.void_line", "ticket.send", "ticket.stage",
        "ticket.place_lines", "ticket.split_line", "ticket.merge", "ticket.move_lines", "ticket.update_meta", "ticket.cancel",
        "receipt.create", "refund.create", "payment.correct",
        "shift.open", "shift.close", "day.close", "drawer.count", "cash.move", "timeclock.punch",
        "kitchen.mark", "booking.upsert", "request.answer",
        "deposit.create", "deposit.pay", "deposit.cancel", "deposit.give_back", "account.pay",
    )

    // What was set up: stays in the queue, in its order, for the day the business is connected to the cloud.
    val SET_UP = LocalAnswers.KINDS + setOf("customer.upsert", "item.set_available", "item.set_price", "setup.finish")

    // A kind in neither list stays: a sale left in can still be cleared then;
    // a set-up change taken out could not be had back.
    fun goes(kind: String): Boolean = kind in RUNG_UP

    // Back to setting up asks for the business's name to be typed: as it is,
    // whatever its capitals and the spaces around it. A tablet that knows no
    // name for its business cannot be set up again this way.
    fun named(typed: String, business: String?): Boolean =
        !business.isNullOrBlank() && typed.trim().equals(business.trim(), ignoreCase = true)

    // A move of stock noted while setting up: the product, its variant ("" for
    // none), how much in thousandths (minus for a sale), and when.
    data class Noted(val item: String, val variant: String, val qty: Int, val at: Long)

    // What goes back on each shelf: every noted move undone, except one made
    // before a count of that product was completed here. The count found what
    // was there and set the level to it, so that sale is no longer in it; and
    // the count's own "moved", kept for the cloud, was worked out at the same
    // moment, so the server lands where the tablet is.
    fun putBack(noted: List<Noted>, countedAt: Map<Pair<String, String>, Long>): Map<Pair<String, String>, Int> {
        val out = LinkedHashMap<Pair<String, String>, Int>()
        for (n in noted) {
            val key = n.item to n.variant
            val counted = countedAt[key]
            if (counted != null && n.at <= counted) continue
            out.merge(key, -n.qty, Int::plus)
        }
        return out.filterValues { it != 0 }
    }
}

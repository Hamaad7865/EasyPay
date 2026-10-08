package com.restopos.core.data

import com.restopos.core.common.Money
import com.restopos.core.database.TicketLineEntity
import java.util.Locale

// A line of a sale charged something other than its listed price, and the
// words a shop's sell screen says about a line. No Android here, so the unit
// tests can ask it.
//
// The change is kept on the line itself: unit is what is charged, list what
// it was listed at. The receipt's subtotal is then already after it, and every
// sum on the till and the server (Calc, RefundCalc, the receipt, a refund) is
// the sum it always was. kind says which right it takes: "discount" the right
// to discount, "override" the right to change a price.
object LinePrice {
    data class Change(val unit: Long, val list: Long, val kind: String, val label: String)

    // So many percent off, to the cent, half up like every percentage on the till.
    fun percentOff(list: Long, pct: Int): Change? {
        if (list <= 0 || pct !in 1..100) return null
        return Change((list * (100 - pct) + 50) / 100, list, "discount", "$pct% off")
    }

    // So many rupees off each unit: a line of three is then three whole prices.
    fun amountOff(list: Long, off: Long, money: (Long) -> String): Change? {
        if (list <= 0 || off <= 0 || off > list) return null
        return Change(list - off, list, "discount", "${money(off)} off")
    }

    // Another price typed for this sale, above or below. The listed price is no change.
    fun changed(list: Long, price: Long): Change? {
        if (price < 0 || price > 100_000_000L || price == list) return null
        return Change(price, list, "override", "Price changed")
    }

    // What the change took off the line (or added, as a negative), for the
    // "Discounts" figure under the sale: the line at its listed price, less
    // the line as charged.
    fun saved(list: Long?, unit: Long, qty: Int): Long = if (list == null) 0 else Calc.lineAmount(list, qty) - Calc.lineAmount(unit, qty)

    // A quantity as someone says it: 3, or 0.350 kg for what is weighed.
    fun qty(q: Int, weighed: Boolean): String =
        if (weighed) "%.3f kg".format(Locale.US, q / 1000.0)
        else if (q % 1000 == 0) "${q / 1000}" else "%.3f".format(Locale.US, q / 1000.0).trimEnd('0').trimEnd('.')

    // The line under a product's name on the sale: "M / Navy · Rs 1,290.00 each · 10% off".
    // The price said is the listed one when the line is charged another.
    fun sub(variant: String?, list: Long?, unit: Long, label: String?, weighed: Boolean, money: (Long) -> String): String =
        listOfNotNull(
            variant?.takeIf { it.isNotBlank() },
            money(list ?: unit) + if (weighed) " a kilo" else " each",
            label?.takeIf { it.isNotBlank() },
        ).joinToString(" · ")

    // Whether the same thing rung up again goes on this line: the same
    // product and variant at the same price, with nothing said about the line
    // (no note, no changed price) and nothing done with it.
    // typed: the price was typed for this one (an item with no price of its
    // own). It is asked for each time, so it is always a line of its own.
    fun sameLine(l: TicketLineEntity, itemId: String, variantId: String?, unit: Long, typed: Boolean = false): Boolean =
        !typed && l.item_id == itemId && l.variant_id == variantId && l.unit_price == unit && l.price_kind == null && l.note.isNullOrBlank() &&
            !l.paid && l.voided_at == null && l.sent_to_kitchen_at == null

    // The price typed on the keypad for an item that has none of its own, in
    // cents, or null when what was typed is not a price: nothing, zero, or
    // more than Rs 1,000,000, which is a slip of the finger (the bound the
    // server puts on a price set from a till).
    const val MOST = 100_000_000L
    fun typed(text: String): Long? = Money.parseRs(text)?.takeIf { it in 1..MOST }

    // What a tile says is left, and how loudly.
    enum class Stock { Plenty, Few, None }
    fun stock(qty: Long): Stock = if (qty <= 0) Stock.None else if (qty <= 5000) Stock.Few else Stock.Plenty
    fun left(qty: Long, weighed: Boolean): String = if (qty <= 0) "Out" else qty(qty.toInt(), weighed) + " left"
}

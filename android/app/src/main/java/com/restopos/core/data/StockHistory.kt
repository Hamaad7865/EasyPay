package com.restopos.core.data

import kotlin.math.abs

// A movement of stock as the History tab says it: what kind of thing it was,
// in which words, and how many came in or went out. The reasons are the
// server's (stock_movements.reason, migration 0067).
object StockHistory {
    enum class Kind(val label: String) { Sale("Sales"), Delivery("Deliveries"), Count("Counts"), Correction("Corrections") }

    fun kind(reason: String): Kind = when (reason) {
        "sale", "refund" -> Kind.Sale
        "receive" -> Kind.Delivery
        "count" -> Kind.Count
        else -> Kind.Correction
    }

    fun says(reason: String): String = when (reason) {
        "sale" -> "Sold"
        "refund" -> "Refunded"
        "receive" -> "Delivery"
        "count" -> "Count"
        "damaged" -> "Damaged"
        "expired" -> "Expired"
        "lost" -> "Lost"
        "internal" -> "Used in the shop"
        "supplier_return" -> "Returned to supplier"
        "found" -> "Found"
        "opening" -> "Opening stock"
        else -> "Correction"
    }

    // How many, in units and always with its sign: +3, -1.5, +0.350 kg. Nothing is 0.
    fun shown(qty: Int, weighed: Boolean = false): String =
        if (qty == 0) "0" else (if (qty > 0) "+" else "-") + LinePrice.qty(abs(qty), weighed)
}

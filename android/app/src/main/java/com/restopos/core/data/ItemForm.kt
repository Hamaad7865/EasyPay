package com.restopos.core.data

import com.restopos.core.common.Money

// An item as the till's own sheet makes or changes it: its name, its price or
// that its price is typed at the sale, its barcode. The server checks all of
// it again and has the last word; reading it here catches a slip before the
// tablet asks, and puts the server's refusals in the till's words.
object ItemForm {
    class Item(val name: String, val price: Long, val open: Boolean, val barcode: String?)

    // What the sheet holds, read as an item, or why it is not one yet.
    fun read(name: String, price: String, open: Boolean, barcode: String): Result<Item> = runCatching {
        val called = name.trim().take(80)
        require(called.isNotEmpty()) { "Give it a name" }
        // one whose price is typed at the sale has none of its own, whatever was left in the box
        val costs = if (open) 0L else Money.parseRs(price) ?: throw IllegalArgumentException("Type its price, or switch on \"Price typed at the sale\"")
        require(costs <= LinePrice.MOST) { "Rs 1,000,000 is the most an item can cost" }
        val code = barcode.filterNot { it.isWhitespace() }
        require(code.length <= 64) { "That barcode is too long" }
        Item(called, costs, open, code.ifEmpty { null })
    }

    // What the sheet's second page holds, as it was typed (server 0094): the
    // tax picked, and for a shop the cost (when the person may see cost), the
    // SKU (a product with variants keeps its codes on its lines, and shows
    // none), the brand, the supplier and the supplier's own code for the
    // product, and when and how much to reorder in this till's store.
    data class Typed(
        val taxId: String? = null, val shop: Boolean = false,
        val costShown: Boolean = false, val cost: String = "",
        val skuShown: Boolean = true, val sku: String = "",
        val brand: String = "", val supplierId: String? = null, val supplierCode: String = "",
        val reorder: String = "", val orderQty: String = "",
    )

    // The same, read. An empty field is "none": the server clears what it held.
    class More(
        val taxId: String?, val shop: Boolean,
        val costShown: Boolean, val cost: Long?,
        val skuShown: Boolean, val sku: String?,
        val brand: String?, val supplierId: String?, val supplierCode: String?,
        // thousandths, as every quantity is
        val reorder: Int?, val orderQty: Int?,
    )

    private val QTY = Regex("""(\d{1,7})(?:[.,](\d{1,3}))?""")

    // A reorder quantity as typed, in thousandths: "3", "1.5" or "1,5"; nothing may be typed, and 0 is a level too.
    private fun qty(typed: String, what: String): Int? {
        if (typed.isBlank()) return null
        val m = QTY.matchEntire(typed.trim()) ?: throw IllegalArgumentException("$what is not a number")
        val n = m.groupValues[1].toLong() * 1000 + m.groupValues[2].padEnd(3, '0').toLong()
        require(n <= 1_000_000_000L) { "$what is too large" }
        return n.toInt()
    }

    fun readMore(t: Typed): Result<More> = runCatching {
        if (!t.shop) return@runCatching More(t.taxId, false, false, null, false, null, null, null, null, null, null)
        val cost = if (!t.costShown || t.cost.isBlank()) null else Money.parseRs(t.cost) ?: throw IllegalArgumentException("The cost is not a number")
        require(cost == null || cost <= LinePrice.MOST) { "Rs 1,000,000 is the most a product can cost" }
        More(
            t.taxId, true, t.costShown, cost, t.skuShown, t.sku.trim().take(60).ifEmpty { null },
            t.brand.trim().take(60).ifEmpty { null }, t.supplierId, t.supplierCode.trim().take(60).ifEmpty { null },
            qty(t.reorder, "The reorder level"), qty(t.orderQty, "The order quantity"),
        )
    }

    // A quantity in thousandths as the sheet shows it again: 3000 as "3", 1500 as "1.5".
    fun shown(qty: Int?): String = when {
        qty == null -> ""
        qty % 1000 == 0 -> (qty / 1000).toString()
        else -> "%d.%03d".format(qty / 1000, qty % 1000).trimEnd('0')
    }

    // The server's refusal of item.save or item.remove (migration 0084), in words.
    fun refused(code: String?, shop: Boolean): String {
        val thing = if (shop) "product" else "item"
        return when (code) {
            "barcode-taken" -> "Another $thing already has that barcode."
            "sku-taken" -> "Another $thing already has that SKU."
            "name-required" -> "Give it a name"
            "bad-category" -> "That category is no longer there. Pick another."
            "bad-item" -> "That $thing is no longer there."
            "bad-tax" -> "That tax is no longer there. Pick another."
            "unknown-supplier" -> "That supplier is no longer there. Pick another, or none."
            "bad-store" -> "This till's store is no longer there."
            "bad-quantity" -> "A reorder quantity cannot be less than nothing."
            "conflict" -> "That did not work. Close this and try again."
            "forbidden" -> "You are not allowed to change the ${if (shop) "products" else "menu"}. Ask a manager."
            "open-price-not-here" -> "A product with variants, or sold by weight, has prices of its own: its price cannot be typed at the sale."
            "unknown-op" -> "The server has to be updated before items can be changed from a till."
            null -> "The server refused it."
            else -> "The server refused it ($code)."
        }
    }
}

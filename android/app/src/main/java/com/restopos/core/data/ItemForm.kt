package com.restopos.core.data

import com.restopos.core.common.Money

// An item as the till's own sheet makes or changes it: its name, its price or
// that its price is typed at the sale, its barcode. The server checks all of
// it again and has the last word; reading it here catches a slip before the
// tablet asks, and puts the server's refusals in the till's words.
object ItemForm {
    // soldBy: how it is sold (0129), "each" or "weight"; null: not said, the server leaves it as it is
    class Item(val name: String, val price: Long, val open: Boolean, val barcode: String?, val soldBy: String? = null)

    // How a shop's product is sold, as its sheet offers it (0129): one price
    // each, a price for a kilo (the till asks how heavy), or its price typed
    // at the sale (sold each, and counting no stock).
    enum class Way { FIXED, KILO, AT_SALE }

    fun wayOf(open: Boolean, soldBy: String?): Way = if (open) Way.AT_SALE else if (soldBy == "weight") Way.KILO else Way.FIXED

    // What a save says of the unit: for a new product always, for one being
    // changed only when it changes (the tablet's copy may be older than the
    // server's, as with the sheet's second page). was: the product's unit, null for a new one.
    fun soldBy(way: Way, was: String?): String? {
        val unit = if (way == Way.KILO) "weight" else "each"
        return if (was == null || unit != was) unit else null
    }

    // What the sheet holds, read as an item, or why it is not one yet.
    fun read(name: String, price: String, open: Boolean, barcode: String, soldBy: String? = null): Result<Item> = runCatching {
        val called = name.trim().take(80)
        require(called.isNotEmpty()) { "Give it a name" }
        require(!(open && soldBy == "weight")) { "By the kilo has a price for a kilo: it cannot be typed at the sale" }
        // one whose price is typed at the sale has none of its own, whatever was left in the box
        val costs = if (open) 0L else Money.parseRs(price) ?: throw IllegalArgumentException(
            if (soldBy == "weight") "Type its price for a kilo" else "Type its price, or switch on \"Price typed at the sale\"",
        )
        require(costs <= LinePrice.MOST) { "Rs 1,000,000 is the most an item can cost" }
        val code = barcode.filterNot { it.isWhitespace() }
        require(code.length <= 64) { "That barcode is too long" }
        Item(called, costs, open, code.ifEmpty { null }, soldBy)
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
        // the add-on groups it carries (a restaurant's item); null when the page did not show them
        val groups: Set<String>? = null,
        // what it is made of (0112, a restaurant's item); null when the page did not show it
        val parts: List<Parts.Part>? = null,
    )

    // The same, read. An empty field is "none": the server clears what it held.
    class More(
        val taxId: String?, val shop: Boolean,
        val costShown: Boolean, val cost: Long?,
        val skuShown: Boolean, val sku: String?,
        val brand: String?, val supplierId: String?, val supplierCode: String?,
        // thousandths, as every quantity is
        val reorder: Int?, val orderQty: Int?,
        val groups: List<String>? = null,
        val parts: List<Parts.Part>? = null,
        // Which of them are sent (TAX, COST and so on). For a new item, all
        // of them. For one being changed, only what the person changed on
        // the page: what the tablet holds may be older than the server's (the
        // back office changed the supplier since the last sync), and a name
        // put right here must not put the old supplier back.
        val sent: Set<String> = ALL,
    )
    const val TAX = "tax"
    const val COST = "cost"
    const val SKU = "sku"
    const val BRAND = "brand"
    const val SUPPLIER = "supplier"
    const val SUPPLIER_CODE = "supplier_code"
    const val REORDER = "reorder"
    const val GROUPS = "groups"
    const val PARTS = "parts"
    val ALL = setOf(TAX, COST, SKU, BRAND, SUPPLIER, SUPPLIER_CODE, REORDER, GROUPS, PARTS)

    // The tax a sheet opens on: an item's own, and for a new item the usual
    // one. An item that carries no tax is not given one by being opened.
    fun startTax(new: Boolean, own: String?, usual: String?): String? = if (new) usual else own

    // What the person changed on the page since it opened (from).
    private fun changed(t: Typed, from: Typed): Set<String> = buildSet {
        if (t.taxId != from.taxId) add(TAX)
        if (t.cost.trim() != from.cost.trim()) add(COST)
        if (t.sku.trim() != from.sku.trim()) add(SKU)
        if (t.brand.trim() != from.brand.trim()) add(BRAND)
        if (t.supplierId != from.supplierId) add(SUPPLIER)
        if (t.supplierCode.trim() != from.supplierCode.trim()) add(SUPPLIER_CODE)
        // the two figures are saved together
        if (t.reorder.trim() != from.reorder.trim() || t.orderQty.trim() != from.orderQty.trim()) add(REORDER)
        if (t.groups != from.groups) add(GROUPS)
        if (t.parts != from.parts) add(PARTS)
    }

    private val QTY = Regex("""(\d{1,7})(?:[.,](\d{1,3}))?""")

    // A reorder quantity as typed, in thousandths: "3", "1.5" or "1,5"; nothing may be typed, and 0 is a level too.
    private fun qty(typed: String, what: String): Int? {
        if (typed.isBlank()) return null
        val m = QTY.matchEntire(typed.trim()) ?: throw IllegalArgumentException("$what is not a number")
        val n = m.groupValues[1].toLong() * 1000 + m.groupValues[2].padEnd(3, '0').toLong()
        require(n <= 1_000_000_000L) { "$what is too large" }
        return n.toInt()
    }

    // from: the page as it opened, for an item being changed; null for a new one.
    fun readMore(t: Typed, from: Typed? = null): Result<More> = runCatching {
        val sent = if (from == null) ALL else changed(t, from)
        if (!t.shop) return@runCatching More(t.taxId, false, false, null, false, null, null, null, null, null, null, t.groups?.sorted(), t.parts, sent)
        val cost = if (!t.costShown || t.cost.isBlank()) null else Money.parseRs(t.cost) ?: throw IllegalArgumentException("The cost is not a number")
        require(cost == null || cost <= LinePrice.MOST) { "Rs 1,000,000 is the most a product can cost" }
        More(
            t.taxId, true, t.costShown, cost, t.skuShown, t.sku.trim().take(60).ifEmpty { null },
            t.brand.trim().take(60).ifEmpty { null }, t.supplierId, t.supplierCode.trim().take(60).ifEmpty { null },
            qty(t.reorder, "The reorder level"), qty(t.orderQty, "The order quantity"), t.groups?.sorted(), t.parts, sent,
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
            "bad-group" -> "One of those add-on groups is no longer there. Open the sheet again."
            // what it is made of (0112)
            "bad-part" -> "A part has to be another $thing, one without variants, that is still there."
            "part-has-parts" -> "A part cannot be made of others itself. Pick an $thing that is sold as it is."
            "is-a-part" -> "This $thing is a part of another one, so it cannot be made of others."
            "conflict" -> "That did not work. Close this and try again."
            "forbidden" -> "You are not allowed to change the ${if (shop) "products" else "menu"}. Ask a manager."
            "open-price-not-here" -> "A product with variants, or sold by weight, has prices of its own: its price cannot be typed at the sale."
            // how it is sold (0129)
            "unit-has-stock" -> "It holds stock, so it cannot change between each and by the kilo. Count it to zero first, or switch off \"Count its stock\"."
            "unknown-op" -> "The server has to be updated before items can be changed from a till."
            null -> "The server refused it."
            else -> "The server refused it ($code)."
        }
    }
}

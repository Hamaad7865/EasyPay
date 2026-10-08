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

    // The server's refusal of item.save or item.remove (migration 0084), in words.
    fun refused(code: String?, shop: Boolean): String {
        val thing = if (shop) "product" else "item"
        return when (code) {
            "barcode-taken" -> "Another $thing already has that barcode."
            "sku-taken" -> "Another $thing already has that SKU."
            "name-required" -> "Give it a name"
            "bad-category" -> "That category is no longer there. Pick another."
            "bad-item" -> "That $thing is no longer there."
            "conflict" -> "That did not work. Close this and try again."
            "forbidden" -> "You are not allowed to change the ${if (shop) "products" else "menu"}. Ask a manager."
            "open-price-not-here" -> "A product with variants, or sold by weight, has prices of its own: its price cannot be typed at the sale."
            "unknown-op" -> "The server has to be updated before items can be changed from a till."
            null -> "The server refused it."
            else -> "The server refused it ($code)."
        }
    }
}

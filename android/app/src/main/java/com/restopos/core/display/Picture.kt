package com.restopos.core.display

import kotlinx.serialization.Serializable

// What a customer display shows: the whole of it, worked out on the till and
// sent as it stands, never as a change to what was sent before. A picture
// lost on the way, or sent twice, does no harm: the next one is the whole
// screen again.
//
//   idle  between sales: the business's name and logo, and the display's message
//   sale  the order being rung up: its lines, what they come to, the total
//   paid  the sale just paid: the total, what was paid, the change
//
// Amounts are in cents, as everywhere on the till; `decimals` says how the
// business shows them (Money.decimals), `lang` in which words (L.lang).

// One line of the order: "2", "Burger", "Egg", 24000.
@Serializable
data class PicLine(val qty: String, val name: String, val detail: String = "", val amount: Long)

// One figure under the lines, with its words in the till's language:
// "Subtotal", the discount by its name (taken off, so less than nothing),
// "Service 10%", "VAT included", "VAT", "Rounding".
@Serializable
data class PicSum(val label: String, val amount: Long)

@Serializable
data class Picture(
    val state: String = IDLE,
    val title: String = "",
    val lines: List<PicLine> = emptyList(),
    val sums: List<PicSum> = emptyList(),
    // a sale: what it comes to, what was already paid on it (a split bill)
    // and what is left; paid: the total, what was handed over, the change
    val total: Long = 0,
    val paid: Long = 0,
    val left: Long = 0,
    val change: Long = 0,
    val lang: String = "en",
    val decimals: Int = 2,
    val business: String = "",
    // the display's own two lines for between sales, set where it was added
    val message: String = "",
) {
    companion object {
        const val IDLE = "idle"
        const val SALE = "sale"
        const val PAID = "paid"
    }
}

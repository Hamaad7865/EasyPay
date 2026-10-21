package com.restopos.core.display

import com.restopos.core.data.Calc

// The rules by which an order becomes what its customer display shows. Plain
// Kotlin, so they are tested on their own: the till's side (DisplayFeed)
// reads the order from its database and hands it here.
object Pictures {
    // The till's words for the figures under the lines, in its language:
    // filled by the feed from L, plain strings here.
    data class Words(
        val subtotal: String = "Subtotal",
        val service: String = "Service",
        val vatIncluded: String = "VAT included",
        val vat: String = "VAT",
        val rounding: String = "Rounding",
    )

    // An order being rung up. `totals` is what is still to pay on it, as the
    // order screen works it out (ServiceRepository.dueOf); `vatIncluded` the
    // part of `totals.tax` already inside the prices (the rest is added on
    // top); `paidSoFar` what was paid on it already (a split bill). An order
    // with no lines is nothing to show: the idle screen.
    fun sale(
        title: String, lines: List<PicLine>, totals: Calc.Totals, vatIncluded: Long, discountName: String?,
        servicePct: Int, paidSoFar: Long, words: Words = Words(), base: Picture = Picture(),
    ): Picture {
        if (lines.isEmpty()) return idleOf(base)
        val sums = ArrayList<PicSum>()
        sums += PicSum(words.subtotal, totals.subtotal)
        if (totals.discount > 0) sums += PicSum(discountName?.takeIf { it.isNotBlank() } ?: "Discount", -totals.discount)
        if (totals.service > 0) sums += PicSum("${words.service} ${pct(servicePct)}", totals.service)
        val added = totals.tax - vatIncluded
        if (vatIncluded > 0) sums += PicSum(words.vatIncluded, vatIncluded)
        if (added > 0) sums += PicSum(words.vat, added)
        if (totals.rounding != 0L) sums += PicSum(words.rounding, totals.rounding)
        return base.copy(
            state = Picture.SALE, title = title, lines = lines, sums = sums,
            total = totals.total + paidSoFar, paid = paidSoFar, left = totals.total, change = 0,
        )
    }

    // The sale just paid: its total, what was handed over (the total and the
    // change), and the change.
    fun paid(total: Long, change: Long, base: Picture = Picture()): Picture =
        idleOf(base).copy(state = Picture.PAID, total = total, paid = total + change.coerceAtLeast(0), change = change.coerceAtLeast(0))

    // Between sales: what the business is, and nothing of the last sale.
    fun idleOf(p: Picture): Picture = Picture(lang = p.lang, decimals = p.decimals, business = p.business, message = p.message)

    // A line's quantity as the customer reads it: "2", or "0.5" for half a kilo
    // (quantities are kept in thousandths).
    fun qty(thousandths: Int): String {
        if (thousandths % 1000 == 0) return (thousandths / 1000).toString()
        return java.math.BigDecimal(thousandths).movePointLeft(3).stripTrailingZeros().toPlainString()
    }

    // "10%", "12.5%" from basis points
    private fun pct(bp: Int): String =
        java.math.BigDecimal(bp).movePointLeft(2).stripTrailingZeros().toPlainString() + "%"
}

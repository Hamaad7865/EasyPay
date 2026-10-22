package com.restopos.core.display

import com.restopos.core.data.Calc

// The rules by which an order becomes what its customer display shows. Plain
// Kotlin, so they are tested on their own: the till's side (DisplayFeed)
// reads the order from its database and hands it here.
object Pictures {
    // The till's words for the figures under the lines, in its language:
    // filled by the feed from L, plain strings here. (Version 1 displays
    // read these as `sums`; version 2 draws its own block from the figures.)
    data class Words(
        val subtotal: String = "Subtotal",
        val service: String = "Service",
        val vatIncluded: String = "VAT included",
        val vat: String = "VAT",
        val rounding: String = "Rounding",
        // the customer's loyalty points used on the bill (0128)
        val points: String = "Points",
    )

    // One line as it was rung up: how many (in thousandths), what, its
    // add-ons and note, what it comes to, and the price of one as charged
    // and as listed (a shop's line discount charges less than the list).
    data class Rung(val qty: Int, val name: String, val detail: String, val amount: Long, val unit: Long, val listed: Long?)

    // An order being rung up. `totals` is what is still to pay on it, as the
    // order screen works it out (ServiceRepository.dueOf); `vatIncluded` the
    // part of `totals.tax` already inside the prices (the rest is added on
    // top); `paidSoFar` what was paid on it already (a split bill). An order
    // with no lines is nothing to show: the idle screen.
    //
    // The figures block: gross is every line at its listed price; discount is
    // everything taken off, the lines' discounts and the order's together.
    // While nothing is paid yet they add up exactly:
    //   gross − discount + VAT added + service + rounding = left
    // On a split bill part paid, `left` is what dueOf says of the lines still
    // to pay, and the earlier receipts held their own service and VAT.
    // `points`: the customer's points used on Pay (0128), as charged: inside
    // `totals.discount`, after the order's discount, on a line of their own.
    fun sale(
        title: String, rung: List<Rung>, totals: Calc.Totals, vatIncluded: Long, discountName: String?,
        servicePct: Int, paidSoFar: Long, words: Words = Words(), base: Picture = Picture(), points: Long = 0,
    ): Picture {
        if (rung.isEmpty()) return idleOf(base)
        val lines = rung.map { r ->
            // a price raised above the list is no discount: it shows at what it is charged
            val listed = r.listed?.takeIf { it > r.unit } ?: r.unit
            val off = if (listed > r.unit && listed > 0) (((listed - r.unit) * 100 + listed / 2) / listed).toInt() else 0
            PicLine(qty(r.qty), r.name, r.detail, r.amount, price = listed, off = off)
        }
        // what each line's discount took off its listed price, and the line at that price
        val lineOff = rung.sumOf { r -> Calc.lineAmount(r.listed?.takeIf { it > r.unit } ?: r.unit, r.qty) - Calc.lineAmount(r.unit, r.qty) }
        val gross = rung.sumOf { it.amount } + lineOff
        val added = totals.tax - vatIncluded
        val discount = lineOff + totals.discount
        val sums = ArrayList<PicSum>()
        sums += PicSum(words.subtotal, totals.subtotal)
        val used = points.coerceIn(0, totals.discount.coerceAtLeast(0))
        if (totals.discount - used > 0) sums += PicSum(discountName?.takeIf { it.isNotBlank() } ?: "Discount", -(totals.discount - used))
        if (used > 0) sums += PicSum(words.points, -used)
        if (totals.service > 0) sums += PicSum("${words.service} ${pct(servicePct)}", totals.service)
        if (vatIncluded > 0) sums += PicSum(words.vatIncluded, vatIncluded)
        if (added > 0) sums += PicSum(words.vat, added)
        if (totals.rounding != 0L) sums += PicSum(words.rounding, totals.rounding)
        return base.copy(
            state = Picture.SALE, title = title, lines = lines, sums = sums,
            total = totals.total + paidSoFar, paid = paidSoFar, left = totals.total, change = 0,
            gross = gross, discount = discount, vat = totals.tax, vatAdded = added, service = totals.service, rounding = totals.rounding,
            quantity = rung.sumOf { (it.qty + 500) / 1000 }.coerceAtLeast(0),
        )
    }

    // The sale just paid: its lines and figures as they stood (`sale`, the
    // last picture of it), what was handed over, and the change. Without the
    // sale's picture, the total alone.
    fun paid(total: Long, change: Long, sale: Picture? = null, base: Picture = Picture()): Picture {
        val c = change.coerceAtLeast(0)
        // the sale's lines only when they are this sale's (the same total): never another customer's
        val from = sale?.takeIf { it.state == Picture.SALE && it.total == total } ?: idleOf(base).copy(gross = total)
        return from.copy(
            state = Picture.PAID, total = total, paid = total + c, left = 0, change = c,
            lang = base.lang, decimals = base.decimals, business = base.business, message = base.message,
        )
    }

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

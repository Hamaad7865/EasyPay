package com.restopos.core.data

// Totals mirror the server (push_receipt_create): integer cents, identical
// rounding, so the tablet shows and prints exactly what sync_push will store.
//   line     = (price * qty + 500) / 1000, qty in thousandths, plus its
//              modifiers, which are charged once per line
//   discount = percent of the subtotal (half up), or an amount, never more
//              than what is left of the subtotal
//   tax      = per line on (line - its share of the discount):
//                added:    (base * rate + 5000) / 10000, goes on top
//                included: (base * rate + (10000 + rate) / 2) / (10000 + rate),
//                          already inside the price; shown, never added
//   service  = ((subtotal - discount) * pct + 5000) / 10000, pct in basis points
//   total    = subtotal - discount + added tax + service + rounding
object Calc {
    fun lineAmount(price: Long, qty: Int): Long = (price * qty + 500) / 1000

    data class Line(val base: Long, val taxes: List<TaxRate>)
    data class TaxRate(val rateBp: Int, val type: String)
    data class Discount(val percent: Int?, val amount: Long)

    data class Totals(
        val subtotal: Long,
        val discount: Long,
        val tax: Long,
        val total: Long,
        val service: Long = 0,
        // what each discount took off, in the order given (sent to the server
        // as charged, so its receipt matches the printed one)
        val discountAmounts: List<Long> = emptyList(),
        val rounding: Long = 0,
    )

    fun totals(lines: List<Line>, discounts: List<Discount>, servicePct: Int = 0, rounding: Long = 0): Totals {
        val sub = lines.sumOf { it.base }
        var disc = 0L
        val amounts = discounts.map { d ->
            var a = if (d.percent != null) (sub * d.percent + 50) / 100 else minOf(d.amount, sub - disc)
            if (a < 0) a = 0
            if (sub > 0 && disc + a > sub) a = sub - disc
            disc += a
            a
        }
        var taxAdded = 0L
        var taxIncluded = 0L
        lines.forEach { l ->
            val share = if (sub > 0) disc * l.base / sub else 0
            l.taxes.forEach { t ->
                if (t.type == "added") {
                    taxAdded += ((l.base - share) * t.rateBp + 5000) / 10000
                } else {
                    val div = 10000L + t.rateBp
                    taxIncluded += ((l.base - share) * t.rateBp + div / 2) / div
                }
            }
        }
        val service = ((sub - disc) * servicePct + 5000) / 10000
        return Totals(sub, disc, taxAdded + taxIncluded, sub - disc + taxAdded + service + rounding, service, amounts, rounding)
    }

    // The same totals, rounded to what can be paid with the decimals the
    // restaurant shows (to the rupee with none). The server keeps the
    // rounding as its own figure on the receipt.
    fun totalsRounded(lines: List<Line>, discounts: List<Discount>, servicePct: Int = 0): Totals {
        val t = totals(lines, discounts, servicePct, 0)
        val r = com.restopos.core.common.Money.roundingFor(t.total)
        return if (r == 0L) t else totals(lines, discounts, servicePct, r)
    }
}

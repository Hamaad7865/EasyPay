package com.restopos.core.data

// Totals mirror the server (0012): integer cents, half-up biases identical so
// the tablet shows exactly what sync_push will store (spec 14.12).
// line = (price * qty + 500) / 1000, qty in thousandths.
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
    )

    fun totals(lines: List<Line>, discounts: List<Discount>, service: Long = 0, rounding: Long = 0): Totals {
        val sub = lines.sumOf { it.base }
        var disc = 0L
        discounts.forEach { d ->
            val a = if (d.percent != null) (sub * d.percent + 50) / 100
            else minOf(d.amount, sub - disc)
            disc += maxOf(0, a)
        }
        var tax = 0L
        lines.forEach { l ->
            val share = if (sub > 0) disc * l.base / sub else 0
            l.taxes.forEach { t ->
                if (t.type == "added") tax += ((l.base - share) * t.rateBp + 5000) / 10000
            }
        }
        return Totals(sub, disc, tax, sub - disc + tax + service + rounding)
    }
}

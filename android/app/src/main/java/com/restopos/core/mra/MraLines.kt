package com.restopos.core.mra

import com.restopos.core.data.Calc
import com.restopos.core.data.RefundCalc

// One line of a sale as the till has it: what it charges before the order
// discount (Calc's base, add-ons in), its taxes, and what the MRA needs to
// know of it. nature is GOODS or SERVICES; mraCode its tax's MRA code, when
// the business saved one.
data class SaleLine(
    val name: String,
    val addons: List<String>,
    val sku: String?,
    val qtyMilli: Int,
    val base: Long,
    val taxes: List<Calc.TaxRate>,
    val mraCode: String?,
    val taxName: String,
    val nature: String,
)

// A receipt as the MRA's lines (docs/superpowers/plans/2026-10-21-mra-phase-2-till.md,
// "How a sale becomes an invoice"): the order discount spread over the lines
// as Calc spreads it, so the MRA is told the VAT the receipt shows; a service
// charge as a line of its own, exempt; cash rounding left out.
object MraLines {
    const val SERVICE = "Service charge"

    // the lines and the cents of the order discount the lines did not take
    fun ofSale(lines: List<SaleLine>, discount: Long, service: Long): Pair<List<Line>, Long> {
        val sold = lines.filter { it.qtyMilli > 0 }
        val sub = sold.sumOf { it.base }
        var taken = 0L
        val out = sold.map { l ->
            val share = if (sub > 0) discount * l.base / sub else 0
            taken += share
            line(l, l.qtyMilli, l.base, share, null)
        }
        return (out + serviceLines(service)) to (discount - taken)
    }

    // what a refund gives back, line by line, as the till's refund worked it
    // out (RefundCalc): its VAT is the refund's, not worked out again
    fun ofRefund(back: List<Triple<SaleLine, Int, RefundCalc.Parts>>): List<Line> {
        val lines = back.filter { it.second > 0 }.map { (l, q, p) -> line(l, q, p.sub, p.disc, p.tax) }
        return lines + serviceLines(back.sumOf { it.third.svc })
    }

    private fun line(l: SaleLine, qtyMilli: Int, base: Long, share: Long, vat: Long?): Line {
        val tax = l.taxes.firstOrNull()
        return Line(
            desc = desc(l.name, l.addons), code = l.sku.orEmpty(), taxCode = code(l.mraCode, tax?.rateBp, l.taxName), nature = l.nature,
            qtyMilli = qtyMilli, base = base, share = share, vatBp = tax?.rateBp ?: 0, added = tax?.type == "added", vat = vat,
        )
    }

    private fun serviceLines(service: Long) =
        if (service > 0) listOf(Line(SERVICE, "", "TC03", "SERVICES", 1000, service)) else emptyList()

    // "Burger (Egg, Cheese)", at most 100 characters (the MRA's limit)
    fun desc(name: String, addons: List<String>): String =
        (if (addons.isEmpty()) name else "$name (${addons.joinToString(", ")})").take(100)

    // the tax's own code, else what its rate suggests (as web/lib/mra.ts suggests it)
    fun code(own: String?, rateBp: Int?, taxName: String = ""): String = own?.takeIf { it.isNotBlank() } ?: when (rateBp) {
        null -> "TC03"
        0 -> if (Regex("exempt", RegexOption.IGNORE_CASE).containsMatchIn(taxName)) "TC03" else "TC02"
        else -> "TC01"
    }

    // How it was paid (salesTransactions): any part on account is CREDIT;
    // otherwise the largest payment's kind, the first of two the same.
    fun payment(paid: List<Pair<String, Long>>): String {
        if (paid.any { it.first == "account" && it.second > 0 }) return "CREDIT"
        return when (paid.maxByOrNull { it.second }?.first) {
            "cash" -> "CASH"
            "card" -> "CARD"
            else -> "OTHER"
        }
    }

    // why this sale cannot go to the MRA, or null: the MRA takes one tax code a line
    fun refusal(lines: List<SaleLine>): String? =
        lines.firstOrNull { it.taxes.size > 1 }?.let { "${it.name} has two taxes: the MRA takes one a line. Change its taxes in the back office." }
}

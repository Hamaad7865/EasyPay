package com.restopos.core.data

import com.restopos.core.print.DocTax
import com.restopos.core.print.ReceiptDoc
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

// The till's own reports, as plain arithmetic: each is a function of the
// receipts this till holds for a period and of what each printed (its
// ReceiptDoc: lines with their category and listed price, the cashier, the
// order type, the payments, the VAT). Money is cents, quantities thousandths.
// A refund counts against the day it was made and is taken off what it
// refunds: a category, a product, a member of staff.
// Sales Summary's totals and the VAT are not worked out here: they come from
// CashOps.period, the sum the day closings are made from, so a report and a
// day closing of the same days always agree.
object Reports {
    // A receipt as a report reads it: the row the tablet keeps, and what it
    // printed. doc is null for a receipt whose printed record the tablet does
    // not hold: it is in the totals and the list of receipts, and in no breakdown.
    data class Sale(val id: String, val number: String, val refund: Boolean, val refundOf: String?, val at: Long, val total: Long, val doc: ReceiptDoc?)

    enum class Pick(val label: String) { Today("Today"), Yesterday("Yesterday"), Week("This week"), Month("This month"), LastMonth("Last month"), Custom("Dates") }

    // Whole days by the tablet's clock. `from` is not in the period and `to`
    // is, as CashOps.period reads them: the last instant of the day before the
    // first day, and the last instant of the last day.
    data class Span(val from: Long, val to: Long, val first: LocalDate, val last: LocalDate)

    // A week starts on Monday. Custom takes its two days in either order.
    // Nothing reaches past today: there are no sales tomorrow.
    fun span(pick: Pick, today: LocalDate, zone: ZoneId, from: LocalDate? = null, to: LocalDate? = null): Span {
        val (a, b) = when (pick) {
            Pick.Today -> today to today
            Pick.Yesterday -> today.minusDays(1) to today.minusDays(1)
            Pick.Week -> today.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)) to today
            Pick.Month -> today.withDayOfMonth(1) to today
            Pick.LastMonth -> today.minusMonths(1).withDayOfMonth(1) to today.withDayOfMonth(1).minusDays(1)
            Pick.Custom -> {
                val x = (from ?: today).coerceAtMost(today)
                val y = (to ?: today).coerceAtMost(today)
                minOf(x, y) to maxOf(x, y)
            }
        }
        val start = a.atStartOfDay(zone).toInstant().toEpochMilli()
        val end = b.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        return Span(start - 1, end - 1, a, b)
    }

    private val DAY = DateTimeFormatter.ofPattern("d MMM", Locale.US)
    private val DAY_YEAR = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.US)

    // "11 Oct 2026", "5 Oct to 11 Oct 2026", "28 Dec 2026 to 3 Jan 2027"
    fun says(s: Span): String = when {
        s.first == s.last -> DAY_YEAR.format(s.last)
        s.first.year == s.last.year -> "${DAY.format(s.first)} to ${DAY_YEAR.format(s.last)}"
        else -> "${DAY_YEAR.format(s.first)} to ${DAY_YEAR.format(s.last)}"
    }

    private fun signed(s: Sale, amount: Long) = if (s.refund) -amount else amount
    private fun day(at: Long, zone: ZoneId): LocalDate = Instant.ofEpochMilli(at).atZone(zone).toLocalDate()

    // ---- a line a day ----
    data class Day(val day: LocalDate, val sales: Int, val refunds: Int, val net: Long)

    // Only the days something happened on, oldest first.
    fun byDay(sales: List<Sale>, zone: ZoneId): List<Day> =
        sales.groupBy { day(it.at, zone) }.toSortedMap().map { (d, rows) ->
            Day(d, rows.count { !it.refund }, rows.count { it.refund }, rows.sumOf { signed(it, it.total) })
        }

    // ---- the same sales, cut one way ----
    // count: how many receipts it is on (a refund's receipt is not a sale).
    // qty: units in thousandths, for products and categories. amount: what it
    // came to, refunds taken off. share: its part of the whole, in tenths of a percent.
    data class Cut(val name: String, val count: Int, val qty: Int, val amount: Long, val share: Int)

    private class Sum(var count: Int = 0, var qty: Int = 0, var amount: Long = 0)

    private fun cuts(sums: Map<String, Sum>, byQty: Boolean = false): List<Cut> {
        val whole = sums.values.sumOf { it.amount }
        return sums.map { (name, s) -> Cut(name, s.count, s.qty, s.amount, if (whole > 0) Math.round(s.amount * 1000.0 / whole).toInt() else 0) }
            .sortedWith(if (byQty) compareByDescending<Cut> { it.qty }.thenByDescending { it.amount } else compareByDescending<Cut> { it.amount }.thenByDescending { it.qty })
    }

    // By what a receipt's lines say: a line's amount is what it came to before
    // any discount on the whole sale, as the day closing's "by category" is.
    private fun byLine(sales: List<Sale>, key: (com.restopos.core.print.DocLine) -> String, byQty: Boolean = false): List<Cut> {
        val sums = LinkedHashMap<String, Sum>()
        sales.forEach { s ->
            val sign = if (s.refund) -1 else 1
            val seen = HashSet<String>()
            s.doc?.lines?.forEach { l ->
                val k = key(l)
                val sum = sums.getOrPut(k) { Sum() }
                sum.qty += sign * l.qty
                sum.amount += sign * l.amount
                if (!s.refund && seen.add(k)) sum.count += 1
            }
        }
        return cuts(sums, byQty)
    }

    // By what the receipt itself says: its whole total, discounts and all.
    private fun byReceipt(sales: List<Sale>, key: (ReceiptDoc) -> String): List<Cut> {
        val sums = LinkedHashMap<String, Sum>()
        sales.forEach { s ->
            val d = s.doc ?: return@forEach
            val sum = sums.getOrPut(key(d)) { Sum() }
            sum.amount += signed(s, s.total)
            if (!s.refund) sum.count += 1
        }
        return cuts(sums)
    }

    fun byCategory(sales: List<Sale>): List<Cut> = byLine(sales, { it.cat?.takeIf { c -> c.isNotBlank() } ?: "No category" })
    fun byStaff(sales: List<Sale>): List<Cut> = byReceipt(sales) { it.cashier?.takeIf { c -> c.isNotBlank() } ?: "Nobody signed in" }
    fun byOrderType(sales: List<Sale>): List<Cut> = byReceipt(sales) { it.dining?.takeIf { c -> c.isNotBlank() } ?: "Direct sale" }

    // Every product sold, ranked by what it came to, or by how many.
    fun items(sales: List<Sale>, byQty: Boolean): List<Cut> = byLine(sales, { it.name }, byQty)

    // ---- by the hour ----
    data class Hour(val hour: Int, val sales: Int, val amount: Long)

    // From the first hour something happened in to the last, the empty ones
    // between them included. Over several days, an hour is all its days together.
    fun hourly(sales: List<Sale>, zone: ZoneId): List<Hour> {
        if (sales.isEmpty()) return emptyList()
        val by = sales.groupBy { Instant.ofEpochMilli(it.at).atZone(zone).hour }
        return (by.keys.min()..by.keys.max()).map { h ->
            val rows = by[h].orEmpty()
            Hour(h, rows.count { !it.refund }, rows.sumOf { signed(it, it.total) })
        }
    }

    // ---- every receipt ----
    data class Tx(val id: String, val number: String, val at: Long, val refund: Boolean, val who: String?, val paid: String, val total: Long)

    // Newest first. paid: "Cash", "Cash + Card"; nothing when the tablet does not hold what it printed.
    fun transactions(sales: List<Sale>): List<Tx> = sales.sortedByDescending { it.at }.map { s ->
        Tx(s.id, s.number, s.at, s.refund, s.doc?.cashier?.takeIf { it.isNotBlank() }, s.doc?.payments?.map { it.name }?.distinct()?.joinToString(" + ").orEmpty(), s.total)
    }

    // ---- sold at another price than listed ----
    data class Repriced(val at: Long, val receipt: String, val receiptId: String, val product: String, val was: Long, val charged: Long, val why: String, val who: String?)

    // The lines of sales that printed with another price than the listed one:
    // a discount on one line, or a price typed for that sale. Newest first.
    fun repriced(sales: List<Sale>): List<Repriced> = sales.filter { !it.refund }.sortedByDescending { it.at }.flatMap { s ->
        s.doc?.lines.orEmpty().filter { it.was != null && it.was != it.amount }.map { l ->
            Repriced(s.at, s.number, s.id, l.name, l.was!!, l.amount, l.priceNote?.takeIf { it.isNotBlank() } ?: "Price changed", s.doc?.cashier?.takeIf { it.isNotBlank() })
        }
    }

    // ---- refunds ----
    data class Refund(val id: String, val number: String, val of: String?, val at: Long, val amount: Long, val who: String?)

    // of: the number of the sale it refunds, as the refund printed it.
    fun refunds(sales: List<Sale>): List<Refund> = sales.filter { it.refund }.sortedByDescending { it.at }.map { s ->
        Refund(s.id, s.number, (s.doc?.refundOf ?: s.refundOf)?.takeIf { it.isNotBlank() }, s.at, s.total, s.doc?.cashier?.takeIf { it.isNotBlank() })
    }

    // ---- VAT ----
    data class TaxLine(val name: String, val rateBp: Int, val excl: Long, val vat: Long, val incl: Long)

    // For each rate, the VAT is what the receipts printed. What it was charged
    // on is worked out from it and the rate: the tablet keeps no VAT line by
    // line. What is left of the net sales carried no VAT, and is the last line.
    // taxes: the period's VAT by rate (CashOps.period). net: sales less refunds.
    fun tax(taxes: List<DocTax>, net: Long): List<TaxLine> {
        val lines = taxes.filter { it.rateBp > 0 && it.amount != 0L }.sortedByDescending { it.rateBp }.map { t ->
            val excl = Math.round(t.amount * 10000.0 / t.rateBp)
            TaxLine(t.name, t.rateBp, excl, t.amount, excl + t.amount)
        }
        val rest = net - lines.sumOf { it.incl }
        // a rupee of rounding is not a sale without VAT
        return if (rest > lines.size.toLong() * 100 || (lines.isEmpty() && rest != 0L)) lines + TaxLine("No VAT", 0, rest, 0, rest) else lines
    }

    // ---- what the tablet wrote down (till_log) ----
    // A row of the log with the names read for it: who did it and who gave their word.
    class Logged(val at: Long, val who: String?, val approvedBy: String?, val item: String?, val variant: String?, val receipt: String?, val was: String, val became: String)

    data class PriceChange(val at: Long, val product: String, val was: Long, val now: Long, val who: String?, val approvedBy: String?)

    // A product's own price changed on this till. product: what it is called now, or null when it is gone.
    fun priceChanges(rows: List<Logged>, product: (item: String, variant: String?) -> String?): List<PriceChange> = rows.mapNotNull { r ->
        val item = r.item ?: return@mapNotNull null
        PriceChange(r.at, product(item, r.variant) ?: "A product that is gone", r.was.toLongOrNull() ?: return@mapNotNull null, r.became.toLongOrNull() ?: return@mapNotNull null, r.who, r.approvedBy)
    }

    data class Corrected(val at: Long, val receipt: String, val receiptId: String?, val was: String, val now: String, val who: String?, val approvedBy: String?)

    // A payment type corrected after the sale. number: the receipt's number, or null when the tablet no longer holds it.
    fun corrected(rows: List<Logged>, number: (receiptId: String) -> String?): List<Corrected> = rows.mapNotNull { r ->
        val id = r.receipt ?: return@mapNotNull null
        val n = number(id)
        Corrected(r.at, n ?: "A receipt no longer on this tablet", id.takeIf { n != null }, r.was, r.became, r.who, r.approvedBy)
    }
}

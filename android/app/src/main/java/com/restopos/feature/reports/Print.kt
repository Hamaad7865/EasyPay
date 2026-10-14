package com.restopos.feature.reports

import com.restopos.core.data.DocLines
import com.restopos.core.data.Reports
import com.restopos.core.print.Docs
import com.restopos.core.print.ReportLine
import com.restopos.core.print.ReportLine.Kind
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val STAMP = DateTimeFormatter.ofPattern("d MMM HH:mm", Locale.US)
private val DAY = DateTimeFormatter.ofPattern("EEE d MMM", Locale.US)

internal fun stamp(at: Long, zone: ZoneId): String = STAMP.format(Instant.ofEpochMilli(at).atZone(zone))
// a share kept in tenths of a percent, said as "91.3%"
internal fun percent(share: Int): String = if (share % 10 == 0) "${share / 10}%" else "${share / 10}.${share % 10}%"
internal fun hourSaid(h: Int): String = "%02d:00".format(Locale.US, h)

// The rows the Analysis report shows for the cut picked.
internal fun cutsOf(d: ReportData, cutting: Cutting): List<Reports.Cut> = when (cutting) {
    Cutting.Category -> Reports.byCategory(d.sales)
    Cutting.Staff -> Reports.byStaff(d.sales)
    Cutting.Order -> Reports.byOrderType(d.sales)
}

// "1 refund", "3 refunds"
internal fun counted(n: Int, one: String, many: String) = if (n == 1) "1 $one" else "$n $many"

private fun head(text: String) = ReportLine(text, kind = Kind.Head)
private val RULE = ReportLine("", kind = Kind.Rule)

// A report as the receipt printer gets it: the same figures the screen shows,
// as a left and a right on narrow paper.
internal fun printed(r: Report, d: ReportData, cutting: Cutting, byQty: Boolean, retail: Boolean, zone: ZoneId): List<ReportLine> {
    val n = { c: Long -> Docs.num(c, d.decimals) }
    val nothing = listOf(ReportLine("Nothing in these days."))
    return when (r) {
        Report.Summary -> {
            val f = d.figures ?: return nothing
            buildList {
                add(ReportLine("Receipts", f.sales.toString()))
                add(ReportLine("Sales", n(f.gross)))
                add(ReportLine("Refunds (${f.refunds})", n(-f.refunded)))
                add(ReportLine("NET SALES", "Rs " + n(f.net), Kind.Total))
                add(ReportLine("Of which VAT", n(f.tax)))
                add(ReportLine("Discounts given", n(f.discounts)))
                if (f.priceChanges != 0L) add(ReportLine("Price changes", n(-f.priceChanges)))
                if (f.sales > 0) add(ReportLine("Average sale", n(f.net / f.sales)))
                add(RULE); add(head("By payment method"))
                f.payments.forEach { add(ReportLine("${it.name} (${it.count})", n(it.amount))) }
                if (f.notesIssued != 0L || f.notesRedeemed != 0L) {
                    add(ReportLine("Credit notes issued", n(f.notesIssued))); add(ReportLine("Credit notes redeemed", n(f.notesRedeemed)))
                }
                add(RULE); add(head("Cash in and out"))
                add(ReportLine("Cash in", n(f.cashIn))); add(ReportLine("Cash out", n(-f.cashOut)))
                val days = Reports.byDay(d.sales, zone)
                if (days.size > 1) {
                    add(RULE); add(head("By day"))
                    days.forEach { add(ReportLine("${DAY.format(it.day)} (${it.sales})", n(it.net))) }
                }
            }
        }
        Report.Analysis -> {
            val cut = if (retail && cutting == Cutting.Order) Cutting.Category else cutting
            val rows = cutsOf(d, cut)
            if (rows.isEmpty()) nothing else listOf(head(cut.label)) + rows.map { c ->
                ReportLine("${c.name} (${if (cut == Cutting.Category) DocLines.shown(c.qty) else c.count.toString()}) ${percent(c.share)}", n(c.amount))
            }
        }
        Report.Items -> {
            val rows = Reports.items(d.sales, byQty)
            if (rows.isEmpty()) nothing else listOf(head(if (byQty) "By quantity" else "By amount")) + rows.mapIndexed { i, c ->
                ReportLine("${i + 1}. ${c.name} x ${DocLines.shown(c.qty)}", n(c.amount))
            }
        }
        Report.Hourly -> {
            val rows = Reports.hourly(d.sales, zone)
            if (rows.isEmpty()) nothing else rows.map { ReportLine("${hourSaid(it.hour)} (${it.sales})", n(it.amount)) }
        }
        Report.Transactions -> {
            val rows = Reports.transactions(d.sales)
            if (rows.isEmpty()) nothing else rows.map { t ->
                ReportLine(listOfNotNull(stamp(t.at, zone), t.number, if (t.refund) "REFUND" else null, t.paid.ifEmpty { null }, t.who).joinToString(" "), n(if (t.refund) -t.total else t.total))
            } + RULE + ReportLine(counted(rows.count { !it.refund }, "sale", "sales") + ", " + counted(rows.count { it.refund }, "refund", "refunds"), n(rows.sumOf { if (it.refund) -it.total else it.total }), Kind.Total)
        }
        Report.Prices -> {
            val rows = Reports.repriced(d.sales)
            listOf(head("Sold at another price")) + (if (rows.isEmpty()) nothing else rows.map { p ->
                ReportLine("${stamp(p.at, zone)} ${p.product}: ${p.why}, was ${n(p.was)}${p.who?.let { w -> " ($w)" } ?: ""}", n(p.charged))
            }) + RULE + head("A product's own price changed") + (if (d.prices.isEmpty()) nothing else d.prices.map { p ->
                ReportLine("${stamp(p.at, zone)} ${p.product}, was ${n(p.was)}${p.who?.let { w -> " ($w)" } ?: ""}", n(p.now))
            })
        }
        Report.Resettlement -> {
            val rows = Reports.refunds(d.sales)
            listOf(head("Refunds")) + (if (rows.isEmpty()) nothing else rows.map { x ->
                ReportLine("${stamp(x.at, zone)} ${x.number}${x.of?.let { o -> " of $o" } ?: ""}${x.who?.let { w -> " ($w)" } ?: ""}", n(-x.amount))
            } + RULE + ReportLine(counted(rows.size, "refund", "refunds"), n(-rows.sumOf { it.amount }), Kind.Total)) + RULE + head("Payments corrected") + (if (d.corrected.isEmpty()) nothing else d.corrected.map { c ->
                ReportLine("${stamp(c.at, zone)} ${c.receipt}, was ${c.was}${c.who?.let { w -> " ($w)" } ?: ""}", c.now)
            })
        }
        Report.Shifts -> if (d.days.isEmpty()) listOf(ReportLine("No day was closed in these days.")) else d.days.flatMap { s ->
            buildList {
                add(head("Day closing No. ${s.close.number}"))
                s.openedAt?.let { add(ReportLine("Opened", stamp(it, zone) + (s.openedBy?.let { w -> " $w" } ?: ""))) }
                add(ReportLine("Closed", stamp(s.close.closed_at, zone) + (s.closedBy?.let { w -> " $w" } ?: "")))
                s.float?.let { add(ReportLine("Opening float", n(it))) }
                if (s.expected != null && s.counted != null) {
                    add(ReportLine("Expected in drawer", n(s.expected)))
                    add(ReportLine("Counted", n(s.counted)))
                    val diff = s.counted - s.expected
                    add(ReportLine(if (diff == 0L) "Difference" else if (diff < 0) "SHORT" else "OVER", n(diff), Kind.Total))
                }
                add(RULE)
            }
        }
        Report.Tax -> {
            val f = d.figures ?: return nothing
            val rows = Reports.tax(f.taxes, f.net)
            if (rows.isEmpty()) nothing else rows.flatMap { t ->
                listOf(
                    head(if (t.rateBp == 0) t.name else "${t.name} ${Docs.num(t.rateBp.toLong(), 2).removeSuffix(".00")}%"),
                    ReportLine("Excluding VAT", n(t.excl)), ReportLine("VAT", n(t.vat)), ReportLine("Including VAT", n(t.incl)),
                )
            } + RULE + ReportLine("VAT", "Rs " + n(rows.sumOf { it.vat }), Kind.Total)
        }
    }
}

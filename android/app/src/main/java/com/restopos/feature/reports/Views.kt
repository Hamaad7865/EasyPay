package com.restopos.feature.reports

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.data.DocLines
import com.restopos.core.data.Reports
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.panel
import com.restopos.core.ui.press
import java.time.format.DateTimeFormatter
import java.util.Locale

private val DAY = DateTimeFormatter.ofPattern("EEE d MMM", Locale.US)
private val PAD = PaddingValues(horizontal = 18.dp, vertical = 10.dp)

// The open report, of the period's receipts and figures.
@Composable
internal fun ReportView(report: Report, d: ReportData, vm: ReportsViewModel, onReceipt: (String) -> Unit) {
    val retail by vm.retail.collectAsState()
    when (report) {
        Report.Summary -> Summary(d, vm)
        Report.Analysis -> Analysis(d, vm, retail)
        Report.Items -> Items(d, vm)
        Report.Hourly -> Hourly(d, vm)
        Report.Transactions -> Transactions(d, vm, onReceipt)
        Report.Prices -> Prices(d, vm)
        Report.Resettlement -> Resettlement(d, vm, onReceipt)
        Report.Shifts -> Shifts(d, vm)
        Report.Tax -> Tax(d)
    }
}

// ---------------------------------------------------------------- pieces

// The report's own page: a panel that scrolls.
@Composable
private fun Page(content: LazyListScope.() -> Unit) {
    LazyColumn(Modifier.fillMaxSize().panel(), contentPadding = PaddingValues(vertical = 8.dp), content = content)
}

@Composable
private fun Blank(text: String = "Nothing was sold in these days.") {
    T(text, 15.sp, 500, V.Text2, Modifier.padding(24.dp), lines = 3)
}

// A headline figure: what it is, the figure, a line under it.
@Composable
private fun RowScope.Kpi(label: String, value: String, sub: String = "", color: Color = V.Text) {
    Column(Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).background(V.Well).padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Caps(label)
        T(value, 20.sp, 800, color, spacing = (-0.3).sp)
        if (sub.isNotEmpty()) T(sub, 12.sp, 500, V.Text2)
    }
}

// A name on the left, a figure on the right, something small between them.
@Composable
private fun Line(left: String, right: String, mid: String = "", bold: Boolean = false, color: Color = V.Text, under: String = "", onClick: (() -> Unit)? = null) {
    Row(
        (if (onClick != null) Modifier.press(0.99f, onClick) else Modifier).fillMaxWidth().padding(PAD),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(left, 15.sp, if (bold) 800 else 600, V.Text)
            if (under.isNotEmpty()) T(under, 13.sp, 500, V.Text2, lines = 2)
        }
        if (mid.isNotEmpty()) T(mid, 13.sp, 600, V.Text2)
        T(right, if (bold) 17.sp else 15.sp, if (bold) 800 else 700, color, Modifier.width(130.dp), align = TextAlign.End)
    }
}

@Composable
private fun Heading(text: String) {
    Caps(text, modifier = Modifier.padding(start = 18.dp, end = 18.dp, top = 16.dp, bottom = 4.dp))
}

// A cut's row: its name, how many, a bar for its share, what it came to.
@Composable
private fun CutRow(rank: Int?, c: Reports.Cut, count: String) {
    Row(Modifier.fillMaxWidth().padding(PAD), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (rank != null) T("$rank", 13.sp, 700, V.Text3, Modifier.width(28.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            T(c.name, 15.sp, 700)
            Bar(c.share / 1000f, 6.dp)
        }
        T(count, 13.sp, 600, V.Text2, Modifier.width(90.dp), align = TextAlign.End)
        T(percent(c.share), 13.sp, 600, V.Text2, Modifier.width(56.dp), align = TextAlign.End)
        T(Money.format(c.amount), 15.sp, 700, if (c.amount < 0) V.RedText else V.Text, Modifier.width(120.dp), align = TextAlign.End)
    }
}

// A share of the whole, as a bar.
@Composable
private fun Bar(part: Float, height: Dp, color: Color = V.Blue) {
    Box(Modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(height / 2)).background(V.Well)) {
        if (part > 0f) Box(Modifier.fillMaxWidth(part.coerceIn(0.01f, 1f)).height(height).clip(RoundedCornerShape(height / 2)).background(color))
    }
}

// What an empty list of the log says: that nothing was changed, and from which day the tablet has kept such things.
private fun keptSince(since: Long?, nothing: String, vm: ReportsViewModel): String =
    nothing + " " + (since?.let { "The tablet has kept these since ${stamp(it, vm.zone())}." } ?: "The tablet keeps these from this build on: nothing has been changed since.")

private fun signed(refund: Boolean, amount: Long) = Money.format(if (refund) -amount else amount)

// ---------------------------------------------------------------- the nine

@Composable
private fun Summary(d: ReportData, vm: ReportsViewModel) {
    val f = d.figures
    if (f == null || (f.sales == 0 && f.refunds == 0)) { Blank(); return }
    val days = remember(d) { Reports.byDay(d.sales, vm.zone()) }
    val paid = f.payments.sumOf { it.amount }
    Page {
        item {
            Row(Modifier.padding(horizontal = 14.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Kpi("Net sales", Money.format(f.net), "Sales less refunds")
                Kpi("Sales", f.sales.toString(), if (f.sales > 0) "${Money.format(f.net / f.sales)} on average" else "")
                Kpi("Refunds", Money.format(f.refunded), if (f.refunds == 1) "1 refund" else "${f.refunds} refunds", if (f.refunded > 0) V.RedText else V.Text)
                Kpi("VAT", Money.format(f.tax), "In the net sales")
            }
        }
        item { Heading("How it is made up") }
        item { Line("Sales", Money.format(f.gross), counted(f.sales, "receipt", "receipts")) }
        item { Line("Refunds", Money.format(-f.refunded), "${f.refunds}") }
        item { Line("Net sales", Money.format(f.net), bold = true) }
        item { Line("Of which VAT", Money.format(f.tax)) }
        item { Line("Discounts given", Money.format(f.discounts), under = "Already off the sales above") }
        if (f.priceChanges != 0L) item { Line("Price changes", Money.format(-f.priceChanges), under = "Prices typed for one sale, against the listed ones") }
        item { Heading("How it was paid") }
        items(f.payments) { p -> Line(p.name, Money.format(p.amount), "${p.count} · ${if (paid > 0) percent(Math.round(p.amount * 1000.0 / paid).toInt()) else "0%"}") }
        item { Heading("Cash in and out") }
        item { Line("Cash put in", Money.format(f.cashIn)) }
        item { Line("Cash taken out", Money.format(-f.cashOut)) }
        if (days.size > 1) {
            item { Heading("A line a day") }
            items(days) { day -> Line(DAY.format(day.day), Money.format(day.net), counted(day.sales, "sale", "sales") + if (day.refunds > 0) ", ${day.refunds} refunded" else "") }
        }
    }
}

@Composable
private fun Analysis(d: ReportData, vm: ReportsViewModel, retail: Boolean) {
    val picked by vm.cutting.collectAsState()
    // a shop has no order types
    val cutting = if (retail && picked == Cutting.Order) Cutting.Category else picked
    val rows = remember(d, cutting) { cutsOf(d, cutting) }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Seg(Cutting.entries.filter { !retail || it != Cutting.Order }.map { c -> SegOption(c.label, c == cutting) { vm.cutting.value = c } }, well = V.Panel, height = 40.dp, size = 14.sp)
        if (rows.isEmpty()) Blank()
        else Page {
            item {
                T(
                    if (cutting == Cutting.Category) "What each category's lines came to, before any discount on a whole sale. A refund is taken off its category."
                    else "Whole receipts, discounts and all. A refund is taken off whoever made it.",
                    13.sp, 500, V.Text3, Modifier.padding(horizontal = 18.dp, vertical = 6.dp), lines = 2,
                )
            }
            items(rows) { c -> CutRow(null, c, if (cutting == Cutting.Category) "${DocLines.shown(c.qty)} sold" else if (c.count == 1) "1 sale" else "${c.count} sales") }
        }
    }
}

@Composable
private fun Items(d: ReportData, vm: ReportsViewModel) {
    val byQty by vm.byQty.collectAsState()
    val q by vm.query.collectAsState()
    val all = remember(d, byQty) { Reports.items(d.sales, byQty) }
    // a product keeps its rank when the list is searched
    val rows = remember(all, q) { all.withIndex().filter { q.isBlank() || it.value.name.contains(q.trim(), ignoreCase = true) } }
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Seg(listOf(SegOption("By amount", !byQty) { vm.byQty.value = false }, SegOption("By quantity", byQty) { vm.byQty.value = true }), well = V.Panel, height = 40.dp, size = 14.sp)
            Field(q, { vm.query.value = it.take(40) }, "Search a product", Modifier.weight(1f), height = 48.dp, bg = V.Panel)
        }
        if (all.isEmpty()) Blank()
        else if (rows.isEmpty()) Blank("Nothing sold in these days matches “${q.trim()}”.")
        else Page { items(rows) { (i, c) -> CutRow(i + 1, c, "${DocLines.shown(c.qty)} sold") } }
    }
}

@Composable
private fun Hourly(d: ReportData, vm: ReportsViewModel) {
    val rows = remember(d) { Reports.hourly(d.sales, vm.zone()) }
    if (rows.isEmpty()) { Blank(); return }
    val most = rows.maxOf { it.amount }.coerceAtLeast(1)
    Page {
        if (d.span.first != d.span.last) item {
            T("Each hour is all the days of the period together.", 13.sp, 500, V.Text3, Modifier.padding(horizontal = 18.dp, vertical = 6.dp))
        }
        items(rows) { h ->
            Row(Modifier.fillMaxWidth().padding(PAD), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                T(hourSaid(h.hour), 14.sp, 700, V.Text2, Modifier.width(56.dp))
                Box(Modifier.weight(1f)) { Bar(if (h.amount > 0) h.amount.toFloat() / most else 0f, 14.dp) }
                T(if (h.sales == 1) "1 sale" else "${h.sales} sales", 13.sp, 600, V.Text2, Modifier.width(80.dp), align = TextAlign.End)
                T(Money.format(h.amount), 15.sp, 700, if (h.amount < 0) V.RedText else V.Text, Modifier.width(120.dp), align = TextAlign.End)
            }
        }
    }
}

@Composable
private fun Transactions(d: ReportData, vm: ReportsViewModel, onReceipt: (String) -> Unit) {
    val rows = remember(d) { Reports.transactions(d.sales) }
    if (rows.isEmpty()) { Blank("No receipt in these days."); return }
    Page {
        item {
            val total = rows.sumOf { if (it.refund) -it.total else it.total }
            Line(counted(rows.count { !it.refund }, "sale", "sales") + ", " + counted(rows.count { it.refund }, "refund", "refunds"), Money.format(total), bold = true, under = "Tap a receipt to open it as it printed.")
        }
        items(rows, key = { it.id }) { t ->
            Line(
                t.number + if (t.refund) " · Refund" else "", signed(t.refund, t.total), stamp(t.at, vm.zone()),
                color = if (t.refund) V.RedText else V.Text, under = listOfNotNull(t.paid.ifEmpty { null }, t.who).joinToString(" · "),
            ) { onReceipt(t.id) }
        }
    }
}

@Composable
private fun Prices(d: ReportData, vm: ReportsViewModel) {
    val rows = remember(d) { Reports.repriced(d.sales) }
    Page {
        item { Heading("Sold at another price than listed") }
        if (rows.isEmpty()) item { Blank("No line was sold at another price in these days.") }
        itemsIndexed(rows) { _, p ->
            Line(p.product, Money.format(p.charged), "was ${Money.format(p.was)}", under = listOfNotNull(p.why, p.who, p.receipt, stamp(p.at, vm.zone())).joinToString(" · "))
        }
        item { Heading("A product's own price changed") }
        if (d.prices.isEmpty()) item { Blank(keptSince(d.logSince, "No product's price was changed on this till in these days.", vm)) }
        items(d.prices) { p ->
            Line(p.product, Money.format(p.now), "was ${Money.format(p.was)}", under = listOfNotNull(p.who, p.approvedBy?.let { "allowed by $it" }, stamp(p.at, vm.zone())).joinToString(" · "))
        }
    }
}

@Composable
private fun Resettlement(d: ReportData, vm: ReportsViewModel, onReceipt: (String) -> Unit) {
    val rows = remember(d) { Reports.refunds(d.sales) }
    Page {
        item { Heading("Refunds") }
        if (rows.isEmpty()) item { Blank("Nothing was refunded in these days.") }
        else item { Line(if (rows.size == 1) "1 refund" else "${rows.size} refunds", Money.format(-rows.sumOf { it.amount }), bold = true, color = V.RedText) }
        items(rows, key = { it.id }) { r ->
            Line(r.number, Money.format(-r.amount), stamp(r.at, vm.zone()), color = V.RedText, under = listOfNotNull(r.of?.let { "Refund of $it" }, r.who).joinToString(" · "))
        }
        item { Heading("Payments corrected after the sale") }
        if (d.corrected.isEmpty()) item { Blank(keptSince(d.logSince, "No payment was corrected on this till in these days.", vm)) }
        items(d.corrected) { c ->
            Line(c.receipt, c.now, "was ${c.was}", under = listOfNotNull(c.who, c.approvedBy?.let { "allowed by $it" }, stamp(c.at, vm.zone())).joinToString(" · ")) { c.receiptId?.let(onReceipt) }
        }
    }
}

@Composable
private fun Shifts(d: ReportData, vm: ReportsViewModel) {
    if (d.days.isEmpty()) { Blank("No day was closed on this till in these days. The day that is open is under More, Reports."); return }
    Page {
        items(d.days, key = { it.close.id }) { s ->
            val diff = if (s.expected != null && s.counted != null) s.counted - s.expected else null
            Line(
                "Day closing No. ${s.close.number}",
                when { diff == null -> ""; diff == 0L -> "Drawer exact"; diff < 0 -> "Short ${Money.format(-diff)}"; else -> "Over ${Money.format(diff)}" },
                color = when { diff == null || diff == 0L -> V.Text2; diff < 0 -> V.RedText; else -> V.AmberText },
                under = listOfNotNull(
                    s.openedAt?.let { "Opened ${stamp(it, vm.zone())}" + (s.openedBy?.let { w -> " by $w" } ?: "") },
                    "Closed ${stamp(s.close.closed_at, vm.zone())}" + (s.closedBy?.let { w -> " by $w" } ?: ""),
                    s.counted?.let { "Counted ${Money.format(it)}" },
                ).joinToString(" · "),
            ) { vm.openDay(s) }
        }
    }
}

@Composable
private fun Tax(d: ReportData) {
    val f = d.figures
    val rows = remember(d) { if (f == null) emptyList() else Reports.tax(f.taxes, f.net) }
    if (f == null || rows.isEmpty()) { Blank(); return }
    Page {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Caps("Rate", modifier = Modifier.weight(1f))
                for (h in listOf("Excluding VAT", "VAT", "Including VAT")) Caps(h, modifier = Modifier.width(140.dp))
            }
        }
        items(rows) { t ->
            Row(Modifier.fillMaxWidth().padding(PAD), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                T(if (t.rateBp == 0) t.name else "${t.name} ${if (t.rateBp % 100 == 0) "${t.rateBp / 100}" else "%.2f".format(Locale.US, t.rateBp / 100.0)}%", 15.sp, 700, V.Text, Modifier.weight(1f))
                for (v in listOf(t.excl, t.vat, t.incl)) T(Money.format(v), 15.sp, 700, V.Text, Modifier.width(140.dp))
            }
        }
        item {
            Row(Modifier.fillMaxWidth().padding(PAD), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                T("Total", 15.sp, 800, V.Text, Modifier.weight(1f))
                for (v in listOf(rows.sumOf { it.excl }, rows.sumOf { it.vat }, rows.sumOf { it.incl })) T(Money.format(v), 16.sp, 800, V.Text, Modifier.width(140.dp))
            }
        }
        item {
            T("The VAT is what the receipts printed. What it was charged on is worked out from it and the rate.", 13.sp, 500, V.Text3, Modifier.padding(horizontal = 18.dp, vertical = 10.dp), lines = 2)
        }
    }
}

// A closed day opened from Shift Record: its closing figures, and its report printed again.
@Composable
internal fun DaySheet(open: OpenDay, vm: ReportsViewModel) {
    val z = open.doc
    Sheet(onDismiss = { vm.closeDay() }, width = 560.dp, gap = 6.dp) {
        SheetHead("Day closing No. ${z.number}", "${z.till} · closed ${stamp(z.to, vm.zone())}" + (z.closedBy?.let { " by $it" } ?: "")) { vm.closeDay() }
        Line("Receipts", z.sales.toString())
        Line("Sales", Money.format(z.gross))
        Line("Refunds", Money.format(-z.refunded), "${z.refunds}")
        Line("Total", Money.format(z.gross - z.refunded), bold = true)
        Line("Of which VAT", Money.format(z.tax))
        Line("Discounts given", Money.format(z.discounts))
        z.payments.forEach { p -> Line(p.name, Money.format(p.amount), "${p.count}") }
        open.row.float?.let { Line("Opening float", Money.format(it)) }
        if (open.row.expected != null && open.row.counted != null) {
            Line("Expected in the drawer", Money.format(open.row.expected))
            Line("Counted", Money.format(open.row.counted), bold = true)
        }
        VBtn("Print it again", Modifier.fillMaxWidth().padding(top = 10.dp), height = 56.dp, icon = VI.Print) { vm.printDay() }
    }
}

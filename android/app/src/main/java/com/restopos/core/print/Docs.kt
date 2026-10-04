package com.restopos.core.print

import kotlinx.serialization.Serializable
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// What gets printed, as plain data, and how each paper is laid out. A
// receipt's data is kept with the receipt (receipts.doc), so a reprint next
// month prints what the guest was given, whatever the menu says by then.

@Serializable
data class DocLine(
    val qty: Int, // thousandths, as everywhere
    val name: String,
    val amount: Long,
    val mods: List<String> = emptyList(),
    val note: String? = null,
    val course: Int? = null,
    val cat: String? = null, // its category, for the day closing; never printed on a receipt
    val seat: Int? = null, // the seat it is for, on the kitchen ticket
)

@Serializable
data class DocAmount(val name: String, val amount: Long, val count: Int = 0)

@Serializable
data class DocTax(val name: String, val rateBp: Int, val amount: Long, val included: Boolean)

@Serializable
data class DocPayment(val name: String, val amount: Long, val tendered: Long? = null, val change: Long = 0, val reference: String? = null)

@Serializable
data class ReceiptDoc(
    val kind: String = "receipt", // receipt | bill | refund
    val number: String = "",
    val time: Long = 0,
    val order: String = "",
    val dining: String? = null,
    val cashier: String? = null,
    val waiter: String? = null,
    val covers: Int? = null,
    val note: String? = null,
    val lines: List<DocLine> = emptyList(),
    val subtotal: Long = 0,
    val discounts: List<DocAmount> = emptyList(),
    val taxes: List<DocTax> = emptyList(),
    val rounding: Long = 0,
    val total: Long = 0,
    val payments: List<DocPayment> = emptyList(),
    val refundOf: String? = null,
    val reason: String? = null,
    val customer: String? = null,
    // Set only on the copy printed for one guest of a bill split evenly: which
    // share this is, of how many. Its payments then hold that guest's alone.
    val share: Int? = null,
    val shares: Int? = null,
)

data class KitchenDoc(
    val title: String, // ORDER | VOID | REPRINT
    val order: String,
    val time: Long,
    val waiter: String?,
    val dining: String?,
    val covers: Int?,
    val note: String?,
    val lines: List<DocLine>,
    val station: String,
)

data class CashSlipDoc(val type: String, val amount: Long, val reason: String?, val time: Long, val user: String?, val till: String)

data class ShiftDoc(
    val till: String,
    val openedBy: String?,
    val openedAt: Long,
    val closedBy: String?,
    val closedAt: Long?,
    val float: Long,
    val payments: List<DocAmount>,
    val cashTaken: Long,
    val cashIn: Long,
    val cashOut: Long,
    val moves: List<CashSlipDoc>,
    val expected: Long,
    val counted: Long?,
    val sales: Int,
    val gross: Long,
    val refunds: Int,
    val refunded: Long,
    val discounts: Long,
    val counts: List<DrawerCountDoc> = emptyList(), // the drawer counted during the shift
)

// The drawer counted during a shift: what was in it and what it should have held.
data class DrawerCountDoc(val time: Long, val user: String?, val counted: Long, val expected: Long, val till: String)

data class ZDoc(
    val number: Int,
    val till: String,
    val from: Long?,
    val to: Long,
    val closedBy: String?,
    val sales: Int,
    val gross: Long,
    val refunds: Int,
    val refunded: Long,
    val discounts: Long,
    val tax: Long,
    val payments: List<DocAmount>,
    val categories: List<DocAmount>,
    val taxes: List<DocTax>,
    val cashIn: Long,
    val cashOut: Long,
    val moves: List<CashSlipDoc>,
    val firstNumber: String?,
    val lastNumber: String?,
)

// Who the restaurant is on paper, and the notes around the receipt.
data class Shop(
    val name: String = "",
    val address: String = "",
    val phone: String = "",
    val brn: String = "",
    val vat: String = "",
    val header: String = "",
    val footer: String = "",
)

// One printer's paper: how many characters fit, how far to feed, whether to cut.
data class Paper(val columns: Int = 48, val feed: Int = 3, val cut: Boolean = true)

// A logo ready for the printer: one bit per dot.
class Raster(val widthBytes: Int, val height: Int, val bits: ByteArray)

object Docs {
    // Amounts on paper: "1,250.00", with as many decimals as the restaurant set.
    fun num(cents: Long, decimals: Int): String {
        val neg = cents < 0
        val v = Math.abs(cents)
        val body = when (decimals) {
            0 -> "%,d".format(Locale.US, (v + 50) / 100)
            1 -> "%,d.%d".format(Locale.US, (v + 5) / 100, ((v + 5) % 100) / 10)
            else -> "%,d.%02d".format(Locale.US, v / 100, v % 100)
        }
        return (if (neg) "-" else "") + body
    }

    // an amount taken off: "-100.00", and plain "0.00" for nothing
    private fun off(cents: Long, decimals: Int): String = num(-cents, decimals).let { if (cents == 0L) it.removePrefix("-") else it }

    fun qty(q: Int): String = if (q % 1000 == 0) "${q / 1000}" else "%.3f".format(Locale.US, q / 1000.0).trimEnd('0')

    private fun stamp(ms: Long): String = SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.US).format(Date(ms))

    private fun EscPos.head(shop: Shop, logo: Raster?) {
        align(EscPos.Align.Center)
        if (logo != null) raster(logo.widthBytes, logo.height, logo.bits)
        if (shop.name.isNotBlank()) { big(true); EscPos.wrap(shop.name, columns / 2).forEach { line(it) }; big(false) }
        listOf(shop.address).filter { it.isNotBlank() }.forEach { a -> EscPos.wrap(a, columns).forEach { line(it) } }
        if (shop.phone.isNotBlank()) line("Tel: ${shop.phone}")
        if (shop.brn.isNotBlank()) line("BRN: ${shop.brn}")
        if (shop.vat.isNotBlank()) line("VAT: ${shop.vat}")
        if (shop.header.isNotBlank()) EscPos.wrap(shop.header, columns).forEach { line(it) }
        align(EscPos.Align.Left)
    }

    private fun EscPos.end(paper: Paper) {
        feed(paper.feed)
        if (paper.cut) cut()
    }

    // A receipt, a bill (before payment) or a refund.
    fun receipt(d: ReceiptDoc, shop: Shop, paper: Paper, decimals: Int, logo: Raster? = null, openDrawer: Boolean = false): ByteArray {
        val p = EscPos(paper.columns)
        val n = { c: Long -> num(c, decimals) }
        if (openDrawer) p.drawer()
        p.head(shop, logo)
        p.rule()
        p.align(EscPos.Align.Center).bold(true)
        p.line(when (d.kind) { "bill" -> "BILL"; "refund" -> "REFUND"; else -> "RECEIPT" })
        p.bold(false).align(EscPos.Align.Left)
        if (d.number.isNotBlank()) p.row("No.", d.number)
        p.row(stamp(d.time), d.order)
        d.dining?.let { p.row("Order type", it) }
        (d.cashier ?: d.waiter)?.let { p.row("Served by", it) }
        if (d.waiter != null && d.cashier != null && d.waiter != d.cashier) p.row("Waiter", d.waiter)
        d.covers?.let { p.row("Guests", it.toString()) }
        d.customer?.takeIf { it.isNotBlank() && it != d.order }?.let { p.row("Customer", it) }
        d.refundOf?.let { p.row("Refund of", it) }
        d.reason?.takeIf { it.isNotBlank() }?.let { p.wrapped("Reason: $it") }
        p.rule()
        d.lines.forEach { l ->
            p.row("${qty(l.qty)} ${l.name}", n(l.amount))
            l.mods.forEach { m -> p.wrapped("+ $m", indent = "  ") }
            l.note?.takeIf { it.isNotBlank() }?.let { p.wrapped("* $it", indent = "  ") }
        }
        p.rule()
        if (d.discounts.isNotEmpty() || d.rounding != 0L) p.row("Subtotal", n(d.subtotal))
        d.discounts.forEach { p.row("Discount: ${it.name}", "-" + n(it.amount)) }
        d.taxes.forEach { t ->
            val rate = if (t.rateBp % 100 == 0) "${t.rateBp / 100}" else "%.2f".format(Locale.US, t.rateBp / 100.0)
            p.row("${t.name} $rate%" + if (t.included) " (incl.)" else "", n(t.amount))
        }
        if (d.rounding != 0L) p.row("Rounding", n(d.rounding))
        p.bold(true).tall(true)
        p.row(if (d.kind == "refund") "REFUNDED" else "TOTAL", "Rs " + n(d.total))
        p.tall(false).bold(false)
        if (d.share != null && d.shares != null) {
            // one guest's copy: the whole bill above, then what this guest paid and the tax in it
            val mine = d.payments.sumOf { it.amount }
            p.rule()
            p.bold(true).row("SHARE ${d.share} OF ${d.shares}", "Rs " + n(mine)).bold(false)
            val tax = d.taxes.sumOf { it.amount }
            if (tax > 0 && d.total > 0) p.row("Tax in this share", n((tax * mine + d.total / 2) / d.total))
        }
        d.payments.forEach { pay ->
            p.row(pay.name, n(pay.amount))
            pay.reference?.takeIf { it.isNotBlank() }?.let { p.line("  Ref: $it") }
            if (pay.tendered != null && pay.change > 0) { p.row("  Given", n(pay.tendered)); p.row("  Change", n(pay.change)) }
        }
        if (d.kind == "bill") { p.rule(); p.center("This is not a receipt") }
        d.note?.takeIf { it.isNotBlank() }?.let { p.rule(); p.wrapped("Remark: $it") }
        if (shop.footer.isNotBlank()) { p.rule(); p.center(shop.footer) }
        p.end(paper)
        return p.bytes()
    }

    // What the kitchen or the bar has to make: big, and with no prices.
    fun kitchen(d: KitchenDoc, paper: Paper): ByteArray {
        val p = EscPos(paper.columns)
        p.align(EscPos.Align.Center).bold(true)
        p.line(if (d.title == "ORDER") d.station.uppercase() else "${d.title} - ${d.station.uppercase()}")
        p.big(true)
        EscPos.wrap(d.order, paper.columns / 2).forEach { p.line(it) }
        p.big(false).bold(false).align(EscPos.Align.Left)
        p.row(stamp(d.time), d.waiter ?: "")
        val extra = listOfNotNull(d.dining, d.covers?.let { "$it guests" }).joinToString(" · ")
        if (extra.isNotBlank()) p.line(extra.replace("·", "-"))
        p.rule('=')
        var course: Int? = null
        // an order that is all course 1 needs no course heading
        val courses = d.lines.any { (it.course ?: 1) > 1 }
        d.lines.forEach { l ->
            if (courses && l.course != null && l.course != course) {
                course = l.course
                p.align(EscPos.Align.Center).line("--- Course ${l.course} ---").align(EscPos.Align.Left)
            }
            p.bold(true).tall(true)
            EscPos.wrap("${qty(l.qty)} x ${l.name}", paper.columns).forEach { p.line(it) }
            p.tall(false).bold(false)
            l.seat?.let { p.line("   Seat $it") }
            l.mods.forEach { m -> p.wrapped("+ $m", indent = "   ") }
            l.note?.takeIf { it.isNotBlank() }?.let { p.bold(true).wrapped("! $it", indent = "   ").bold(false) }
        }
        d.note?.takeIf { it.isNotBlank() }?.let { p.rule(); p.bold(true).wrapped("REMARK: $it").bold(false) }
        p.rule('=')
        p.end(paper)
        return p.bytes()
    }

    // The paper that goes in the drawer when cash is put in or taken out.
    fun cashSlip(d: CashSlipDoc, shop: Shop, paper: Paper, decimals: Int, openDrawer: Boolean = true): ByteArray {
        val p = EscPos(paper.columns)
        if (openDrawer) p.drawer()
        if (shop.name.isNotBlank()) p.center(shop.name)
        p.align(EscPos.Align.Center).bold(true).big(true)
        p.line(if (d.type == "in") "CASH IN" else "CASH OUT")
        p.big(false).bold(false).align(EscPos.Align.Left)
        p.rule()
        p.row("Date", stamp(d.time))
        p.row("Till", d.till)
        p.row("By", d.user ?: "")
        p.wrapped("Reason: ${d.reason?.takeIf { it.isNotBlank() } ?: "-"}")
        p.rule()
        p.bold(true).tall(true).row("AMOUNT", "Rs " + num(d.amount, decimals)).tall(false).bold(false)
        p.feed(2)
        p.line("Signature: " + "_".repeat((paper.columns - 11).coerceAtLeast(4)))
        p.end(paper)
        return p.bytes()
    }

    // The drawer counted during a shift, at a handover: the two people sign it.
    fun drawerCount(d: DrawerCountDoc, shop: Shop, paper: Paper, decimals: Int): ByteArray {
        val p = EscPos(paper.columns)
        val n = { c: Long -> num(c, decimals) }
        if (shop.name.isNotBlank()) p.center(shop.name)
        p.align(EscPos.Align.Center).bold(true).big(true).line("DRAWER COUNT").big(false).bold(false).align(EscPos.Align.Left)
        p.rule()
        p.row("Date", stamp(d.time))
        p.row("Till", d.till)
        p.row("Counted by", d.user ?: "")
        p.rule()
        p.row("Expected in drawer", n(d.expected))
        p.bold(true).tall(true).row("COUNTED", "Rs " + n(d.counted)).tall(false).bold(false)
        val diff = d.counted - d.expected
        p.bold(true).row(if (diff == 0L) "Difference" else if (diff < 0) "SHORT" else "OVER", n(diff)).bold(false)
        p.line("The sales period stays open.")
        p.feed(2)
        p.line("Handed over: " + "_".repeat((paper.columns - 13).coerceAtLeast(4)))
        p.feed(1)
        p.line("Taken over: " + "_".repeat((paper.columns - 12).coerceAtLeast(4)))
        p.end(paper)
        return p.bytes()
    }

    // One cashier's time on the till, from the float to the count.
    fun shift(d: ShiftDoc, shop: Shop, paper: Paper, decimals: Int): ByteArray {
        val p = EscPos(paper.columns)
        val n = { c: Long -> num(c, decimals) }
        if (shop.name.isNotBlank()) p.center(shop.name)
        p.align(EscPos.Align.Center).bold(true).line("SALES PERIOD REPORT").bold(false).align(EscPos.Align.Left)
        p.rule()
        p.row("Till", d.till)
        p.row("Cashier", d.openedBy ?: "")
        p.row("Opened", stamp(d.openedAt))
        p.row("Closed", d.closedAt?.let { stamp(it) } ?: "still open")
        if (d.closedBy != null && d.closedBy != d.openedBy) p.row("Closed by", d.closedBy)
        p.rule()
        p.row("Receipts", d.sales.toString())
        p.row("Sales", n(d.gross))
        p.row("Refunds (${d.refunds})", off(d.refunded, decimals))
        p.row("Discounts given", n(d.discounts))
        p.rule()
        p.bold(true).line("TAKEN BY PAYMENT METHOD").bold(false)
        d.payments.forEach { p.row("${it.name} (${it.count})", n(it.amount)) }
        p.rule()
        p.bold(true).line("CASH DRAWER").bold(false)
        p.row("Opening float", n(d.float))
        p.row("Cash taken", n(d.cashTaken))
        p.row("Cash in", n(d.cashIn))
        p.row("Cash out", off(d.cashOut, decimals))
        d.moves.forEach { m -> p.row("  ${if (m.type == "in") "In" else "Out"}: ${m.reason ?: ""}", n(m.amount)) }
        if (d.counts.isNotEmpty()) {
            p.line("Counted during the sales period:")
            d.counts.forEach { c ->
                val diff = c.counted - c.expected
                p.row("  ${stamp(c.time).substringAfter(' ')} ${c.user ?: ""}".take(paper.columns - 12), n(c.counted))
                p.row("    " + (if (diff == 0L) "as expected" else if (diff < 0) "short" else "over"), if (diff == 0L) "" else n(diff))
            }
        }
        p.bold(true).row("Expected in drawer", n(d.expected)).bold(false)
        if (d.counted != null) {
            p.row("Counted", n(d.counted))
            val diff = d.counted - d.expected
            p.bold(true).row(if (diff == 0L) "Difference" else if (diff < 0) "SHORT" else "OVER", n(diff)).bold(false)
        }
        p.feed(2)
        p.line("Signature: " + "_".repeat((paper.columns - 11).coerceAtLeast(4)))
        p.end(paper)
        return p.bytes()
    }

    // The day closing. With `detailed` off it shows the totals and the cash in
    // and out only, with no breakdown by category or tax.
    fun z(d: ZDoc, shop: Shop, paper: Paper, decimals: Int, detailed: Boolean): ByteArray {
        val p = EscPos(paper.columns)
        val n = { c: Long -> num(c, decimals) }
        p.head(shop, null)
        p.rule()
        p.align(EscPos.Align.Center).bold(true).line("DAY CLOSING (Z) No. ${d.number}").bold(false).align(EscPos.Align.Left)
        p.row("Till", d.till)
        p.row("From", d.from?.let { stamp(it) } ?: "first sale")
        p.row("To", stamp(d.to))
        d.closedBy?.let { p.row("Closed by", it) }
        if (d.firstNumber != null && d.lastNumber != null) { p.row("First bill", d.firstNumber); p.row("Last bill", d.lastNumber) }
        p.rule()
        p.row("Receipts", d.sales.toString())
        p.row("Sales", n(d.gross))
        p.row("Refunds (${d.refunds})", off(d.refunded, decimals))
        p.bold(true).tall(true).row("TOTAL", "Rs " + n(d.gross - d.refunded)).tall(false).bold(false)
        p.row("Of which tax", n(d.tax))
        p.row("Discounts given", n(d.discounts))
        p.rule()
        p.bold(true).line("BY PAYMENT METHOD").bold(false)
        d.payments.forEach { p.row("${it.name} (${it.count})", n(it.amount)) }
        if (detailed) {
            if (d.categories.isNotEmpty()) {
                p.rule()
                p.bold(true).line("BY CATEGORY").bold(false)
                d.categories.forEach { p.row("${it.name} (${it.count})", n(it.amount)) }
            }
            if (d.taxes.isNotEmpty()) {
                p.rule()
                p.bold(true).line("TAX").bold(false)
                d.taxes.forEach { t -> p.row("${t.name} ${t.rateBp / 100}%", n(t.amount)) }
            }
        }
        p.rule()
        p.bold(true).line("CASH IN AND OUT").bold(false)
        p.row("Cash in", n(d.cashIn))
        p.row("Cash out", off(d.cashOut, decimals))
        d.moves.forEach { m -> p.row("  ${if (m.type == "in") "In" else "Out"}: ${m.reason ?: ""}${m.user?.let { " ($it)" } ?: ""}", n(m.amount)) }
        p.end(paper)
        return p.bytes()
    }

    fun test(printer: String, paper: Paper): ByteArray {
        val p = EscPos(paper.columns)
        p.align(EscPos.Align.Center).bold(true).big(true).line("RestoPOS").big(false).bold(false)
        p.line("Test print").line(printer).align(EscPos.Align.Left)
        p.rule()
        p.row("Width", "${paper.columns} characters")
        p.line("0123456789".repeat(5).take(paper.columns))
        p.line("Crevettes sautées à l'ail, café crème")
        p.rule()
        p.center("If you can read this, the printer works.")
        p.end(paper)
        return p.bytes()
    }
}

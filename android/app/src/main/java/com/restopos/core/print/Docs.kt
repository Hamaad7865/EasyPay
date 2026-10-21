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
    // a line charged something other than its listed price: what it would
    // have come to, and the words for why ("10% off", "Price changed")
    val was: Long? = null,
    val priceNote: String? = null,
    // Its add-ons with what each adds to the line, and the price of one item
    // as charged: for a design that shows them (Papers). A receipt kept from
    // before has neither and prints its add-ons by name (mods), as it did.
    val addons: List<DocAddon> = emptyList(),
    val unit: Long? = null,
)

// An add-on on a receipt's line: how many, and what it adds to the line in all
// (ticket_line_modifiers.price: for three eggs at Rs 10, Rs 30).
@Serializable
data class DocAddon(val name: String, val qty: Int = 1, val price: Long = 0)

@Serializable
data class DocAmount(val name: String, val amount: Long, val count: Int = 0)

@Serializable
data class DocTax(val name: String, val rateBp: Int, val amount: Long, val included: Boolean)

@Serializable
data class DocPayment(val name: String, val amount: Long, val tendered: Long? = null, val change: Long = 0, val reference: String? = null)

// The paper a customer keeps after an exchange worth less than what came
// back (server 0109): it is the credit note. validTo: yyyy-mm-dd, or null.
@Serializable
data class CreditNoteDoc(
    val number: String,
    val amount: Long,
    val validTo: String?,
    val customer: String?,
    val fromReceipt: String,
    val time: Long,
    val cashier: String?,
    // what it came from: an exchange's receipt, or a cancelled deposit (0113)
    val fromLabel: String = "From exchange of",
)

// A deposit's slip (server 0113): taken, paid on, or cancelled. title says
// which; the goods held, what they come to, what is paid and left to pay,
// the date to collect by, and what happens if they are not collected. The
// number large and in bars, so it is scanned at a till.
data class DepositDoc(
    val title: String, // DEPOSIT | DEPOSIT PAYMENT | DEPOSIT CANCELLED
    val number: String,
    val customer: String?,
    val phone: String?,
    val lines: List<DocAmount>, // name, amount; count is how many (whole ones)
    val total: Long,
    val paid: Long,
    val toPay: Long,
    val collectBy: String,
    val sentence: String,
    val time: Long,
    val cashier: String?,
    val now: List<DocAmount> = emptyList(), // the money of this visit: "Cash" 500, "Change" 100, "Given back" 300
    val note: String? = null, // a closing line: the credit note it went on, what the shop kept
)

// A customer's account on paper (server 0114): a payment's slip (what was
// paid, which bills it went on, what each still owes) or a short statement
// (every bill that owes, the ages, the balance).
data class AccountDoc(
    val title: String, // ACCOUNT PAYMENT | STATEMENT
    val number: String?, // the payment's number; none on a statement
    val customer: String,
    val phone: String?,
    val time: Long,
    val cashier: String?,
    val bills: List<DocAmount>, // "12 Oct · S1-T1-000123", what it still owes
    val money: List<DocAmount> = emptyList(), // this visit: "Cash" 500, "Change" 100
    val paidOn: List<DocAmount> = emptyList(), // a payment: what went on each bill
    val aged: List<DocAmount> = emptyList(), // a statement: "0–30 days" ...
    val balance: Long,
)

// What a Premium MRA client's paper says of the MRA (its guide 8.1.13, 8.1.14):
// the QR code it sent back, made 2 x 2 cm (core/mra/MraQr), or "Not Yet
// Fiscalised" until it has answered; and whether it went as a training
// invoice. Never kept with the receipt: read again each time it prints, so a
// reprint after a late answer has the QR code.
sealed interface Fiscal {
    val training: Boolean
    class Qr(val r: Raster, override val training: Boolean) : Fiscal
    data class NotYet(override val training: Boolean) : Fiscal
}

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
    val service: Long = 0, // the service charge, when the restaurant adds one
    val refundOf: String? = null,
    val reason: String? = null,
    val customer: String? = null,
    // Set only on the copy printed for one guest of a bill split evenly: which
    // share this is, of how many. Its payments then hold that guest's alone.
    val share: Int? = null,
    val shares: Int? = null,
    // Said on the paper when a receipt is printed again from the list, never
    // kept with the receipt: that this paper is a copy, and how much of the
    // sale has been refunded since (all of it, or part). A copy that looks
    // like the first paper is what someone would bring to be refunded twice.
    val reprint: Boolean = false,
    val refunded: Long = 0,
    val refundedAll: Boolean = false,
    // The customer number ("05") of an order with no table, printed large so
    // the customer can be called (CustomerNumber). Kept with the receipt, so a
    // reprint carries it; a receipt kept from before has none.
    val customerNo: String? = null,
    // A sale on account (0114): what the customer owes on account with it,
    // printed under the payments. None on any other receipt.
    val owed: Long? = null,
    // Loyalty points (0128), printed under the payments: what a sale earned,
    // what a refund took back and gave back, and the customer's balance after
    // it (left out of a reprint: it is not the balance now).
    val pointsEarned: Long? = null,
    val pointsTaken: Long? = null,
    val pointsBack: Long? = null,
    val pointsBalance: Long? = null,
    @kotlinx.serialization.Transient val fiscal: Fiscal? = null,
)

@Serializable
data class KitchenDoc(
    val title: String, // ORDER | VOID | REPRINT
    val order: String,
    val time: Long,
    val waiter: String? = null,
    val dining: String? = null,
    val covers: Int? = null,
    val note: String? = null,
    val lines: List<DocLine>,
    val station: String,
    val pickup: String? = null, // "PICK UP 18:30": when a takeaway is picked up (Pickup.says)
    val customerNo: String? = null, // "05": printed large in place of the order's name, which then says who it is for
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
    // what prices typed for one sale came to against the listed ones (a shop); nothing prints while it is nothing
    val priceChanges: Long = 0,
    // takeaways nobody came for and that were not paid, each with what it came to: lost, and in no figure here
    val noShows: List<DocAmount> = emptyList(),
    // credit notes (0109): what refunds put on them and what sales took off them; in no tender above
    val notesIssued: Long = 0,
    val notesRedeemed: Long = 0,
    // a shop's deposits (0113); nothing prints while there were none
    val deposits: DepositFigures = DepositFigures(),
    // a shop's customer accounts (0114); nothing prints while there were none
    val accounts: AccountFigures = AccountFigures(),
)

// A period's deposits (server 0113): money taken on them by payment method,
// what collections used, given back, put on credit notes, kept by the shop.
// cash: what deposits put in the drawer less what came out of it for them,
// which is in the drawer's expected cash and in no other cash line.
data class DepositFigures(
    val taken: List<DocAmount> = emptyList(),
    val used: Long = 0,
    val back: Long = 0,
    val noted: Long = 0,
    val kept: Long = 0,
    val cash: Long = 0,
) {
    val any: Boolean get() = taken.isNotEmpty() || used != 0L || back != 0L || noted != 0L || kept != 0L || cash != 0L
}

// A period's customer accounts (server 0114): what sales put on accounts,
// what returns took off them, and money taken on accounts by payment method.
// cash: what account payments put in the drawer, which is in the drawer's
// expected cash and in no other cash line. In no tender above: a sale on
// account is a sale the day it is made, money paid on it later is not.
data class AccountFigures(
    val sold: Long = 0,
    val returned: Long = 0,
    val taken: List<DocAmount> = emptyList(),
    val cash: Long = 0,
) {
    val any: Boolean get() = sold != 0L || returned != 0L || taken.isNotEmpty() || cash != 0L
}

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
    // The drawer of the day this closes: when it was opened and with what, what
    // it should hold and what was counted. Absent on a closing made with no
    // day open (a till with no PINs), and on the days closed before a day and
    // its cash count were one thing.
    val openedAt: Long? = null,
    val openedBy: String? = null,
    val float: Long? = null,
    val cashTaken: Long? = null,
    val expected: Long? = null,
    // what prices typed for one sale came to against the listed ones (a shop); nothing prints while it is nothing
    val priceChanges: Long = 0,
    val counted: Long? = null,
    // takeaways nobody came for and that were not paid, each with what it came to: lost, and in no figure here
    val noShows: List<DocAmount> = emptyList(),
    // credit notes (0109): what refunds put on them and what sales took off them; in no tender above
    val notesIssued: Long = 0,
    val notesRedeemed: Long = 0,
    // a shop's deposits (0113); nothing prints while there were none
    val deposits: DepositFigures = DepositFigures(),
    // a shop's customer accounts (0114); nothing prints while there were none
    val accounts: AccountFigures = AccountFigures(),
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
    // A shop's receipts carry their number in bars under the footer, for the
    // till's scanner. A restaurant's till takes no scans of receipts, so its
    // paper stays as short as it was.
    val bars: Boolean = false,
)

// One printer's paper: how many characters fit, how far to feed, whether to
// cut, and whether the tablet is setting up, when every paper says it is not
// a receipt (Docs.TRIAL_MARK; core/data/GoLive). `inWide`: a 57 mm roll in a
// printer made for 80 mm rolls (EscPos).
data class Paper(val columns: Int = 48, val feed: Int = 3, val cut: Boolean = true, val trial: Boolean = false, val inWide: Boolean = false) {
    companion object {
        // a printer's paper_mm: 80, 58, or 57 (EscPos.IN_WIDE)
        fun of(paperMm: Int, feed: Int = 3, cut: Boolean = true, trial: Boolean = false) =
            Paper(EscPos.columnsFor(paperMm), feed, cut, trial, EscPos.inWide(paperMm))
    }
}

// A logo ready for the printer: one bit per dot.
class Raster(val widthBytes: Int, val height: Int, val bits: ByteArray)

// One of the till's reports, printed as narrow columns: what it is, the days it
// is of, the till, then its lines. A line is a left and a right, a heading, a
// rule across the paper, or a total (a row in bold).
data class ReportLine(val left: String, val right: String = "", val kind: Kind = Kind.Row) {
    enum class Kind { Row, Head, Rule, Total }
}
data class ReportDoc(val title: String, val period: String, val till: String, val printedAt: Long, val lines: List<ReportLine>)

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

    internal fun stamp(ms: Long): String = SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.US).format(Date(ms))

    // "2027-04-14" as "14 April 2027"; a date that is not one is printed as it came
    private fun stampDate(ymd: String): String =
        runCatching { java.time.LocalDate.parse(ymd).format(java.time.format.DateTimeFormatter.ofPattern("d MMMM yyyy", Locale.UK)) }.getOrDefault(ymd)

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

    // what a paper printed while the tablet is setting up says it is not
    const val TRIAL_MARK = "TEST, NOT A RECEIPT"

    // A page. On a tablet that is setting up it starts with the mark, and end() puts it at its foot too.
    private fun page(paper: Paper): EscPos = EscPos(paper.columns, paper.inWide).also { if (paper.trial) it.trialMark() }
    private fun EscPos.trialMark() { align(EscPos.Align.Center).bold(true).line(TRIAL_MARK).bold(false).align(EscPos.Align.Left) }

    private fun EscPos.end(paper: Paper) {
        if (paper.trial) { line(); trialMark() }
        feed(paper.feed)
        if (paper.cut) cut()
    }

    // A receipt, a bill (before payment) or a refund, laid out by the
    // business's design (Papers), EasyPay's when it has none.
    fun receipt(d: ReceiptDoc, shop: Shop, paper: Paper, decimals: Int, logo: Raster? = null, openDrawer: Boolean = false, design: Design = Papers.RECEIPT): ByteArray =
        receiptPage(d, shop, paper, decimals, logo, openDrawer, design).bytes()

    // The same paper as lines of text, to show on the till's screen.
    fun receiptLook(d: ReceiptDoc, shop: Shop, paper: Paper, decimals: Int, design: Design = Papers.RECEIPT): List<String> =
        receiptPage(d, shop, paper, decimals, null, false, design).look()

    // The design's blocks, top to bottom, those hidden left out.
    internal fun receiptPage(d: ReceiptDoc, shop: Shop, paper: Paper, decimals: Int, logo: Raster? = null, openDrawer: Boolean = false, design: Design = Papers.RECEIPT): EscPos {
        val p = page(paper)
        if (openDrawer) p.drawer()
        design.blocks.filter { !it.hide }.forEach { b -> PaperWalk.print(p, b, PaperWalk.receipt(b, d, shop, decimals, logo)) }
        p.end(paper)
        return p
    }

    // The credit note itself: the number large and in bars, so it is scanned
    // at a till when it is spent.
    fun creditNote(d: CreditNoteDoc, shop: Shop, paper: Paper, decimals: Int, logo: Raster? = null): ByteArray {
        val p = page(paper)
        p.head(shop, logo)
        p.rule()
        p.align(EscPos.Align.Center).bold(true).big(true).line("CREDIT NOTE").big(false)
        p.tall(true).line(d.number).tall(false).bold(false).align(EscPos.Align.Left)
        p.rule()
        p.bold(true).tall(true).row("VALUE", "Rs " + num(d.amount, decimals)).tall(false).bold(false)
        p.row("Valid to", d.validTo?.let { stampDate(it) } ?: "Does not expire")
        d.customer?.takeIf { it.isNotBlank() }?.let { p.row("Customer", it) }
        p.row(d.fromLabel, d.fromReceipt)
        p.row(stamp(d.time), d.cashier ?: "")
        p.rule()
        p.wrapped("Spend it on any purchase at this shop, in one go or in parts. Keep this slip: it is the note.")
        p.line()
        p.barcode(d.number)
        p.end(paper)
        return p.bytes()
    }

    fun deposit(d: DepositDoc, shop: Shop, paper: Paper, decimals: Int, logo: Raster? = null, openDrawer: Boolean = false): ByteArray {
        val p = page(paper)
        if (openDrawer) p.drawer()
        p.head(shop, logo)
        p.rule()
        p.align(EscPos.Align.Center).bold(true).big(true).line(d.title).big(false)
        p.tall(true).line(d.number).tall(false).bold(false).align(EscPos.Align.Left)
        p.rule()
        d.customer?.takeIf { it.isNotBlank() }?.let { p.row("Customer", it) }
        d.phone?.takeIf { it.isNotBlank() }?.let { p.row("Phone", it) }
        p.row(stamp(d.time), d.cashier ?: "")
        p.rule()
        d.lines.forEach { l -> p.row((if (l.count > 1) "${l.count} x " else "") + l.name, num(l.amount, decimals)) }
        p.rule()
        p.row("Total", num(d.total, decimals))
        p.row("Paid", num(d.paid, decimals))
        // a deposit that is over owes nothing and is collected by no date: it says how it ended
        val over = d.title.contains("CANCELLED")
        if (!over) p.bold(true).tall(true).row("TO PAY", "Rs " + num(d.toPay, decimals)).tall(false).bold(false)
        d.now.forEach { p.row(it.name, num(it.amount, decimals)) }
        p.rule()
        if (!over) p.bold(true).row("Collect by", stampDate(d.collectBy)).bold(false)
        d.note?.let { p.wrapped(it) }
        if (!over) {
            p.wrapped(d.sentence)
            p.wrapped("Keep this slip: show it when you pay or collect.")
        }
        p.line()
        p.barcode(d.number)
        p.end(paper)
        return p.bytes()
    }

    fun account(d: AccountDoc, shop: Shop, paper: Paper, decimals: Int, logo: Raster? = null, openDrawer: Boolean = false): ByteArray {
        val p = page(paper)
        if (openDrawer) p.drawer()
        p.head(shop, logo)
        p.rule()
        p.align(EscPos.Align.Center).bold(true).big(true).line(d.title).big(false)
        d.number?.let { p.tall(true).line(it).tall(false) }
        p.bold(false).align(EscPos.Align.Left)
        p.rule()
        p.row("Customer", d.customer)
        d.phone?.takeIf { it.isNotBlank() }?.let { p.row("Phone", it) }
        p.row(stamp(d.time), d.cashier ?: "")
        p.rule()
        if (d.paidOn.isNotEmpty()) {
            p.bold(true).line("Paid on").bold(false)
            d.paidOn.forEach { p.row(it.name, num(it.amount, decimals)) }
            d.money.forEach { p.row(it.name, num(it.amount, decimals)) }
            p.rule()
        }
        p.bold(true).line(if (d.bills.isEmpty()) "Nothing is owed" else "Still owed").bold(false)
        d.bills.forEach { p.row(it.name, num(it.amount, decimals)) }
        if (d.aged.any { it.amount != 0L }) {
            p.rule()
            d.aged.forEach { p.row(it.name, num(it.amount, decimals)) }
        }
        p.rule()
        p.bold(true).tall(true).row("BALANCE", "Rs " + num(d.balance, decimals)).tall(false).bold(false)
        p.line()
        p.end(paper)
        return p.bytes()
    }

    // What the kitchen or the bar has to make: big, and with no prices.
    fun kitchen(d: KitchenDoc, paper: Paper, design: Design = Papers.KITCHEN): ByteArray = kitchenPage(d, paper, design).bytes()

    internal fun kitchenPage(d: KitchenDoc, paper: Paper, design: Design = Papers.KITCHEN): EscPos {
        val p = page(paper)
        // A void or a reprint says so whatever the design: the Station block is
        // where it is said, and with it hidden "1 x Burger" voided read as a new
        // order, and was made. A design without the block at all has it first.
        val says = d.title != "ORDER"
        if (says && design.blocks.none { it.k == "station" }) Papers.KITCHEN_KINDS["station"]?.let { b -> PaperWalk.print(p, b, PaperWalk.kitchen(b, d)) }
        design.blocks.filter { !it.hide || (says && it.k == "station") }.forEach { b -> PaperWalk.print(p, b, PaperWalk.kitchen(b, d)) }
        p.end(paper)
        return p
    }

    // The paper that goes in the drawer when cash is put in or taken out.
    fun cashSlip(d: CashSlipDoc, shop: Shop, paper: Paper, decimals: Int, openDrawer: Boolean = true): ByteArray {
        val p = page(paper)
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
        val p = page(paper)
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
        p.line("The day stays open.")
        p.feed(2)
        p.line("Handed over: " + "_".repeat((paper.columns - 13).coerceAtLeast(4)))
        p.feed(1)
        p.line("Taken over: " + "_".repeat((paper.columns - 12).coerceAtLeast(4)))
        p.end(paper)
        return p.bytes()
    }

    // The day on this till from its drawer's side, from the float to the count:
    // the X report while the day is open, the drawer's report once it is closed.
    fun shift(d: ShiftDoc, shop: Shop, paper: Paper, decimals: Int): ByteArray {
        val p = page(paper)
        val n = { c: Long -> num(c, decimals) }
        if (shop.name.isNotBlank()) p.center(shop.name)
        p.align(EscPos.Align.Center).bold(true).line(if (d.closedAt == null) "X REPORT - DAY SO FAR" else "CASH DRAWER REPORT").bold(false).align(EscPos.Align.Left)
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
        if (d.priceChanges != 0L) p.row("Price changes", off(d.priceChanges, decimals))
        if (d.noShows.isNotEmpty()) p.row("No-shows, unpaid (${d.noShows.size})", n(d.noShows.sumOf { it.amount }))
        p.rule()
        p.bold(true).line("TAKEN BY PAYMENT METHOD").bold(false)
        d.payments.forEach { p.row("${it.name} (${it.count})", n(it.amount)) }
        if (d.notesIssued != 0L || d.notesRedeemed != 0L) { p.row("Credit notes issued", n(d.notesIssued)); p.row("Credit notes redeemed", n(d.notesRedeemed)) }
        depositRows(p, d.deposits, n)
        accountRows(p, d.accounts, n)
        p.rule()
        p.bold(true).line("CASH DRAWER").bold(false)
        p.row("Opening float", n(d.float))
        p.row("Cash taken", n(d.cashTaken))
        p.row("Cash in", n(d.cashIn))
        p.row("Cash out", off(d.cashOut, decimals))
        d.moves.forEach { m -> p.row("  ${if (m.type == "in") "In" else "Out"}: ${m.reason ?: ""}", n(m.amount)) }
        if (d.deposits.cash != 0L) p.row("Deposit cash", n(d.deposits.cash))
        if (d.accounts.cash != 0L) p.row("Account payments cash", n(d.accounts.cash))
        if (d.counts.isNotEmpty()) {
            p.line("Counted during the day:")
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
        val p = page(paper)
        val n = { c: Long -> num(c, decimals) }
        p.head(shop, null)
        p.rule()
        p.align(EscPos.Align.Center).bold(true).line("DAY CLOSING (Z) No. ${d.number}").bold(false).align(EscPos.Align.Left)
        p.row("Till", d.till)
        if (d.openedAt != null) {
            p.row("Opened", stamp(d.openedAt))
            d.openedBy?.let { p.row("Opened by", it) }
        }
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
        if (d.priceChanges != 0L) p.row("Price changes", off(d.priceChanges, decimals))
        // Takeaways nobody came for and that were not paid: what was lost. It
        // is in no figure above or below; the detailed closing names each.
        if (d.noShows.isNotEmpty()) {
            p.row("No-shows, unpaid (${d.noShows.size})", n(d.noShows.sumOf { it.amount }))
            if (detailed) d.noShows.forEach { p.row("  ${it.name}", n(it.amount)) }
        }
        p.rule()
        p.bold(true).line("BY PAYMENT METHOD").bold(false)
        d.payments.forEach { p.row("${it.name} (${it.count})", n(it.amount)) }
        if (d.notesIssued != 0L || d.notesRedeemed != 0L) { p.row("Credit notes issued", n(d.notesIssued)); p.row("Credit notes redeemed", n(d.notesRedeemed)) }
        depositRows(p, d.deposits, n)
        accountRows(p, d.accounts, n)
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
        // the drawer, counted to close the day
        if (d.expected != null && d.counted != null) {
            p.rule()
            p.bold(true).line("CASH DRAWER").bold(false)
            d.float?.let { p.row("Opening float", n(it)) }
            d.cashTaken?.let { p.row("Cash taken", n(it)) }
            if (d.deposits.cash != 0L) p.row("Deposit cash", n(d.deposits.cash))
            if (d.accounts.cash != 0L) p.row("Account payments cash", n(d.accounts.cash))
            p.row("Expected in drawer", n(d.expected))
            p.bold(true).row("COUNTED", "Rs " + n(d.counted)).bold(false)
            val diff = d.counted - d.expected
            p.bold(true).row(if (diff == 0L) "Difference" else if (diff < 0) "SHORT" else "OVER", n(diff)).bold(false)
            p.feed(2)
            p.line("Signature: " + "_".repeat((paper.columns - 11).coerceAtLeast(4)))
        }
        p.end(paper)
        return p.bytes()
    }

    // A period's deposits, under the payment methods: money in by method, and
    // where deposit money went. Nothing when there were none.
    private fun depositRows(p: EscPos, f: DepositFigures, n: (Long) -> String) {
        if (!f.any) return
        p.rule()
        p.bold(true).line("DEPOSITS").bold(false)
        f.taken.forEach { p.row("Taken, ${it.name} (${it.count})", n(it.amount)) }
        if (f.used != 0L) p.row("Used on collection", n(f.used))
        if (f.back != 0L) p.row("Given back", n(-f.back))
        if (f.noted != 0L) p.row("Put on credit notes", n(f.noted))
        if (f.kept != 0L) p.row("Kept by the shop", n(f.kept))
    }

    // A period's customer accounts, under the deposits. Nothing when there were none.
    private fun accountRows(p: EscPos, f: AccountFigures, n: (Long) -> String) {
        if (!f.any) return
        p.rule()
        p.bold(true).line("CUSTOMER ACCOUNTS").bold(false)
        if (f.sold != 0L) p.row("Sold on account", n(f.sold))
        if (f.returned != 0L) p.row("Returned off accounts", n(-f.returned))
        f.taken.forEach { p.row("Paid on accounts, ${it.name} (${it.count})", n(it.amount)) }
    }

    // A report of the till's (feature/reports), on the receipt printer.
    fun report(d: ReportDoc, shop: Shop, paper: Paper): ByteArray = reportPage(d, shop, paper).bytes()

    // The same report as lines of text: what a test reads.
    fun reportLook(d: ReportDoc, shop: Shop, paper: Paper): List<String> = reportPage(d, shop, paper).look()

    private fun reportPage(d: ReportDoc, shop: Shop, paper: Paper): EscPos {
        val p = page(paper)
        p.head(shop, null)
        p.rule()
        p.align(EscPos.Align.Center).bold(true).line(d.title.uppercase(Locale.US)).bold(false).align(EscPos.Align.Left)
        p.row("Period", d.period)
        p.row("Till", d.till)
        p.row("Printed", stamp(d.printedAt))
        p.rule()
        d.lines.forEach { l ->
            when (l.kind) {
                ReportLine.Kind.Row -> p.row(l.left, l.right)
                ReportLine.Kind.Head -> p.bold(true).line(l.left.uppercase(Locale.US)).bold(false)
                ReportLine.Kind.Rule -> p.rule()
                ReportLine.Kind.Total -> p.bold(true).row(l.left, l.right).bold(false)
            }
        }
        p.end(paper)
        return p
    }

    fun test(printer: String, paper: Paper): ByteArray {
        val p = page(paper)
        p.align(EscPos.Align.Center).bold(true).big(true).line("EasyPay").big(false).bold(false)
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

    // A customer's loyalty card (0128), on the receipt printer: the business,
    // the customer, the card's number in bars (Code 128, as a receipt's own)
    // and in words. Cut out and kept, or any card bought with a barcode.
    fun card(business: String, customer: String, card: String, paper: Paper): ByteArray {
        val p = page(paper)
        p.align(EscPos.Align.Center).bold(true).big(true).line(business.take(paper.columns)).big(false).bold(false)
        p.line("Loyalty card")
        p.rule()
        p.bold(true).line(customer.take(paper.columns)).bold(false)
        p.feed(1)
        p.barcode(card)
        p.line(card)
        p.feed(1)
        p.center("Show this card at the till to earn and use points.")
        p.align(EscPos.Align.Left)
        p.end(paper)
        return p.bytes()
    }
}

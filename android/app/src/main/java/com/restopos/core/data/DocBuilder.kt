package com.restopos.core.data

import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.DocAddon
import com.restopos.core.print.DocAmount
import com.restopos.core.print.DocLine
import com.restopos.core.print.DocPayment
import com.restopos.core.print.DocTax
import com.restopos.core.print.Docs
import com.restopos.core.print.KitchenDoc
import com.restopos.core.print.Paper
import com.restopos.core.print.Papers
import com.restopos.core.print.PrintError
import com.restopos.core.print.Printing
import com.restopos.core.print.ReceiptDoc
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject
import javax.inject.Singleton

// What went to the kitchen: every line asked for (they are on the kitchen
// display whatever the printers did), and what a printer said if its paper
// did not come out. Before the display existed this was only the lines that
// printed everywhere they should
// (or have nowhere to print), and what went wrong with the rest.
// nowhere: the names of the lines that no printer took (Routing.nowhere)
data class KitchenOutcome(val printed: List<String>, val errors: List<String>, val nowhere: List<String> = emptyList())

// Turns an order into the papers it prints: the receipt, the bill, and the
// kitchen and bar tickets, each sent to the printer it belongs on.
@Singleton
class DocBuilder @Inject constructor(
    private val db: TillDatabase,
    private val staff: StaffSession,
    private val printing: Printing,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = false }

    fun encode(doc: ReceiptDoc): String = json.encodeToString(ReceiptDoc.serializer(), doc)
    fun decode(text: String?): ReceiptDoc? = text?.let { runCatching { json.decodeFromString(ReceiptDoc.serializer(), it) }.getOrNull() }

    // The table; else the order's number and who it is for; else a direct sale.
    suspend fun orderName(t: TicketEntity): String {
        t.table_id?.let { db.tables().table(it)?.name }?.let { return tableLabel(it) }
        val who = t.name ?: t.customer_id?.let { db.customers().customer(it)?.name }
        return listOfNotNull(t.order_no, who).joinToString(" · ").ifEmpty { "Direct sale" }
    }

    // The customer number the papers print large ("05"): a restaurant's order
    // with no table (CustomerNumber.onPaper).
    private suspend fun customerNo(t: TicketEntity): String? = CustomerNumber.onPaper(t.order_no, t.table_id, printing.settings().retail)
    // what the kitchen and the receipt are told besides the items: the remark,
    // and for a takeaway or delivery who to ring and where it goes
    private fun remark(t: TicketEntity): String? = kitchenRemark(t)

    private suspend fun employee(id: String?): String? = id?.let { db.staff().employee(it)?.name }
    private suspend fun dining(t: TicketEntity): String? = t.dining_option_id?.let { db.ops().dining(it)?.name }

    suspend fun lines(rows: List<TicketLineEntity>): List<DocLine> = rows.map { l ->
        DocLine(
            l.qty, l.name_snapshot, Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(l.id),
            db.tickets().modNames(l.id), l.note, l.course,
            l.item_id?.let { db.ops().categoryOfItem(it)?.name }, l.seat,
            was = l.list_price?.let { Calc.lineAmount(it, l.qty) + db.tickets().modSum(l.id) }, priceNote = l.price_label,
            // for a design that shows each add-on's price and the price of one (Papers)
            addons = db.tickets().lineMods(l.id).map { DocAddon(it.name_snapshot, it.qty, it.price) }, unit = l.unit_price,
        )
    }

    // The tax in a set of lines, tax by tax, after each line's share of the
    // discount: the same sum Calc.totals makes, kept apart by tax.
    suspend fun taxes(rows: List<TicketLineEntity>, discount: Long): List<DocTax> {
        val names = db.ops().allTaxes().associateBy { it.id }
        val bases = rows.map { Calc.lineAmount(it.unit_price, it.qty) + db.tickets().modSum(it.id) }
        val sub = bases.sum()
        val out = LinkedHashMap<String, DocTax>()
        rows.forEachIndexed { i, l ->
            val net = bases[i] - (if (sub > 0) discount * bases[i] / sub else 0)
            db.catalog().lineTaxes(l.id).forEach { t ->
                val amount = if (t.type == "added") (net * t.rate_bp + 5000) / 10000
                else (net * t.rate_bp + (10000L + t.rate_bp) / 2) / (10000L + t.rate_bp)
                val cur = out[t.tax_id]
                out[t.tax_id] = DocTax(names[t.tax_id]?.name ?: "Tax", t.rate_bp, (cur?.amount ?: 0) + amount, t.type != "added")
            }
        }
        return out.values.toList()
    }

    suspend fun receipt(
        kind: String,
        t: TicketEntity,
        rows: List<TicketLineEntity>,
        totals: Calc.Totals,
        discounts: List<DocAmount>,
        payments: List<DocPayment>,
        number: String,
        time: Long,
    ): ReceiptDoc = ReceiptDoc(
        kind = kind, number = number, time = time, order = orderName(t), dining = dining(t),
        customer = t.customer_id?.let { db.customers().customer(it)?.name },
        cashier = staff.current.value?.employee?.name, waiter = employee(t.opened_by), covers = t.covers, note = remark(t),
        lines = lines(rows), subtotal = totals.subtotal, discounts = discounts, taxes = taxes(rows, totals.discount),
        rounding = totals.rounding, total = totals.total, payments = payments, service = totals.service,
        customerNo = if (kind == "refund") null else customerNo(t),
    )

    // The bill: what is still to pay on the order, as the receipt will show it.
    suspend fun bill(t: TicketEntity, rows: List<TicketLineEntity>, discount: DiscountPick?, servicePct: Int = 0): ReceiptDoc {
        val calc = rows.map { l ->
            Calc.Line(Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(l.id), db.catalog().lineTaxes(l.id).map { Calc.TaxRate(it.rate_bp, it.type) })
        }
        val totals = Calc.totalsRounded(calc, listOfNotNull(discount?.let { Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value) }), servicePct)
        val discounts = if (discount != null && totals.discount > 0) listOf(DocAmount(discount.name, totals.discount)) else emptyList()
        return receipt("bill", t, rows, totals, discounts, emptyList(), "", System.currentTimeMillis())
    }

    // The paper as lines of text, for the till's screen: as wide as the
    // receipt printer's paper, or the usual 80 mm when there is no printer.
    suspend fun look(doc: ReceiptDoc): List<String> {
        val paper = printing.receiptPrinter()?.let { printing.paper(it) } ?: Paper()
        val shop = printing.shop()
        return Docs.receiptLook(doc, shop, paper, printing.settings().decimals, Papers.receipt(printing.settings().papers, shop.bars))
    }

    // Receipts, bills and refunds come out of the cashier's printer.
    suspend fun print(doc: ReceiptDoc, openDrawer: Boolean = false): Result<Unit> = runCatching {
        val p = printing.receiptPrinter() ?: throw PrintError(if (Journey.alone) "No receipt printer is set up. Add one in Settings, under This till, Set-up, Printer." else "No receipt printer is set up. Add one in the back office, under Printers.")
        val s = printing.settings()
        val what = when (doc.kind) { "bill" -> "Bill, ${doc.order}"; "refund" -> "Refund ${doc.number}"; else -> "Receipt ${doc.number}" + (doc.share?.let { ", share $it" } ?: "") }
        val shop = printing.shop()
        // laid out by the business's design from the back office, EasyPay's when it has none
        val design = Papers.receipt(s.papers, shop.bars)
        val bytes = Docs.receipt(doc, shop, printing.paper(p), s.decimals, printing.logo(s, p), openDrawer, design)
        // sent again later from the print jobs, it must not open the drawer
        val again = if (openDrawer) Docs.receipt(doc, shop, printing.paper(p), s.decimals, printing.logo(s, p), false, design) else bytes
        printing.send(p, bytes, what, again).getOrThrow()
    }

    // A credit note comes out of the cashier's printer too, after the receipt.
    suspend fun printNote(d: com.restopos.core.print.CreditNoteDoc): Result<Unit> = runCatching {
        val p = printing.receiptPrinter() ?: throw PrintError(if (Journey.alone) "No receipt printer is set up. Add one in Settings, under This till, Set-up, Printer." else "No receipt printer is set up. Add one in the back office, under Printers.")
        val s = printing.settings()
        val bytes = Docs.creditNote(d, printing.shop(), printing.paper(p), s.decimals, printing.logo(s, p))
        printing.send(p, bytes, "Credit note ${d.number}", bytes).getOrThrow()
    }

    // A deposit's slip (0113), out of the cashier's printer; the drawer opens
    // when cash moved with it.
    suspend fun printDeposit(d: com.restopos.core.print.DepositDoc, openDrawer: Boolean): Result<Unit> = runCatching {
        val p = printing.receiptPrinter() ?: throw PrintError(if (Journey.alone) "No receipt printer is set up. Add one in Settings, under This till, Set-up, Printer." else "No receipt printer is set up. Add one in the back office, under Printers.")
        val s = printing.settings()
        val bytes = Docs.deposit(d, printing.shop(), printing.paper(p), s.decimals, printing.logo(s, p), openDrawer)
        val again = if (openDrawer) Docs.deposit(d, printing.shop(), printing.paper(p), s.decimals, printing.logo(s, p), false) else bytes
        printing.send(p, bytes, "Deposit ${d.number}", again).getOrThrow()
    }

    // Each line goes where Routing says: to the printers ticked on its
    // category, one ticket per printer, or, in a restaurant with one printer
    // for everything, to the receipt printer. A line with no printer has
    // nowhere to go and counts as sent.
    suspend fun kitchen(t: TicketEntity, rows: List<TicketLineEntity>, title: String): KitchenOutcome {
        val printers = printing.printers()
        val one = printing.settings().onePrinter
        val byId = printers.associateBy { it.id }
        val routed = rows.map { l -> l to l.item_id?.let { db.ops().categoryOfItem(it) }?.let { Routing.ids(it.printer_ids) } }
        val perPrinter = Routing.tickets(routed, printers, one)
        val errors = ArrayList<String>()
        val order = orderName(t)
        val waiter = employee(t.opened_by) ?: staff.current.value?.employee?.name
        // for the kitchen a line's add-ons are a line for each add-on group
        val mods = kitchenModsOf(db, rows.map { it.id })
        val pickup = Pickup.says(t.dining_option_id?.let { db.ops().dining(it) }?.kind, t.due_at)
        // An order with a customer number is headed by it, then who it is for;
        // a table's by the table, as before.
        val no = customerNo(t)
        val design = Papers.kitchen(printing.settings().papers)
        val heading = if (no != null) (t.name ?: t.customer_id?.let { db.customers().customer(it)?.name }).orEmpty() else order
        for ((pid, ls) in perPrinter) {
            val p = byId[pid] ?: continue
            val asked = lines(ls).mapIndexed { i, d -> d.copy(mods = mods[ls[i].id].orEmpty()) }
            val doc = KitchenDoc(title, heading, System.currentTimeMillis(), waiter, dining(t), t.covers, remark(t), asked, Routing.heading(p, printers, one), pickup, no)
            // a ticket that did not print can be sent again from Settings, Printers
            printing.send(p, Docs.kitchen(doc, printing.paper(p), design), "Kitchen ticket, $order").onFailure { errors.add(it.message ?: "${p.name} did not print") }
        }
        return KitchenOutcome(rows.map { it.id }, errors, Routing.nowhere(routed, printers, one).map { it.name_snapshot })
    }

    fun money(cents: Long) = Money.format(cents)
}

package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.database.ReceiptLineEntity
import com.restopos.core.database.ReceiptPaymentEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.DocPayment
import com.restopos.core.print.Docs
import com.restopos.core.print.PrintError
import com.restopos.core.print.Printing
import com.restopos.core.print.ReceiptDoc
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

// What Save did: how many lines went to the kitchen, and what a printer said
// if it could not print. `nowhere` says which lines no printer took, for a
// restaurant with no kitchen display to have them on; `onDisplay` is whether
// it has one (the display is the premium tier's).
data class SaveResult(val sent: Int, val errors: List<String>, val nowhere: String? = null, val onDisplay: Boolean = true) {
    // What the till says when a send did not go wholly as it should; null
    // when it did. `where` is how the order is named; `again` adds where the
    // paper can be printed again.
    fun trouble(where: String = "The order", again: Boolean = true): String? {
        if (errors.isEmpty() && nowhere == null) return null
        val failed = errors.isNotEmpty()
        return listOfNotNull(
            errors.firstOrNull(),
            if (failed && onDisplay) "$where is on the kitchen display." else null,
            if (failed && again) "Print it again from More once the printer answers." else null,
            nowhere,
        ).joinToString(" ")
    }
}

// A line of a receipt, for the refund sheet: how many it sold and how many of
// them have been given back already. Quantities in thousandths.
data class RefundLine(val id: String, val name: String, val qty: Int, val done: Int) {
    val left: Int get() = qty - done
    // sold by weight or volume: it comes back whole or not at all
    val whole: Boolean get() = qty % 1000 == 0 && done % 1000 == 0
}

// What a waiter and a cashier do to an order besides adding items and taking
// payment: send it to the kitchen, print the bill, take an item off, hand the
// order to another waiter, refund a receipt, correct how a bill was paid.
// Like every write on the till: the row and its outbox op in one transaction.
@Singleton
class OrderOps @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val tickets: TicketRepository,
    private val docs: DocBuilder,
    private val printing: Printing,
    private val kitchen: Kitchen,
    private val service: ServiceRepository,
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    // Send: what the kitchen has not had yet goes onto the kitchen display as
    // one ticket and is printed where its category prints, then marked as
    // sent. Sending again sends only what was added since. A printer that
    // does not answer does not hold the order back: it is on the display, the
    // till says which printer failed, and the paper can be printed again.
    suspend fun save(): Result<SaveResult> = runCatching {
        val t = tickets.activeTicket() ?: return@runCatching SaveResult(0, emptyList())
        // a shop has no kitchen: nothing is ever sent to one
        val settings = PosSettings.parse(db.ops().settings())
        if (settings.retail) return@runCatching SaveResult(0, emptyList())
        val display = settings.premium
        // an order type set to never go to the kitchen is only put away
        val mode = (t.dining_option_id?.let { db.ops().dining(it) } ?: db.catalog().diningOptions().firstOrNull { it.is_default })?.kitchen ?: "save"
        if (mode == "off") return@runCatching SaveResult(0, emptyList(), onDisplay = display)
        val fresh = db.tickets().lines(t.id).first().filter { it.sent_to_kitchen_at == null && !it.paid }
        if (fresh.isEmpty()) return@runCatching SaveResult(0, emptyList(), onDisplay = display)
        val out = docs.kitchen(t, fresh, "ORDER")
        markSent(t.id, out.printed)
        SaveResult(out.printed.size, out.errors, unseen(out, settings), display)
    }

    // A line no printer took is still on the kitchen display, for a
    // restaurant that has one. The display is the premium tier's: without it
    // that line reached nobody, and the till says which.
    private fun unseen(out: KitchenOutcome, settings: PosSettings): String? =
        if (settings.premium) null else Routing.nowhereText(out.nowhere)

    private suspend fun markSent(ticketId: String, ids: List<String>) {
        if (ids.isEmpty()) return
        val now = Instant.now().toString()
        // the same lines as one ticket on the kitchen display
        val onScreen = kitchen.prepare(ticketId)
        db.withTransaction {
            db.tickets().markSent(ids, now)
            kitchen.put(onScreen, ids)
            db.outbox().enqueue(op("ticket.send", buildJsonObject {
                put("ticket_id", ticketId); put("sent_at", now)
                put("line_ids", buildJsonArray { ids.forEach { add(it) } })
            }))
        }
        kitchen.afterSend(ticketId)
        pushNow(context)
    }

    // An order type that goes to the kitchen when it is paid (take away): the
    // lines of this payment that the kitchen has not had yet.
    suspend fun sendOnPay(ticketId: String, lineIds: List<String>) {
        val t = db.tickets().ticket(ticketId) ?: return
        // a shop has no kitchen: a sale that is paid is finished
        val settings = PosSettings.parse(db.ops().settings())
        if (settings.retail) return
        val mode = (t.dining_option_id?.let { db.ops().dining(it) } ?: db.catalog().diningOptions().firstOrNull { it.is_default })?.kitchen ?: "save"
        if (mode == "off") return
        // "save" too: a bill paid without ever pressing Save must still reach the kitchen
        val fresh = db.tickets().allLines(ticketId).filter { lineIds.contains(it.id) && it.sent_to_kitchen_at == null && it.voided_at == null }
        if (fresh.isEmpty()) return
        val out = docs.kitchen(t, fresh, "ORDER")
        markSent(ticketId, out.printed)
        (out.errors + listOfNotNull(unseen(out, settings))).forEach { printing.report(it) }
    }

    // After a payment: the receipt prints, the drawer opens if the payment
    // type opens it, and anything paid that the kitchen never had is sent.
    // None of it holds the till up: it runs behind, and a printer that does
    // not answer is reported on the screen.
    // perGuest: the bill was split evenly between guests, and each of them
    // gets a copy of the receipt that says their share and the tax in it. It
    // is still one receipt, with one number.
    fun afterPay(r: ReceiptEntity, perGuest: Boolean = false) {
        printing.scope.launch { runCatching { paid(r, perGuest) } }
    }

    // An exchange is paid: the slip of what came back, then the receipt of what
    // the customer takes. The drawer opens when money went back out of it.
    fun afterExchange(refund: ReceiptEntity, sale: ReceiptEntity) {
        printing.scope.launch {
            runCatching {
                val types = db.ops().allPaymentTypes().associateBy { it.id }
                val drawer = db.receipts().payments(refund.id).any { types[it.payment_type_id]?.opens_drawer == true }
                val slip = docs.decode(refund.doc)
                if (slip != null && printing.receiptPrinter() != null) {
                    docs.print(slip, drawer).onFailure { printing.report(it.message ?: "The refund slip did not print") }
                }
                paid(sale, false)
            }
        }
    }

    // the receipt is printed (a copy for each guest of a bill split equally), and the drawer opens if it should
    private suspend fun paid(r: ReceiptEntity, perGuest: Boolean) {
        val types = db.ops().allPaymentTypes().associateBy { it.id }
        val drawer = db.receipts().payments(r.id).any { types[it.payment_type_id]?.opens_drawer == true }
        val doc = docs.decode(r.doc ?: db.ops().receipt(r.id)?.doc)
        if (doc != null && printing.receiptPrinter() != null) {
            if (perGuest && doc.payments.size >= 2) {
                doc.payments.forEachIndexed { i, pay ->
                    docs.print(doc.copy(payments = listOf(pay), share = i + 1, shares = doc.payments.size), drawer && i == 0)
                        .onFailure { printing.report(it.message ?: "The receipt did not print") }
                }
            } else {
                docs.print(doc, drawer).onFailure { printing.report(it.message ?: "The receipt did not print") }
            }
        }
        val unsent = db.tickets().allLines(r.ticket_id).filter { it.paid && it.sent_to_kitchen_at == null && it.voided_at == null }.map { it.id }
        if (unsent.isNotEmpty()) sendOnPay(r.ticket_id, unsent)
    }

    // The same kitchen tickets again, for an order whose paper was lost.
    suspend fun reprintKitchen(approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("receipts.reprint", "reprint", approver)
        val t = tickets.activeTicket() ?: error("No order is open")
        val sent = db.tickets().lines(t.id).first().filter { it.sent_to_kitchen_at != null }
        require(sent.isNotEmpty()) { "Nothing on this order has been sent to the kitchen yet" }
        val out = docs.kitchen(t, sent, "REPRINT")
        if (out.errors.isNotEmpty()) throw PrintError(out.errors.first())
    }

    // The bill, as many times as it is asked for. Nothing is recorded: it is
    // the order as it stands.
    // The table is marked as waiting to pay whether or not the paper came out:
    // the guests asked for the bill either way.
    suspend fun printBill(discount: DiscountPick?): Result<Unit> = runCatching {
        val t = tickets.activeTicket() ?: error("No order is open")
        val unpaid = db.tickets().lines(t.id).first().filter { !it.paid }
        require(unpaid.isNotEmpty()) { "Nothing to pay on this order" }
        if (t.table_id != null) tickets.setBill(t.id, System.currentTimeMillis())
        docs.print(docs.bill(t, unpaid, discount, service.servicePct(t))).getOrThrow()
    }

    // The bill of one check of a split check.
    suspend fun printCheck(lineIds: List<String>, check: Int, discount: DiscountPick?): Result<Unit> = runCatching {
        val t = tickets.activeTicket() ?: error("No order is open")
        val rows = db.tickets().lines(t.id).first().filter { !it.paid && lineIds.contains(it.id) }
        require(rows.isNotEmpty()) { "Nothing on this check" }
        val bill = docs.bill(t, rows, discount, service.servicePct(t))
        docs.print(bill.copy(order = "${bill.order} - Check $check")).getOrThrow()
    }

    // Taking an item off. Before it is sent it is simply deleted; after, it is
    // a void: the kitchen gets a VOID ticket so they stop making it. Neither
    // asks for a reason.
    suspend fun remove(lineId: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        val line = db.tickets().line(lineId) ?: error("That line is gone")
        val sent = line.sent_to_kitchen_at != null
        val permission = if (sent) "sale.void_sent_line" else "sale.void_line"
        staff.allow(permission, if (sent) "void an item the kitchen already has" else "take an item off an order", approver)
        tickets.voidLine(lineId, if (sent) "void" else "deleted", staff.approvedBy(permission, approver)).getOrThrow()
        if (sent) {
            db.tickets().ticket(line.ticket_id)?.let { t -> docs.kitchen(t, listOf(line), "VOID").errors.forEach { printing.report(it) } }
        }
    }

    suspend fun setWaiter(employeeId: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("ticket.reassign", "change the waiter", approver)
        tickets.setWaiter(employeeId, staff.approvedBy("ticket.reassign", approver)).getOrThrow()
    }

    // ---- receipts already issued ----

    suspend fun reprint(receiptId: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("receipts.reprint", "print a receipt again", approver)
        val r = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        docs.print(marked(r, docFor(r), reprint = true)).getOrThrow()
    }

    // What a receipt says about itself when it is printed again or looked at
    // later: that the paper is a copy, and how much of the sale has been
    // refunded since. A copy that reads like the first paper is what someone
    // would bring to the counter to be refunded a second time.
    suspend fun marked(r: ReceiptEntity, doc: ReceiptDoc, reprint: Boolean): ReceiptDoc {
        val back = if (r.type == "sale") db.ops().refundedOf(r.id) else 0L
        return doc.copy(reprint = reprint, refunded = back, refundedAll = back > 0 && back >= r.total)
    }

    // Another copy of a receipt that has just been issued, for the guest who
    // asks for one. Unlike a reprint from the receipt list it needs no
    // permission: it is the same sale, still on the screen.
    suspend fun printCopy(receiptId: String): Result<Unit> = runCatching {
        val r = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        docs.print(docFor(r)).getOrThrow()
    }

    // The receipt as plain text, to send by e-mail or message.
    suspend fun receiptText(receiptId: String): String? {
        val r = db.ops().receipt(receiptId) ?: return null
        val d = docFor(r)
        val shop = printing.shop()
        val out = ArrayList<String>()
        out += shop.name
        if (shop.address.isNotBlank()) out += shop.address
        if (shop.vat.isNotBlank()) out += "VAT " + shop.vat
        out += "Receipt " + d.number + " · " + java.text.SimpleDateFormat("d MMM yyyy HH:mm", java.util.Locale.UK).format(java.util.Date(d.time))
        out += ""
        d.lines.forEach { l ->
            out += "" + (l.qty + 500) / 1000 + " x " + l.name + "  " + docs.money(l.amount)
            l.mods.forEach { m -> out += "   + $m" }
        }
        out += ""
        d.discounts.forEach { out += "Discount " + it.name + "  -" + docs.money(it.amount) }
        if (d.service != 0L) out += "Service charge  " + docs.money(d.service)
        d.taxes.forEach { t -> out += t.name + (if (t.included) " (included)  " else "  ") + docs.money(t.amount) }
        out += "TOTAL  " + docs.money(d.total)
        d.payments.forEach { pay -> out += pay.name + "  " + docs.money(pay.amount) }
        if (shop.footer.isNotBlank()) { out += ""; out += shop.footer }
        return out.joinToString("\n")
    }

    // A receipt issued before this version has no stored print: it is put
    // together from what the tablet kept (no add-ons, no tax lines).
    // Also a receipt that came from the server (another till's): what it
    // charged is all there, line by line; what it took off the bill is one
    // figure, and its tax one figure.
    suspend fun docOf(r: ReceiptEntity): ReceiptDoc = docFor(r)

    private suspend fun docFor(r: ReceiptEntity): ReceiptDoc {
        docs.decode(r.doc)?.let { return it }
        val types = db.ops().allPaymentTypes().associateBy { it.id }
        // tax that went on top of the prices is in the total; tax inside them is not
        val onTop = r.total - (r.subtotal - r.discount_total + r.service_charge + r.rounding)
        return ReceiptDoc(
            discounts = if (r.discount_total != 0L) listOf(com.restopos.core.print.DocAmount("Discount", r.discount_total)) else emptyList(),
            taxes = if (r.tax_total != 0L) listOf(com.restopos.core.print.DocTax("Tax", 0, r.tax_total, onTop == 0L)) else emptyList(),
            service = r.service_charge,
            kind = if (r.type == "refund") "refund" else "receipt", number = r.number, time = r.device_time,
            lines = db.receipts().lines(r.id).map {
                com.restopos.core.print.DocLine(it.qty, it.name_snapshot, Calc.lineAmount(it.unit_price, it.qty), was = it.list_price?.let { p -> Calc.lineAmount(p, it.qty) }, priceNote = it.price_label)
            },
            subtotal = r.subtotal, rounding = r.rounding, total = r.total,
            payments = db.receipts().payments(r.id).map { DocPayment(types[it.payment_type_id]?.name ?: "Paid", it.amount, it.tendered, it.change, it.reference) },
        )
    }

    // What a receipt charged, line by line, in the form the refund arithmetic
    // takes. Null for a receipt issued before the till kept which line of the
    // order each of its lines paid for: that one can only be refunded whole.
    private suspend fun shares(orig: ReceiptEntity): List<RefundCalc.Share>? {
        val rows = db.receipts().lines(orig.id)
        if (rows.isEmpty() || rows.any { it.ticket_line_id == null }) return null
        val lines = rows.map { l ->
            val id = l.ticket_line_id!!
            // A receipt made here has its order's lines on this tablet, with
            // their add-ons and taxes. One that came from the server (another
            // till's) has only its own lines, and the same two things for each.
            if (orig.pulled) RefundCalc.Line(id, Calc.lineAmount(l.unit_price, l.qty) + db.receipts().modsOf(l.id), l.qty, db.receipts().taxesOf(l.id).map { Calc.TaxRate(it.rate_bp, it.type) })
            else RefundCalc.Line(id, Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(id), l.qty, db.catalog().lineTaxes(id).map { Calc.TaxRate(it.rate_bp, it.type) })
        }
        return RefundCalc.shares(lines, RefundCalc.Receipt(orig.subtotal, orig.discount_total, orig.service_charge, orig.rounding, orig.tax_total, orig.total))
    }

    // The taxes on one line of a receipt, wherever this tablet has them.
    private class TaxRow(val tax_id: String, val rate_bp: Int, val type: String)
    private suspend fun taxRows(orig: ReceiptEntity, ticketLine: String): List<TaxRow> =
        if (orig.pulled) db.receipts().lines(orig.id).firstOrNull { it.ticket_line_id == ticketLine }?.let { rl -> db.receipts().taxesOf(rl.id).map { TaxRow(it.tax_id, it.rate_bp, it.type) } }.orEmpty()
        else db.catalog().lineTaxes(ticketLine).map { TaxRow(it.tax_id, it.rate_bp, it.type) }

    // The lines of a receipt that can still be given back, or null when the
    // receipt can only be refunded whole.
    suspend fun refundable(receiptId: String): List<RefundLine>? {
        val orig = db.ops().receipt(receiptId) ?: return null
        if (shares(orig) == null) return null
        val done = db.ops().refundedQty(receiptId).associate { it.line_id to it.total.toInt() }
        return db.receipts().lines(receiptId).map { RefundLine(it.ticket_line_id!!, it.name_snapshot, it.qty, done[it.ticket_line_id] ?: 0) }
    }

    // What giving these back comes to: line id to quantity, in thousandths.
    suspend fun refundQuote(receiptId: String, picks: Map<String, Int>): Long {
        val orig = db.ops().receipt(receiptId) ?: return 0
        val shares = shares(orig) ?: return 0
        val done = db.ops().refundedQty(receiptId).associate { it.line_id to it.total.toInt() }
        return shares.sumOf { s -> picks[s.line.id]?.takeIf { it > 0 }?.let { q -> RefundCalc.parts(s, done[s.line.id] ?: 0, q).total } ?: 0L }
    }

    // A refund gives a receipt back, whole or in part, in the payment type
    // chosen. picks names what comes back (order line id to quantity, in
    // thousandths); with none, everything not yet given back does. The server
    // works the amount out from the receipt itself and refuses one that is a
    // cent off; the till works out the same amount (RefundCalc), because it is
    // what the cashier hands over, online or not.
    // restock: the goods go back on the shelf. Off (they are faulty), the
    // server takes them back and writes them off as damaged; this till's copy
    // of the shelf is then left as it is.
    // toExchange: the part that pays for a new sale instead of going back to
    // the customer (an exchange, core/data/Exchange.kt). It leaves through the
    // shop's exchange payment type; only the rest goes back in the type chosen.
    // quiet: nothing is printed or sent here; whoever asked does both.
    suspend fun refund(
        receiptId: String, reason: String, paymentTypeId: String, approver: StaffMember? = null, picks: Map<String, Int>? = null, restock: Boolean = true,
        toExchange: Long = 0, quiet: Boolean = false,
    ): Result<ReceiptEntity> = runCatching {
        require(reason.isNotBlank()) { "Say why it is refunded" }
        staff.allow("sale.refund", "refund", approver)
        val orig = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        require(orig.type == "sale") { "A refund cannot be refunded" }
        val already = db.ops().refundedOf(receiptId)
        val shares = shares(orig)
        val done = db.ops().refundedQty(receiptId).associate { it.line_id to it.total.toInt() }
        // what comes back of each line; without the lines, the whole receipt and only once
        val back: List<Pair<RefundCalc.Share, Int>>? = shares?.mapNotNull { s ->
            val left = s.line.qty - (done[s.line.id] ?: 0)
            val q = if (picks == null) left else (picks[s.line.id] ?: 0)
            require(q in 0..left) { "More than is left of a line cannot be refunded" }
            if (q > 0) s to q else null
        }
        if (back == null) {
            require(picks == null) { "This receipt can only be refunded whole" }
            require(db.ops().refundCount(receiptId) == 0) { "This receipt was already refunded" }
        } else {
            require(back.isNotEmpty()) { if (picks == null) "This receipt was already refunded" else "Pick what is refunded" }
        }
        val parts = back?.fold(RefundCalc.Parts()) { acc, (s, q) -> acc + RefundCalc.parts(s, done[s.line.id] ?: 0, q) }
        val amount = parts?.total ?: orig.total
        val paid = db.receipts().payments(receiptId).sumOf { it.amount }
        require(paid >= orig.total && already + amount <= paid) { "This receipt was not paid in full. Check it in the back office first." }
        val type = db.ops().paymentType(paymentTypeId) ?: error("Pick how the money goes back")
        require(toExchange in 0..amount) { "More than comes back cannot go to the new sale" }
        val exchange = if (toExchange > 0) db.ops().exchangeType() ?: error("This till has no Exchange payment type") else null
        // what goes back to the customer
        val rest = amount - toExchange
        require(rest == 0L || type.kind != "exchange") { "Pick how the money goes back" }
        val tenant = session.tenantId() ?: error("no tenant")
        val store = session.storeId() ?: error("no store")
        val deviceId = session.deviceId() ?: error("no device")
        val device = db.catalog().device(deviceId) ?: error("no device")
        val storeRow = db.catalog().store(store) ?: error("no store")
        val seq = device.last_receipt_seq + 1
        val number = "${storeRow.code}-${device.code}-R${seq.toString().padStart(6, '0')}"
        val id = Uuid7.next()
        val now = System.currentTimeMillis()
        val was = docFor(orig)
        val sold = db.receipts().lines(orig.id)
        // the slip says what came back: the lines given back, with what each was charged
        val slipLines = if (back == null) was.lines else back.map { (s, q) ->
            val i = sold.indexOfFirst { it.ticket_line_id == s.line.id }
            val name = sold.getOrNull(i)?.name_snapshot ?: "Item"
            val amount = RefundCalc.parts(s, done[s.line.id] ?: 0, q).sub
            (was.lines.getOrNull(i)?.takeIf { was.lines.size == sold.size } ?: com.restopos.core.print.DocLine(q, name, amount)).copy(qty = q, amount = amount)
        }
        val partial = parts != null && amount != orig.total
        val names = db.ops().allTaxes().associateBy { it.id }
        val slipTaxes = if (!partial) was.taxes else {
            val out = LinkedHashMap<String, com.restopos.core.print.DocTax>()
            back!!.forEach { (s, q) ->
                val p = RefundCalc.parts(s, done[s.line.id] ?: 0, q)
                val rows = taxRows(orig, s.line.id)
                val one = rows.singleOrNull()
                val key = one?.tax_id ?: "tax"
                val cur = out[key]
                out[key] = com.restopos.core.print.DocTax(one?.let { names[it.tax_id]?.name } ?: "Tax", one?.rate_bp ?: 0, (cur?.amount ?: 0) + p.tax, rows.none { it.type == "added" })
            }
            out.values.filter { it.amount != 0L }
        }
        val doc = was.copy(
            kind = "refund", number = number, time = now, cashier = staff.current.value?.employee?.name,
            lines = slipLines, taxes = slipTaxes,
            subtotal = parts?.sub ?: was.subtotal,
            discounts = if (!partial) was.discounts else listOfNotNull(parts!!.disc.takeIf { it != 0L }?.let { com.restopos.core.print.DocAmount("Discount", it) }),
            service = parts?.svc ?: was.service, rounding = parts?.rnd ?: was.rounding, total = amount,
            payments = listOfNotNull(
                if (toExchange > 0) DocPayment("Exchange, to the new sale", toExchange) else null,
                if (rest > 0) DocPayment(type.name, rest) else null,
            ),
            refundOf = orig.number, reason = reason.trim(),
        )
        val refund = ReceiptEntity(
            id, tenant, store, deviceId, orig.ticket_id, number, type = "refund", refund_of = orig.id,
            subtotal = parts?.sub ?: orig.subtotal, discount_total = parts?.disc ?: orig.discount_total, tax_total = parts?.tax ?: orig.tax_total,
            service_charge = parts?.svc ?: orig.service_charge, rounding = parts?.rnd ?: orig.rounding, total = amount, device_time = now, doc = docs.encode(doc),
        )
        db.withTransaction {
            db.receipts().insertReceipt(refund)
            db.receipts().insertLines(
                if (back == null) sold.map { ReceiptLineEntity(Uuid7.next(), tenant, id, it.name_snapshot, it.unit_price, it.qty, it.ticket_line_id, it.list_price, it.price_kind, it.price_label) }
                else back.mapNotNull { (s, q) -> sold.firstOrNull { it.ticket_line_id == s.line.id }?.let { ReceiptLineEntity(Uuid7.next(), tenant, id, it.name_snapshot, it.unit_price, q, s.line.id, it.list_price, it.price_kind, it.price_label) } },
            )
            // what came back is on this till's copy of the shelf again, unless it is not being put back
            if (restock) {
                val returned = if (back == null) sold.mapNotNull { r -> r.ticket_line_id?.let { db.tickets().line(it) }?.let { it to r.qty } }
                else back.mapNotNull { (s, q) -> db.tickets().line(s.line.id)?.let { it to q } }
                db.moveStock(store, returned)
            }
            db.receipts().insertPayments(listOfNotNull(
                if (exchange != null) ReceiptPaymentEntity(Uuid7.next(), tenant, id, exchange.id, toExchange) else null,
                if (rest > 0) ReceiptPaymentEntity(Uuid7.next(), tenant, id, type.id, rest) else null,
            ))
            db.catalog().upsertDevices(listOf(device.copy(last_receipt_seq = seq)))
            db.outbox().enqueue(op("refund.create", buildJsonObject {
                put("id", id); put("refund_of", orig.id); put("store_id", store); put("device_id", deviceId)
                put("number", number); put("device_seq", seq); put("reason", reason.trim())
                put("device_time", Instant.ofEpochMilli(now).toString())
                // named lines only when some of the receipt stays: with none the server gives back everything that is left
                if (picks != null && back != null) put("lines", buildJsonArray {
                    back.forEach { (s, q) -> add(buildJsonObject { put("ticket_line_id", s.line.id); put("qty", q) }) }
                })
                put("payments", buildJsonArray {
                    if (exchange != null) add(buildJsonObject { put("payment_type_id", exchange.id); put("amount", toExchange) })
                    if (rest > 0) add(buildJsonObject { put("payment_type_id", type.id); put("amount", rest) })
                })
                staff.approvedBy("sale.refund", approver)?.let { put("approved_by", it) }
                if (!restock) put("restock", false)
            }))
        }
        if (!quiet) {
            pushNow(context)
            docs.print(doc, openDrawer = type.opens_drawer).onFailure { printing.report(it.message ?: "The refund slip did not print") }
        }
        refund
    }

    // A bill rung up under the wrong payment type. The amount never changes;
    // the server keeps who corrected it and when.
    suspend fun correctPayment(receiptId: String, from: String, to: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        require(from != to) { "Pick a different payment type" }
        staff.allow("payment.correct", "correct a payment type", approver)
        val r = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        val names = db.ops().allPaymentTypes().associateBy { it.id }
        val now = Instant.now().toString()
        db.withTransaction {
            require(db.ops().retypePayments(receiptId, from, to) > 0) { "This receipt has no payment of that type" }
            docs.decode(r.doc)?.let { d ->
                val old = names[from]?.name
                val cash = names[to]?.kind == "cash"
                db.ops().setDoc(receiptId, docs.encode(d.copy(payments = d.payments.map {
                    if (it.name != old) it
                    else it.copy(name = names[to]?.name ?: it.name, tendered = if (cash) it.tendered else null, change = if (cash) it.change else 0)
                })))
            }
            db.outbox().enqueue(op("payment.correct", buildJsonObject {
                put("id", Uuid7.next()); put("receipt_id", receiptId)
                put("from_payment_type_id", from); put("to_payment_type_id", to); put("corrected_at", now)
                staff.approvedBy("payment.correct", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
    }

    suspend fun test(printerId: String): Result<Unit> = runCatching {
        val p = printing.printers().firstOrNull { it.id == printerId } ?: error("That printer is switched off or was removed")
        printing.send(p, Docs.test(p.name, printing.paper(p)), "Test print").getOrThrow()
    }
}

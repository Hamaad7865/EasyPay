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
// if it could not print.
data class SaveResult(val sent: Int, val errors: List<String>)

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
        // an order type set to never go to the kitchen is only put away
        val mode = (t.dining_option_id?.let { db.ops().dining(it) } ?: db.catalog().diningOptions().firstOrNull { it.is_default })?.kitchen ?: "save"
        if (mode == "off") return@runCatching SaveResult(0, emptyList())
        val fresh = db.tickets().lines(t.id).first().filter { it.sent_to_kitchen_at == null && !it.paid }
        if (fresh.isEmpty()) return@runCatching SaveResult(0, emptyList())
        val out = docs.kitchen(t, fresh, "ORDER")
        markSent(t.id, out.printed)
        SaveResult(out.printed.size, out.errors)
    }

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
        val mode = (t.dining_option_id?.let { db.ops().dining(it) } ?: db.catalog().diningOptions().firstOrNull { it.is_default })?.kitchen ?: "save"
        if (mode == "off") return
        // "save" too: a bill paid without ever pressing Save must still reach the kitchen
        val fresh = db.tickets().allLines(ticketId).filter { lineIds.contains(it.id) && it.sent_to_kitchen_at == null && it.voided_at == null }
        if (fresh.isEmpty()) return
        val out = docs.kitchen(t, fresh, "ORDER")
        markSent(ticketId, out.printed)
        out.errors.forEach { printing.report(it) }
    }

    // After a payment: the receipt prints, the drawer opens if the payment
    // type opens it, and anything paid that the kitchen never had is sent.
    // None of it holds the till up: it runs behind, and a printer that does
    // not answer is reported on the screen.
    // perGuest: the bill was split evenly between guests, and each of them
    // gets a copy of the receipt that says their share and the tax in it. It
    // is still one receipt, with one number.
    fun afterPay(r: ReceiptEntity, perGuest: Boolean = false) {
        printing.scope.launch {
            runCatching {
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
        }
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
        docs.print(docFor(r)).getOrThrow()
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
    private suspend fun docFor(r: ReceiptEntity): ReceiptDoc {
        docs.decode(r.doc)?.let { return it }
        val types = db.ops().allPaymentTypes().associateBy { it.id }
        return ReceiptDoc(
            kind = if (r.type == "refund") "refund" else "receipt", number = r.number, time = r.device_time,
            lines = db.receipts().lines(r.id).map { com.restopos.core.print.DocLine(it.qty, it.name_snapshot, Calc.lineAmount(it.unit_price, it.qty)) },
            subtotal = r.subtotal, rounding = r.rounding, total = r.total,
            payments = db.receipts().payments(r.id).map { DocPayment(types[it.payment_type_id]?.name ?: "Paid", it.amount, it.tendered, it.change, it.reference) },
        )
    }

    // A refund gives a whole receipt back, in the payment type chosen. The
    // server works the refund out from the receipt itself; the till sends the
    // same total, which it knows because it issued the receipt.
    suspend fun refund(receiptId: String, reason: String, paymentTypeId: String, approver: StaffMember? = null): Result<ReceiptEntity> = runCatching {
        require(reason.isNotBlank()) { "Say why it is refunded" }
        staff.allow("sale.refund", "refund", approver)
        val orig = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        require(orig.type == "sale") { "A refund cannot be refunded" }
        require(db.ops().refundedOf(receiptId) == 0L) { "This receipt was already refunded" }
        val paid = db.receipts().payments(receiptId).sumOf { it.amount }
        require(paid >= orig.total) { "This receipt was not paid in full. Check it in the back office first." }
        val type = db.ops().paymentType(paymentTypeId) ?: error("Pick how the money goes back")
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
        val doc = was.copy(
            kind = "refund", number = number, time = now, cashier = staff.current.value?.employee?.name,
            payments = if (orig.total > 0) listOf(DocPayment(type.name, orig.total)) else emptyList(),
            refundOf = orig.number, reason = reason.trim(),
        )
        val refund = ReceiptEntity(
            id, tenant, store, deviceId, orig.ticket_id, number, type = "refund", refund_of = orig.id,
            subtotal = orig.subtotal, discount_total = orig.discount_total, tax_total = orig.tax_total,
            service_charge = orig.service_charge, rounding = orig.rounding, total = orig.total, device_time = now, doc = docs.encode(doc),
        )
        db.withTransaction {
            db.receipts().insertReceipt(refund)
            db.receipts().insertLines(db.receipts().lines(orig.id).map { ReceiptLineEntity(Uuid7.next(), tenant, id, it.name_snapshot, it.unit_price, it.qty, it.ticket_line_id) })
            if (orig.total > 0) db.receipts().insertPayments(listOf(ReceiptPaymentEntity(Uuid7.next(), tenant, id, type.id, orig.total)))
            db.catalog().upsertDevices(listOf(device.copy(last_receipt_seq = seq)))
            db.outbox().enqueue(op("refund.create", buildJsonObject {
                put("id", id); put("refund_of", orig.id); put("store_id", store); put("device_id", deviceId)
                put("number", number); put("device_seq", seq); put("reason", reason.trim())
                put("device_time", Instant.ofEpochMilli(now).toString())
                put("payments", buildJsonArray {
                    if (orig.total > 0) add(buildJsonObject { put("payment_type_id", type.id); put("amount", orig.total) })
                })
                staff.approvedBy("sale.refund", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
        docs.print(doc, openDrawer = type.opens_drawer).onFailure { printing.report(it.message ?: "The refund slip did not print") }
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

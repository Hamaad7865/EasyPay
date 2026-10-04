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
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    // Save: what the kitchen has not had yet is printed where its category
    // prints, then marked as sent. Opening the order again and saving again
    // sends only what was added since. A printer that does not answer keeps
    // its lines unsent, so the next Save tries them again.
    suspend fun save(): Result<SaveResult> = runCatching {
        val t = tickets.activeTicket() ?: return@runCatching SaveResult(0, emptyList())
        val fresh = db.tickets().lines(t.id).first().filter { it.sent_to_kitchen_at == null && !it.paid }
        if (fresh.isEmpty()) return@runCatching SaveResult(0, emptyList())
        val out = docs.kitchen(t, fresh, "ORDER")
        markSent(t.id, out.printed)
        SaveResult(out.printed.size, out.errors)
    }

    private suspend fun markSent(ticketId: String, ids: List<String>) {
        if (ids.isEmpty()) return
        val now = Instant.now().toString()
        db.withTransaction {
            db.tickets().markSent(ids, now)
            db.outbox().enqueue(op("ticket.send", buildJsonObject {
                put("ticket_id", ticketId); put("sent_at", now)
                put("line_ids", buildJsonArray { ids.forEach { add(it) } })
            }))
        }
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

    // The same kitchen tickets again, for an order whose paper was lost.
    suspend fun reprintKitchen(): Result<Unit> = runCatching {
        require(staff.can("receipts.reprint")) { "You are not allowed to reprint" }
        val t = tickets.activeTicket() ?: error("No order is open")
        val sent = db.tickets().lines(t.id).first().filter { it.sent_to_kitchen_at != null }
        require(sent.isNotEmpty()) { "Nothing on this order has been sent to the kitchen yet" }
        val out = docs.kitchen(t, sent, "REPRINT")
        if (out.errors.isNotEmpty()) throw PrintError(out.errors.first())
    }

    // The bill, as many times as it is asked for. Nothing is recorded: it is
    // the order as it stands.
    suspend fun printBill(discount: DiscountPick?): Result<Unit> = runCatching {
        val t = tickets.activeTicket() ?: error("No order is open")
        val unpaid = db.tickets().lines(t.id).first().filter { !it.paid }
        require(unpaid.isNotEmpty()) { "Nothing to pay on this order" }
        docs.print(docs.bill(t, unpaid, discount)).getOrThrow()
    }

    // Taking an item off. Before it is sent it is simply deleted; after, it is
    // a void: the kitchen gets a VOID ticket so they stop making it. Neither
    // asks for a reason.
    suspend fun remove(lineId: String): Result<Unit> = runCatching {
        val line = db.tickets().line(lineId) ?: error("That line is gone")
        val sent = line.sent_to_kitchen_at != null
        if (sent) require(staff.can("sale.void_sent_line")) { "You are not allowed to void an item the kitchen already has. Ask a manager." }
        else require(staff.can("sale.void_line")) { "You are not allowed to delete an item" }
        tickets.voidLine(lineId, if (sent) "void" else "deleted").getOrThrow()
        if (sent) {
            db.tickets().ticket(line.ticket_id)?.let { t -> docs.kitchen(t, listOf(line), "VOID").errors.forEach { printing.report(it) } }
        }
    }

    suspend fun setWaiter(employeeId: String): Result<Unit> {
        if (!staff.can("ticket.reassign")) return Result.failure(IllegalStateException("You are not allowed to change the waiter"))
        return tickets.setWaiter(employeeId)
    }

    // ---- receipts already issued ----

    suspend fun reprint(receiptId: String): Result<Unit> = runCatching {
        require(staff.can("receipts.reprint")) { "You are not allowed to reprint" }
        val r = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        docs.print(docFor(r)).getOrThrow()
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
    suspend fun refund(receiptId: String, reason: String, paymentTypeId: String): Result<ReceiptEntity> = runCatching {
        require(staff.can("sale.refund")) { "You are not allowed to refund. Ask a manager." }
        require(reason.isNotBlank()) { "Say why it is refunded" }
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
            db.receipts().insertLines(db.receipts().lines(orig.id).map { ReceiptLineEntity(Uuid7.next(), tenant, id, it.name_snapshot, it.unit_price, it.qty) })
            if (orig.total > 0) db.receipts().insertPayments(listOf(ReceiptPaymentEntity(Uuid7.next(), tenant, id, type.id, orig.total)))
            db.catalog().upsertDevices(listOf(device.copy(last_receipt_seq = seq)))
            db.outbox().enqueue(op("refund.create", buildJsonObject {
                put("id", id); put("refund_of", orig.id); put("store_id", store); put("device_id", deviceId)
                put("number", number); put("device_seq", seq); put("reason", reason.trim())
                put("device_time", Instant.ofEpochMilli(now).toString())
                put("payments", buildJsonArray {
                    if (orig.total > 0) add(buildJsonObject { put("payment_type_id", type.id); put("amount", orig.total) })
                })
            }))
        }
        pushNow(context)
        docs.print(doc, openDrawer = type.opens_drawer).onFailure { printing.report(it.message ?: "The refund slip did not print") }
        refund
    }

    // A bill rung up under the wrong payment type. The amount never changes;
    // the server keeps who corrected it and when.
    suspend fun correctPayment(receiptId: String, from: String, to: String): Result<Unit> = runCatching {
        require(staff.can("payment.correct")) { "You are not allowed to correct a payment type. Ask a manager." }
        require(from != to) { "Pick a different payment type" }
        val r = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        val names = db.ops().allPaymentTypes().associateBy { it.id }
        val now = Instant.now().toString()
        db.withTransaction {
            require(db.ops().retypePayments(receiptId, from, to) > 0) { "This receipt has no payment of that type" }
            docs.decode(r.doc)?.let { d ->
                val old = names[from]?.name
                db.ops().setDoc(receiptId, docs.encode(d.copy(payments = d.payments.map { if (it.name == old) it.copy(name = names[to]?.name ?: it.name) else it })))
            }
            db.outbox().enqueue(op("payment.correct", buildJsonObject {
                put("id", Uuid7.next()); put("receipt_id", receiptId)
                put("from_payment_type_id", from); put("to_payment_type_id", to); put("corrected_at", now)
            }))
        }
        pushNow(context)
    }

    suspend fun test(printerId: String): Result<Unit> = runCatching {
        val p = printing.printers().firstOrNull { it.id == printerId } ?: error("That printer is switched off or was removed")
        printing.send(p, Docs.test(p.name, printing.paper(p))).getOrThrow()
    }
}

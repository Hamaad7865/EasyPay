package com.restopos.core.data

import com.restopos.core.database.free
import com.restopos.core.database.left
import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Money
import com.restopos.core.common.Uuid7
import com.restopos.core.database.CashMoveEntity
import com.restopos.core.database.CreditNoteEntity
import com.restopos.core.database.DepositEntity
import com.restopos.core.database.DepositLineEntity
import com.restopos.core.database.DepositPaymentEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TicketLineTaxEntity
import com.restopos.core.database.TillDatabase
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

// A deposit's money in or out, as the till hands it over: the payment type,
// the amount, and for cash what was tendered.
data class DepositMoney(val paymentTypeId: String, val amount: Long, val tendered: Long? = null, val change: Long = 0)

// A shop's deposits on this tablet (server 0113; the spec is
// docs/superpowers/specs/2026-10-16-shop-deposits-design.md). Like every write
// on the till: the rows and the outbox op in ONE transaction, then a push.
// Everything is done here first, so a tablet with no signal, or one that works
// alone, takes, pays, collects and cancels as a connected one does; the server
// checks again when the operation arrives and flags rather than loses money
// that already moved. Cash moves the drawer through its own rows (the
// cash_movements of a pay-in or pay-out, naming the deposit), with no
// cash.move op: the server writes the same row from the deposit's operation.
@Singleton
class Deposits @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val tickets: TicketRepository,
    private val docs: DocBuilder,
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())
    private fun iso(at: Long) = Instant.ofEpochMilli(at).toString()

    suspend fun settings() = PosSettings.parse(db.ops().settings())

    // ---- reading ----
    fun all() = db.deposits().all()
    fun watch(id: String) = db.deposits().watch(id)
    fun lines(id: String) = db.deposits().watchLines(id)
    fun payments(id: String) = db.deposits().watchPayments(id)
    suspend fun find(number: String) = db.deposits().byNumber(number.trim().uppercase())

    // what the customer still owes on a deposit (DepositRules.toPay); nothing once it is closed
    suspend fun toPay(d: DepositEntity): Long {
        if (d.status != "open") return 0
        val b = db.deposits().bases(d.id)
        return DepositRules.toPay(d.total, b.whole, b.held, d.free)
    }
    suspend fun customerName(id: String?) = id?.let { db.customers().customer(it) }

    // ---- taking one ----

    // The sale on the screen becomes a deposit: its lines at the prices they
    // carry now (a line's discount included), the customer, the date, and
    // what is paid now (null: the goods only held). The sale itself is put
    // away: its lines voided and the order closed, here and on the server.
    suspend fun take(customerId: String?, collectBy: String, pay: DepositMoney?): Result<DepositEntity> = runCatching {
        val s = settings()
        require(s.deposits) { "This shop does not take deposits" }
        require(staff.can("payment.take")) { "You are not allowed to take payment" }
        val t = tickets.activeTicket() ?: error("Ring up what the customer wants first")
        val sale = db.tickets().lines(t.id).first().filter { it.voided_at == null && !it.paid }
        require(sale.isNotEmpty()) { "Ring up what the customer wants first" }
        require(sale.none { it.deposit_line_id != null }) { "These goods are already on a deposit. Pay for them instead." }
        require(sale.all { it.item_id != null }) { "Only products can be held" }
        // a deposit keeps each line's price; a discount on the whole sale has no line to stay on, and would be lost
        require(tickets.pendingDiscount() == null) { "Take the discount off the sale first, or give it on the lines: a deposit keeps each line's price." }
        val customer = customerId?.let { db.customers().customer(it) }
        DepositRules.customerMissing(s.depositCustomer, customer?.name, customer?.phone)?.let { error(it) }
        val tenant = session.tenantId() ?: error("no tenant")
        val store = session.storeId() ?: error("no store")
        val device = session.deviceId() ?: error("no device")
        val till = db.catalog().device(device) ?: error("no device")
        val storeRow = db.catalog().store(store) ?: error("no store")
        val shift = db.staff().openShift(device)
        require(pay == null || pay.amount == 0L || shift != null) { "Open the day first: money taken goes in the day's drawer" }

        val calc = sale.map { l -> Calc.Line(Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(l.id), db.catalog().lineTaxes(l.id).map { Calc.TaxRate(it.rate_bp, it.type) }) }
        val total = Calc.totals(calc, emptyList()).total
        val money = pay?.takeIf { it.amount > 0 }
        money?.let { m -> DepositRules.payNowError(m.amount, total)?.let { error(it) }; checkType(m.paymentTypeId) }

        val number = DepositRules.next(storeRow.code, till.code, db.deposits().numbersOf(device, DepositRules.prefix(storeRow.code, till.code)))
        val id = Uuid7.next()
        val now = System.currentTimeMillis()
        val lines = sale.mapIndexed { i, l ->
            DepositLineEntity(Uuid7.next(), id, l.item_id!!, l.variant_id ?: "", l.name_snapshot, l.qty, 0, l.unit_price, l.list_price, l.price_kind, l.price_label, l.price_by, i + 1)
        }
        val payRow = money?.let { DepositPaymentEntity(Uuid7.next(), id, it.paymentTypeId, "in", it.amount, it.tendered, it.change, shift?.id, device, staff.id(), now) }
        val row = DepositEntity(id, tenant, store, device, number, customer?.id, collectBy, total = total, paid = money?.amount ?: 0, created_by = staff.id(), device_time = now)
        val at = iso(now)
        db.withTransaction {
            db.deposits().upsert(listOf(row))
            db.deposits().upsertLines(lines)
            payRow?.let { db.deposits().upsertPayments(listOf(it)); drawer(it, row, true) }
            // the goods leave this till's copy of the shelf now, as a sale's do
            db.moveStock(store, sale.map { it to -it.qty })
            db.outbox().enqueue(op("deposit.create", buildJsonObject {
                put("id", id); put("store_id", store); put("device_id", device); put("number", number)
                customer?.let { put("customer_id", it.id) }
                put("collect_by", collectBy); put("device_time", at)
                put("lines", buildJsonArray {
                    lines.forEach { l -> add(buildJsonObject {
                        put("id", l.id); put("item_id", l.item_id); if (l.variant_id.isNotEmpty()) put("variant_id", l.variant_id)
                        put("name", l.name); put("qty", l.qty); put("unit_price", l.unit_price)
                        l.price_kind?.let { k -> put("price_kind", k); put("list_price", l.list_price ?: l.unit_price); l.price_label?.let { put("price_label", it) }; l.price_by?.let { put("price_by", it) } }
                    }) }
                })
                payRow?.let { put("payment", payJson(it)) }
            }))
            // the sale is put away: nothing on it was sold
            sale.forEach { l ->
                db.tickets().voidLine(l.id, at, "on deposit $number")
                db.outbox().enqueue(op("ticket.void_line", buildJsonObject { put("line_id", l.id); put("reason", "on deposit $number") }))
            }
            db.tickets().upsertTicket(t.copy(status = "cancelled", updated_at = now))
            db.outbox().enqueue(op("ticket.cancel", buildJsonObject { put("ticket_id", t.id) }))
        }
        session.clearActiveTicket()
        pushNow(context)
        row
    }

    // ---- money on it ----

    suspend fun pay(depositId: String, m: DepositMoney): Result<DepositEntity> = runCatching {
        require(staff.can("payment.take")) { "You are not allowed to take payment" }
        val d = db.deposits().deposit(depositId) ?: error("That deposit is gone")
        require(d.status == "open") { "Deposit ${d.number} is closed" }
        DepositRules.payNowError(m.amount, toPay(d))?.let { error(it) }
        require(m.amount > 0) { "Type how much" }
        checkType(m.paymentTypeId)
        val device = session.deviceId() ?: error("no device")
        val shift = db.staff().openShift(device) ?: error("Open the day first: money taken goes in the day's drawer")
        val now = System.currentTimeMillis()
        val p = DepositPaymentEntity(Uuid7.next(), d.id, m.paymentTypeId, "in", m.amount, m.tendered, m.change, shift.id, device, staff.id(), now)
        val next = d.copy(paid = d.paid + m.amount)
        db.withTransaction {
            db.deposits().upsertPayments(listOf(p))
            db.deposits().upsert(listOf(next))
            drawer(p, d, true)
            db.outbox().enqueue(op("deposit.pay", buildJsonObject {
                put("deposit_id", d.id); put("device_id", device); put("device_time", iso(now)); put("payment", payJson(p))
            }))
        }
        pushNow(context)
        next
    }

    // ---- collecting ----

    // Puts the lines picked (deposit line id -> how many, in thousandths) on a
    // new sale, at the prices the deposit kept and naming their deposit line,
    // so Pay takes the deposit first and the server knows the goods were held.
    suspend fun collect(depositId: String, picks: Map<String, Int>): Result<Unit> = runCatching {
        val d = db.deposits().deposit(depositId) ?: error("That deposit is gone")
        require(d.status == "open") { "Deposit ${d.number} is closed" }
        val lines = db.deposits().lines(d.id).associateBy { it.id }
        val taken = picks.filter { it.value > 0 }
        require(taken.isNotEmpty()) { "Tick what the customer takes today" }
        taken.forEach { (lid, q) -> val l = lines[lid] ?: error("That line is gone"); require(q <= l.left) { "Only ${l.left / 1000} of ${l.name} are left on the deposit" } }
        val tenant = session.tenantId() ?: error("no tenant")
        // a fresh sale: whatever was on the screen is parked under Orders
        tickets.startOrder(tickets.counterTypeId())
        val t = tickets.ensureTicket()
        if (d.customer_id != null) tickets.setCustomer(d.customer_id)
        db.withTransaction {
            taken.forEach { (lid, q) ->
                val l = lines.getValue(lid)
                val lineId = Uuid7.next()
                val taxes = db.catalog().taxesForItem(l.item_id)
                db.tickets().upsertLines(listOf(TicketLineEntity(
                    lineId, tenant, t.id, l.item_id, l.variant_id.ifEmpty { null }, l.name, l.unit_price, q,
                    list_price = l.list_price, price_kind = l.price_kind, price_label = l.price_label, price_by = l.price_by, deposit_line_id = l.id,
                )))
                db.catalog().upsertLineTaxes(taxes.map { TicketLineTaxEntity(lineId, it.id, it.rate_bp, it.type) })
                db.outbox().enqueue(op("ticket.add_line", buildJsonObject {
                    put("id", lineId); put("ticket_id", t.id); put("item_id", l.item_id)
                    if (l.variant_id.isNotEmpty()) put("variant_id", l.variant_id)
                    put("qty", q); put("unit_price", l.unit_price); put("name_snapshot", l.name)
                    put("deposit_line_id", l.id)
                    l.price_kind?.let { k -> put("price_kind", k); put("list_price", l.list_price ?: l.unit_price); put("price_label", l.price_label ?: ""); l.price_by?.let { put("approved_by", it) } }
                }))
            }
        }
        pushNow(context)
    }

    // The deposit a sale's lines are handed over from, if any (one per sale).
    suspend fun onSale(lines: List<TicketLineEntity>): DepositEntity? {
        val lid = lines.firstNotNullOfOrNull { it.deposit_line_id } ?: return null
        val dl = db.deposits().line(lid) ?: return null
        return db.deposits().deposit(dl.deposit_id)
    }

    // ---- cancelling ----

    // outcome: refund (back: how the money goes back, by payment type),
    // credit (a credit note for what is free), keep. auto: the tablet's own
    // day opening cancelling one by its date (no right asked). A deposit
    // fully collected with money left on it is "closed" the same way.
    suspend fun cancel(
        depositId: String, outcome: String, reason: String, back: List<DepositMoney> = emptyList(),
        approver: StaffMember? = null, auto: Boolean = false,
    ): Result<DepositEntity> = runCatching {
        require(outcome == "refund" || outcome == "credit" || outcome == "keep") { "bad outcome" }
        val d = db.deposits().deposit(depositId) ?: error("That deposit is gone")
        require(d.cancel_outcome == null) { "Deposit ${d.number} is already cancelled" }
        if (!auto) staff.allow("sale.refund", "cancel a deposit", approver)
        val s = settings()
        val device = session.deviceId() ?: error("no device")
        val store = session.storeId() ?: error("no store")
        val free = d.free.coerceAtLeast(0)
        val handed = back.filter { it.amount > 0 }
        if (outcome == "refund" && !auto) {
            require(handed.sumOf { it.amount } == free) { "Give back ${Money.format(free)} in all" }
            handed.forEach { checkType(it.paymentTypeId) }
        }
        val shift = db.staff().openShift(device)
        require(handed.isEmpty() || shift != null) { "Open the day first: money given back comes out of the day's drawer" }
        val now = System.currentTimeMillis()
        val lines = db.deposits().lines(d.id)
        val left = lines.any { it.left > 0 }
        val payRows = if (outcome == "refund") handed.map { DepositPaymentEntity(Uuid7.next(), d.id, it.paymentTypeId, "back", -it.amount, null, 0, shift?.id, device, staff.id(), now) } else emptyList()
        val given = payRows.sumOf { -it.amount }
        val note = if (outcome == "credit" && free > 0) {
            db.notes().paymentType() ?: error("This till has not been sent the shop's Credit note payment type yet. Let it sync.")
            CreditNoteEntity(Uuid7.next(), d.tenant_id, d.store_id, device, DepositRules.noteNumber(d.number), free, free, "", d.customer_id,
                DepositRules.noteValidTo(s.noteMonths), "open", staff.id(), now)
        } else null
        val next = d.copy(
            status = if (left) "cancelled" else "collected", cancel_outcome = outcome, cancel_reason = reason.trim().ifEmpty { null },
            auto_cancelled = auto, cancelled_at = now, given_back = d.given_back + given,
            owed = if (outcome == "refund") (free - given).coerceAtLeast(0) else 0,
            kept = d.kept + if (outcome == "keep") free else 0, noted = d.noted + (note?.amount ?: 0), credit_note_id = note?.id,
        )
        db.withTransaction {
            db.deposits().upsert(listOf(next))
            payRows.forEach { db.deposits().upsertPayments(listOf(it)); drawer(it, d, false) }
            note?.let { db.notes().upsert(listOf(it)) }
            // what nobody collected goes back on the shelf
            val tenant = d.tenant_id
            db.moveStock(store, lines.filter { it.left > 0 }.map { stockLine(tenant, it) to it.left })
            db.outbox().enqueue(op("deposit.cancel", buildJsonObject {
                put("deposit_id", d.id); put("device_id", device); put("device_time", iso(now))
                put("reason", next.cancel_reason ?: ""); put("outcome", outcome); if (auto) put("auto", true)
                staff.approvedBy("sale.refund", approver)?.takeIf { !auto }?.let { put("approved_by", it) }
                put("back", buildJsonArray { payRows.forEach { add(backJson(it)) } })
                note?.let { n -> put("credit_note", buildJsonObject { put("id", n.id); put("number", n.number); put("amount", n.amount); n.valid_to?.let { put("valid_to", it) } }) }
            }))
        }
        pushNow(context)
        next
    }

    // What a cancelled deposit owes, handed over now.
    suspend fun giveBack(depositId: String, back: List<DepositMoney>, approver: StaffMember? = null): Result<DepositEntity> = runCatching {
        val d = db.deposits().deposit(depositId) ?: error("That deposit is gone")
        require(d.owed > 0) { "Nothing is owed on deposit ${d.number}" }
        staff.allow("sale.refund", "give money back", approver)
        val handed = back.filter { it.amount > 0 }
        require(handed.sumOf { it.amount } == d.owed) { "Give back ${Money.format(d.owed)} in all" }
        handed.forEach { checkType(it.paymentTypeId) }
        val device = session.deviceId() ?: error("no device")
        val shift = db.staff().openShift(device) ?: error("Open the day first: money given back comes out of the day's drawer")
        val now = System.currentTimeMillis()
        val rows = handed.map { DepositPaymentEntity(Uuid7.next(), d.id, it.paymentTypeId, "back", -it.amount, null, 0, shift.id, device, staff.id(), now) }
        val next = d.copy(owed = 0, given_back = d.given_back + d.owed)
        db.withTransaction {
            db.deposits().upsert(listOf(next))
            rows.forEach { db.deposits().upsertPayments(listOf(it)); drawer(it, d, false) }
            db.outbox().enqueue(op("deposit.give_back", buildJsonObject {
                put("deposit_id", d.id); put("device_id", device); put("device_time", iso(now))
                staff.approvedBy("sale.refund", approver)?.let { put("approved_by", it) }
                put("back", buildJsonArray { rows.forEach { add(backJson(it)) } })
            }))
        }
        pushNow(context)
        next
    }

    // A tablet working alone cancels by itself, when it opens the day, what is
    // past its date and grace, if the shop says so. A connected tablet never
    // does: the server does, and the tablet takes it with its pull. Returns
    // how many were cancelled.
    suspend fun expireAlone(): Int {
        val s = settings()
        if (!s.alone || !s.retail || s.depositOverdue != "cancel") return 0
        var n = 0
        db.deposits().open().filter { DepositRules.expired(it.collect_by, s.depositGrace) }.forEach { d ->
            if (cancel(d.id, s.depositCancel, "Not collected by ${d.collect_by}", auto = true).isSuccess) n++
        }
        return n
    }

    // ---- paper ----

    // The slip of a deposit as it stands: after it is taken, after a payment,
    // after a cancel. now: this visit's money ("Cash" 500, "Change" 100).
    // A slip that does not print leaves everything as it is: the money moved.
    suspend fun printSlip(depositId: String, title: String, now: List<com.restopos.core.print.DocAmount> = emptyList(), openDrawer: Boolean = false): Result<Unit> = runCatching {
        val d = db.deposits().deposit(depositId) ?: error("That deposit is gone")
        val s = settings()
        val customer = d.customer_id?.let { db.customers().customer(it) }
        val lines = db.deposits().lines(d.id).map { l -> com.restopos.core.print.DocAmount(l.name, Calc.lineAmount(l.unit_price, l.qty), (l.qty / 1000).coerceAtLeast(1)) }
        val note = when (d.cancel_outcome) {
            "credit" -> d.credit_note_id?.let { db.notes().note(it) }?.let { "Cancelled. ${Money.format(it.amount)} is on credit note ${it.number}." } ?: "Cancelled."
            "keep" -> "Cancelled. ${Money.format(d.kept)} is kept by the shop."
            "refund" -> if (d.owed > 0) "Cancelled. ${Money.format(d.owed)} is to be given back." else "Cancelled. ${Money.format(d.given_back)} was given back."
            else -> if (d.status == "collected") "Collected." else null
        }
        docs.printDeposit(com.restopos.core.print.DepositDoc(
            title, d.number, customer?.name, customer?.phone, lines, d.total, d.paid,
            toPay(d), d.collect_by,
            DepositRules.slipSentence(s.depositCancel, s.depositOverdue, s.depositGrace), System.currentTimeMillis(),
            staff.current.value?.employee?.name, now, note,
        ), openDrawer).getOrThrow()
    }

    // A credit note a cancel put the money on, on its own slip, as an exchange's is.
    suspend fun printNote(depositId: String): Result<Unit> = runCatching {
        val d = db.deposits().deposit(depositId) ?: error("That deposit is gone")
        val n = d.credit_note_id?.let { db.notes().note(it) } ?: error("No credit note was made for deposit ${d.number}")
        val customer = n.customer_id?.let { db.customers().customer(it) }
        docs.printNote(com.restopos.core.print.CreditNoteDoc(n.number, n.amount, n.valid_to, customer?.name, d.number, n.created_at, staff.current.value?.employee?.name, fromLabel = "From deposit"))
            .getOrThrow()
    }

    suspend fun paymentName(id: String) = db.ops().paymentType(id)?.name ?: "Paid"
    suspend fun isCash(id: String) = db.ops().paymentType(id)?.kind == "cash"

    // ---- the pieces ----

    private suspend fun checkType(id: String) {
        val t = db.ops().paymentType(id) ?: error("Pick how it is paid")
        require(t.kind !in setOf("exchange", "credit_note", "deposit", "account")) { "Pick another way to pay" }
    }

    // a cash payment in or out is a row of the drawer's, under the payment's own id
    private suspend fun drawer(p: DepositPaymentEntity, d: DepositEntity, inward: Boolean) {
        val kind = db.ops().paymentType(p.payment_type_id)?.kind ?: return
        if (kind != "cash") return
        db.ops().upsertCashMoves(listOf(CashMoveEntity(
            p.id, d.tenant_id, d.store_id, p.device_id ?: d.device_id, p.shift_id, p.employee_id,
            if (inward) "in" else "out", kotlin.math.abs(p.amount), "Deposit ${d.number}", p.device_time, deposit_id = d.id,
        )))
    }

    private fun payJson(p: DepositPaymentEntity) = buildJsonObject {
        put("id", p.id); put("payment_type_id", p.payment_type_id); put("amount", kotlin.math.abs(p.amount))
        p.tendered?.let { put("tendered", it); put("change", p.change) }
        p.shift_id?.let { put("shift_id", it) }
    }
    private fun backJson(p: DepositPaymentEntity) = buildJsonObject {
        put("id", p.id); put("payment_type_id", p.payment_type_id); put("amount", kotlin.math.abs(p.amount))
        p.shift_id?.let { put("shift_id", it) }
    }

    // a deposit line as the shape the shelf mirror moves
    private fun stockLine(tenant: String, l: DepositLineEntity) =
        TicketLineEntity(l.id, tenant, "", l.item_id, l.variant_id.ifEmpty { null }, l.name, l.unit_price, l.qty)
}

package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.database.ReceiptLineEntity
import com.restopos.core.database.ReceiptPaymentEntity
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TicketLineModEntity
import com.restopos.core.database.TicketLineTaxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

data class PayInput(
    val paymentTypeId: String,
    val amount: Long,
    val tendered: Long? = null,
    val change: Long = 0,
    val reference: String? = null,
)

data class DiscountPick(
    val discountId: String? = null,
    val type: String = "amount",
    val value: Long = 0,
    val name: String = "Discount",
)

data class ModPick(val id: String, val name: String, val price: Long)

// Ticket writes (spec 5.2): data row + outbox row in ONE Room transaction,
// then an immediate push when online. Screens never call the network.
// Qty edits void + re-add with a reason (no silent rewrites; sent lines print
// a void slip in Phase 3). Refunds arrive with the Phase 4 manager PIN.
@Singleton
class TicketRepository @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    @ApplicationContext private val context: Context,
) {
    private suspend fun ctx(): Triple<String, String, String> {
        val store = session.storeId() ?: error("no store")
        val device = session.deviceId() ?: error("no device")
        val tenant = session.tenantId() ?: error("no tenant")
        return Triple(tenant, store, device)
    }

    // every op carries who was signed in at the till when it was made
    private fun op(type: String, payload: JsonObject) =
        com.restopos.core.database.OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    suspend fun activeTicket(): TicketEntity? {
        val id = session.activeTicket() ?: return null
        return db.tickets().ticket(id)?.takeIf { it.status == "open" }
    }

    suspend fun ensureTicket(): TicketEntity {
        activeTicket()?.let { return it }
        val (tenant, store, _) = ctx()
        val id = Uuid7.next()
        // the table picked on the floor plan, if this order is for one
        val table = session.pendingTable()
        db.withTransaction {
            db.tickets().upsertTicket(TicketEntity(id, tenant, store, table_id = table, opened_by = staff.id()))
            db.outbox().enqueue(op("ticket.create", buildJsonObject {
                put("id", id); put("store_id", store); table?.let { put("table_id", it) }
            }))
        }
        session.setActiveTicket(id)
        session.setPendingTable(null)
        pushNow(context)
        return db.tickets().ticket(id)!!
    }

    // Parks the current order (it stays open, under Orders) and leaves the
    // register empty. The next item tapped opens a new order.
    suspend fun newTicket() {
        session.clearActiveTicket()
        session.setPendingTable(null)
    }

    // Brings a parked order back onto the register.
    suspend fun select(ticketId: String) {
        if (db.tickets().openTicket(ticketId) != null) {
            session.setActiveTicket(ticketId)
            session.setPendingTable(null)
        }
    }

    // Tapping a table on the floor plan. Its open order comes back onto the
    // register; a free table is remembered, and the order is created on it
    // when the first item is added (so a table opened by mistake leaves
    // nothing behind).
    suspend fun openTable(tableId: String) {
        val open = db.tickets().openTicketForTable(tableId)
        if (open != null) {
            session.setActiveTicket(open.id)
            session.setPendingTable(null)
        } else {
            session.clearActiveTicket()
            session.setPendingTable(tableId)
        }
    }

    // Moves the order on the register to another table.
    suspend fun moveToTable(tableId: String): Result<Unit> = runCatching {
        val t = activeTicket()
        if (t == null) { session.setPendingTable(tableId); return@runCatching }
        db.withTransaction {
            db.tickets().upsertTicket(t.copy(table_id = tableId, updated_at = System.currentTimeMillis()))
            db.outbox().enqueue(op("ticket.update_meta", buildJsonObject { put("ticket_id", t.id); put("table_id", tableId) }))
        }
        pushNow(context)
    }

    // Order details kept on the ticket: tab name, guests, dining option. Same
    // rule as every write: the row and its outbox op in one transaction.
    private suspend fun updateMeta(change: (TicketEntity) -> TicketEntity, payload: JsonObjectBuilder.() -> Unit): Result<Unit> =
        runCatching {
            val t = ensureTicket()
            db.withTransaction {
                db.tickets().upsertTicket(change(t).copy(updated_at = System.currentTimeMillis()))
                db.outbox().enqueue(op("ticket.update_meta", buildJsonObject { put("ticket_id", t.id); payload() }))
            }
            pushNow(context)
        }

    // An empty name clears it (the server does the same).
    suspend fun setName(name: String) = updateMeta({ it.copy(name = name.ifBlank { null }) }) { put("name", name) }
    suspend fun setCovers(guests: Int) = updateMeta({ it.copy(covers = guests) }) { put("covers", guests) }
    suspend fun setDining(optionId: String) = updateMeta({ it.copy(dining_option_id = optionId) }) { put("dining_option_id", optionId) }

    fun openTickets(store: String): Flow<List<TicketEntity>> = db.tickets().openTickets(store)
    fun ticketLines(ticket: String) = db.tickets().lines(ticket)
    fun receipts(store: String) = db.receipts().receipts(store)
    suspend fun receiptPayments(receipt: String) = db.receipts().payments(receipt)

    // Tap item: merge into a same-signature unsent line, else insert with tax
    // snapshots + validated modifier links. Availability is checked; live
    // stock counts arrive with inventory (Phase 9).
    suspend fun addItem(itemId: String, qty: Int, mods: List<ModPick>, note: String?): Result<Unit> =
        runCatching {
            require(qty > 0) { "bad qty" }
            val t = ensureTicket()
            val (tenant, _, _) = ctx()
            val dao = db.catalog()
            val item = dao.item(itemId) ?: error("unknown item")
            require(item.is_available) { "sold out" }
            val taxes = dao.taxesForItem(itemId)
            if (mods.isNotEmpty()) {
                val linked = dao.modifiersForItem(itemId).map { it.id }.toSet()
                mods.forEach { require(linked.contains(it.id)) { "bad modifier" } }
            }
            val modIds = mods.map { it.id }.sorted()
            val lines = db.tickets().lines(t.id).first()
            val match = lines.filter { it.voided_at == null && it.sent_to_kitchen_at == null && it.item_id == itemId && (it.note ?: "") == (note ?: "") }
                .firstOrNull { db.tickets().modIds(it.id).sorted() == modIds }
            if (match != null) {
                setQty(match.id, match.qty + qty, "quantity change")
                return@runCatching
            }
            val lineId = Uuid7.next()
            // What this till charges goes with the line (price, name, each
            // modifier's price), so the server stores the sale as issued even if
            // the catalog changed while the tablet was offline.
            val modArr = buildJsonArray {
                mods.forEach { m ->
                    add(buildJsonObject { put("modifier_id", m.id); put("price", m.price); put("name", m.name) })
                }
            }
            db.withTransaction {
                db.tickets().upsertLines(listOf(
                    TicketLineEntity(lineId, tenant, t.id, itemId, null, item.name, item.price, qty, note),
                ))
                db.tickets().upsertLineMods(mods.map { TicketLineModEntity(lineId, it.id, it.name, it.price) })
                db.catalog().upsertLineTaxes(taxes.map { TicketLineTaxEntity(lineId, it.id, it.rate_bp, it.type) })
                db.outbox().enqueue(op("ticket.add_line", buildJsonObject {
                    put("id", lineId); put("ticket_id", t.id); put("item_id", itemId)
                    put("qty", qty); note?.let { put("note", it) }
                    put("unit_price", item.price); put("name_snapshot", item.name)
                    put("modifiers", modArr)
                }))
            }
            pushNow(context)
        }

    suspend fun setQty(lineId: String, qty: Int, reason: String): Result<Unit> = runCatching {
        require(reason.isNotBlank()) { "reason required" }
        val lines = currentLines()
        val line = lines.firstOrNull { it.id == lineId } ?: error("bad line")
        voidLine(lineId, reason).getOrThrow()
        if (qty > 0) {
            val mods = db.tickets().modIds(lineId).mapNotNull { mid ->
                db.catalog().modifiersForItem(line.item_id ?: return@mapNotNull null).firstOrNull { it.id == mid }
                    ?.let { ModPick(it.id, it.name, it.price) }
            }
            addItem(line.item_id ?: error("bad line"), qty, mods, line.note).getOrThrow()
        }
    }

    suspend fun voidLine(lineId: String, reason: String): Result<Unit> = runCatching {
        require(reason.isNotBlank()) { "reason required" }
        val at = java.time.Instant.now().toString()
        db.withTransaction {
            db.tickets().voidLine(lineId, at, reason)
            db.outbox().enqueue(op("ticket.void_line", buildJsonObject {
                put("line_id", lineId); put("reason", reason)
            }))
        }
        pushNow(context)
    }

    private suspend fun currentLines() =
        db.tickets().lines(activeTicket()?.id ?: error("no ticket")).first()

    // Payment (spec 7.5): one Room txn creates receipt + lines + payments,
    // marks the covered lines paid, bumps the device receipt sequence, and
    // queues the op. coverLineIds defaults to every unpaid line; a split bill
    // names the lines each receipt covers. A receipt settles its lines in
    // full: the server would store a part payment, but flagged for review.
    suspend fun pay(
        payments: List<PayInput>,
        discounts: List<DiscountPick>,
        servicePct: Int = 0,
        coverLineIds: List<String>? = null,
    ): Result<ReceiptEntity> = runCatching {
        // What the server would refuse is refused here, before any money is
        // recorded: a receipt it rejects would leave a payment stranded.
        require(staff.can("payment.take")) { "You are not allowed to take payment" }
        require(discounts.isEmpty() || staff.can("sale.apply_discount")) { "You are not allowed to give a discount" }
        val t = activeTicket() ?: error("no ticket")
        val (tenant, store, deviceId) = ctx()
        val lines = currentLines().filter { it.voided_at == null }
        require(lines.isNotEmpty()) { "empty ticket" }
        val covered = coverLineIds?.toSet() ?: lines.filter { !it.paid }.map { it.id }.toSet()
        val payLines = lines.filter { covered.contains(it.id) && !it.paid }
        require(payLines.isNotEmpty()) { "no lines covered" }
        val calcLines = payLines.map { l ->
            val taxes = db.catalog().lineTaxes(l.id)
            val modSum = db.tickets().modSum(l.id)
            Calc.Line(
                Calc.lineAmount(l.unit_price, l.qty) + modSum,
                taxes.map { Calc.TaxRate(it.rate_bp, it.type) },
            )
        }
        val restricted = HashSet<String>()
        val discPicks = discounts.map { d ->
            if (d.discountId != null) {
                val row = db.catalog().discount(d.discountId) ?: error("bad discount")
                if (row.requires_approval) {
                    // only someone allowed to give it, and they are named on the receipt
                    require(staff.id() != null && staff.can("sale.apply_restricted_discount")) { "${row.name} needs a manager" }
                    restricted.add(row.id)
                }
                Calc.Discount(if (row.type == "percent") row.value.toInt() else null, row.value)
            } else {
                Calc.Discount(if (d.type == "percent") d.value.toInt() else null, d.value)
            }
        }
        val totals = Calc.totals(calcLines, discPicks, servicePct, 0)
        val chunk = payments.sumOf { it.amount }
        require(chunk == totals.total) { "Payment must equal the amount due" }
        // the ticket closes when this receipt leaves no unpaid line behind
        val closing = lines.none { !it.paid && !covered.contains(it.id) }

        val device = db.catalog().device(deviceId) ?: error("no device")
        val storeRow = db.catalog().store(store) ?: error("no store")
        val seq = device.last_receipt_seq + 1
        val number = "${storeRow.code}-${device.code}-${seq.toString().padStart(6, '0')}"
        val receiptId = Uuid7.next()
        val now = System.currentTimeMillis()
        val payArr = buildJsonArray {
            payments.forEach { p ->
                add(buildJsonObject {
                    put("payment_type_id", p.paymentTypeId); put("amount", p.amount)
                    p.tendered?.let { put("tendered", it) }; put("change", p.change)
                    p.reference?.let { put("reference", it) }
                })
            }
        }
        val discArr = buildJsonArray {
            discounts.forEachIndexed { i, d ->
                add(buildJsonObject {
                    d.discountId?.let { put("discount_id", it) }
                    put("type", d.type); put("value", d.value); put("name", d.name)
                    put("amount", totals.discountAmounts[i]) // as charged
                    if (restricted.contains(d.discountId)) staff.id()?.let { put("approved_by", it) }
                })
            }
        }
        val lineArr = buildJsonArray { payLines.forEach { add(it.id) } }
        db.withTransaction {
            db.receipts().insertReceipt(
                ReceiptEntity(receiptId, tenant, store, deviceId, t.id, number,
                    subtotal = totals.subtotal, discount_total = totals.discount,
                    tax_total = totals.tax, service_charge = totals.service, total = totals.total, device_time = now),
            )
            db.receipts().insertLines(payLines.map {
                ReceiptLineEntity(Uuid7.next(), tenant, receiptId, it.name_snapshot, it.unit_price, it.qty)
            })
            db.receipts().insertPayments(payments.map {
                ReceiptPaymentEntity(Uuid7.next(), tenant, receiptId, it.paymentTypeId, it.amount, it.tendered, it.change, it.reference)
            })
            db.tickets().markPaid(payLines.map { it.id })
            if (closing) db.tickets().setStatus(t.id, "paid")
            db.catalog().upsertDevices(listOf(device.copy(last_receipt_seq = seq)))
            db.outbox().enqueue(op("receipt.create", buildJsonObject {
                put("id", receiptId); put("ticket_id", t.id); put("store_id", store)
                put("device_id", deviceId); put("number", number); put("device_seq", seq)
                // when it was sold, by this till's clock; without it the server
                // would date an offline sale by when it arrived
                put("device_time", java.time.Instant.ofEpochMilli(now).toString())
                // the server derives the charge from the percentage; it refuses an amount
                if (servicePct > 0) put("service_pct", servicePct)
                put("payments", payArr); put("discounts", discArr); put("line_ids", lineArr)
            }))
        }
        if (closing) session.clearActiveTicket()
        pushNow(context)
        ReceiptEntity(receiptId, tenant, store, deviceId, t.id, number,
            subtotal = totals.subtotal, discount_total = totals.discount,
            tax_total = totals.tax, service_charge = totals.service, total = totals.total, device_time = now)
    }
}

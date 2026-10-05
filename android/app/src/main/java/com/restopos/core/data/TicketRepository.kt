package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.database.ReceiptLineEntity
import com.restopos.core.database.ReceiptPaymentEntity
import com.restopos.core.database.CustomerEntity
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
import kotlinx.serialization.json.JsonNull
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
    // who approved it, when the person at the register may not give it
    val approvedBy: String? = null,
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
    private val docs: DocBuilder,
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
        val covers = session.pendingCovers()
        // and the order type picked when it was started (Dine in, Take away)
        val type = session.pendingDining()?.let { db.ops().dining(it) }?.takeIf { it.deleted_at == null } ?: if (table != null) dineType() else null
        val dining = type?.id
        val kind = type?.kind ?: if (table != null) "dine" else "counter"
        // An order with no table is known by a short number that counts up
        // through the day. A takeaway or delivery also goes on the board: new,
        // and due when the kitchen has had its time.
        val no = if (table == null) series(kind).let { "$it-${session.nextNumber(it)}" } else null
        val board = kind == "takeaway" || kind == "delivery"
        val due = if (board) System.currentTimeMillis() + PosSettings.parse(db.ops().settings()).prepMinutes * 60_000L * (if (kind == "delivery") 2 else 1) else null
        db.withTransaction {
            db.tickets().upsertTicket(TicketEntity(
                id, tenant, store, table_id = table, dining_option_id = dining, covers = covers, opened_by = staff.id(),
                order_no = no, due_at = due, stage = if (board) "new" else null, source = if (board) "Counter" else null,
            ))
            db.outbox().enqueue(op("ticket.create", buildJsonObject {
                put("id", id); put("store_id", store); table?.let { put("table_id", it) }; covers?.let { put("covers", it) }
                dining?.let { put("dining_option_id", it) }
                no?.let { put("order_no", it) }
                if (board) { put("stage", "new"); put("source", "Counter"); due?.let { put("due_at", java.time.Instant.ofEpochMilli(it).toString()) } }
            }))
        }
        session.setActiveTicket(id)
        session.setPendingTable(null)
        session.setPendingDining(null)
        pushNow(context)
        return db.tickets().ticket(id)!!
    }

    // the letter an order's number starts with
    private fun series(kind: String) = when (kind) { "takeaway" -> "A"; "delivery" -> "D"; else -> "C" }

    // the order type of an order served at a table
    private suspend fun dineType() = db.catalog().diningOptions().let { all ->
        all.firstOrNull { it.kind == "dine" && it.is_default } ?: all.firstOrNull { it.kind == "dine" } ?: all.firstOrNull { it.needs_table }
    }

    // Seating a table: the order is opened there and then, with its guests, so
    // the floor shows the table taken and how long it has been. A table that
    // already has an order gets that order back.
    suspend fun seat(tableId: String, covers: Int): Result<TicketEntity> = runCatching {
        session.setPendingTable(null)
        session.setPendingDining(null)
        db.tickets().openTicketForTable(tableId)?.let { session.setActiveTicket(it.id); return@runCatching it }
        val (tenant, store, _) = ctx()
        val id = Uuid7.next()
        val dining = dineType()?.id
        val row = TicketEntity(id, tenant, store, table_id = tableId, dining_option_id = dining, covers = covers.coerceIn(1, 99), opened_by = staff.id())
        db.withTransaction {
            db.tickets().upsertTicket(row)
            db.outbox().enqueue(op("ticket.create", buildJsonObject {
                put("id", id); put("store_id", store); put("table_id", tableId); put("covers", row.covers)
                dining?.let { put("dining_option_id", it) }
            }))
        }
        session.setActiveTicket(id)
        pushNow(context)
        row
    }

    // Where a takeaway or delivery is on the board, and who is bringing it.
    // Works on an order that is already paid: it is collected later.
    suspend fun setStage(ticketId: String, stage: String, rider: String? = null): Result<Unit> = runCatching {
        db.withTransaction {
            db.service().setStage(ticketId, stage, System.currentTimeMillis())
            if (rider != null) db.service().setRider(ticketId, rider.ifBlank { null })
            db.outbox().enqueue(op("ticket.stage", buildJsonObject { put("ticket_id", ticketId); put("stage", stage); rider?.let { put("rider", it) } }))
        }
        pushNow(context)
    }

    suspend fun setRider(ticketId: String, rider: String): Result<Unit> = runCatching {
        db.withTransaction {
            db.service().setRider(ticketId, rider.ifBlank { null })
            db.outbox().enqueue(op("ticket.stage", buildJsonObject { put("ticket_id", ticketId); put("rider", rider) }))
        }
        pushNow(context)
    }

    // when a takeaway is wanted; moved a few minutes at a time from the board
    suspend fun setDue(ticketId: String, at: Long): Result<Unit> = runCatching {
        db.withTransaction {
            db.service().setDue(ticketId, at)
            db.outbox().enqueue(op("ticket.stage", buildJsonObject { put("ticket_id", ticketId); put("due_at", java.time.Instant.ofEpochMilli(at).toString()) }))
        }
        pushNow(context)
    }

    // The bill was printed for the table (or the table was added to since).
    suspend fun setBill(ticketId: String, at: Long?): Result<Unit> = runCatching {
        val t = db.tickets().openTicket(ticketId) ?: return@runCatching
        if ((t.bill_at == null) == (at == null)) return@runCatching
        db.withTransaction {
            db.service().setBill(ticketId, at)
            db.outbox().enqueue(op("ticket.update_meta", buildJsonObject {
                put("ticket_id", ticketId)
                if (at == null) put("bill_at", JsonNull) else put("bill_at", java.time.Instant.ofEpochMilli(at).toString())
            }))
        }
        pushNow(context)
    }

    // Who a takeaway is for and how to reach them. The name does not take the
    // order off anything: it has no table.
    suspend fun setContact(name: String? = null, phone: String? = null, address: String? = null): Result<Unit> =
        updateMeta({ it.copy(name = if (name != null) name.ifBlank { null } else it.name, phone = if (phone != null) phone.ifBlank { null } else it.phone,
            address = if (address != null) address.ifBlank { null } else it.address) }) {
            name?.let { put("name", it) }; phone?.let { put("phone", it) }; address?.let { put("address", it) }
        }

    // Changes what kind of order this is (counter, takeaway, delivery). One
    // that becomes a takeaway goes on the board; one that stops being one
    // comes off it.
    suspend fun setType(optionId: String): Result<Unit> = runCatching {
        val type = db.ops().dining(optionId) ?: error("That order type is gone")
        val t = activeTicket()
        if (t == null) { session.setPendingDining(optionId); return@runCatching }
        setDining(optionId).getOrThrow()
        val board = type.kind == "takeaway" || type.kind == "delivery"
        val sent = db.tickets().lines(t.id).first().any { it.sent_to_kitchen_at != null }
        // The number's letter says what kind of order it is. One whose kind
        // changes before the kitchen has had anything takes a number of its
        // new kind (C-7 becomes A-3); once the kitchen knows it by a number,
        // or part of it is paid, it keeps that number.
        val letter = series(type.kind)
        if (t.table_id == null && t.order_no?.startsWith("$letter-") == false && !sent && db.receipts().paidForTicket(t.id) == 0L) {
            val no = "$letter-${session.nextNumber(letter)}"
            updateMeta({ it.copy(order_no = no) }) { put("order_no", no) }.getOrThrow()
        }
        // An open order that is a takeaway belongs on the board, also one that
        // was a takeaway, became a counter sale (which took it off) and is a
        // takeaway again. It goes where its kitchen tickets say it is.
        if (board && (t.stage == null || t.stage == "done")) {
            setStage(t.id, if (!sent) "new" else if (db.service().kdsOpenFor(t.id) == 0) "ready" else "kitchen").getOrThrow()
            if (t.due_at == null) {
                setDue(t.id, System.currentTimeMillis() + PosSettings.parse(db.ops().settings()).prepMinutes * 60_000L * (if (type.kind == "delivery") 2 else 1)).getOrThrow()
            }
        }
        if (!board && t.stage != null && t.stage != "done") setStage(t.id, "done").getOrThrow()
    }

    // Parks the current order (it stays open, under Orders) and leaves the
    // register empty. The next item tapped opens a new order.
    suspend fun newTicket() {
        session.clearActiveTicket()
        session.setPendingTable(null)
        session.setPendingDining(null)
    }

    // A new order of a given type: the register is left empty and the type is
    // remembered for when the first item creates the order.
    suspend fun startOrder(diningId: String?) {
        newTicket()
        session.setPendingDining(diningId)
    }

    // Brings a parked order back onto the register.
    suspend fun select(ticketId: String) {
        if (db.tickets().openTicket(ticketId) != null) {
            session.setActiveTicket(ticketId)
            session.setPendingTable(null)
            session.setPendingDining(null)
        }
    }

    // Tapping a table on the floor plan. Its open order comes back onto the
    // register; a free table is remembered, and the order is created on it
    // when the first item is added (so a table opened by mistake leaves
    // nothing behind).
    suspend fun openTable(tableId: String, guests: Int? = null) {
        val open = db.tickets().openTicketForTable(tableId)
        if (open != null) {
            session.setActiveTicket(open.id)
            session.setPendingTable(null)
        } else {
            session.clearActiveTicket()
            session.setPendingTable(tableId, guests)
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

    // The tab name is the order's name, and what the guest's bill will carry.
    // Naming an order makes it a tab of its own: it leaves its table, and the
    // table is free for the next guests. An empty name only clears the name
    // (the server does the same).
    suspend fun setName(name: String): Result<Unit> {
        if (name.isBlank()) return updateMeta({ it.copy(name = null) }) { put("name", name) }
        session.setPendingTable(null) // a table picked but not yet ordered on
        return updateMeta({ it.copy(name = name, table_id = null) }) { put("name", name); put("table_id", JsonNull) }
    }
    suspend fun setCovers(guests: Int) = updateMeta({ it.copy(covers = guests) }) { put("covers", guests) }
    suspend fun setDining(optionId: String) = updateMeta({ it.copy(dining_option_id = optionId) }) { put("dining_option_id", optionId) }
    // a remark for the kitchen and the receipt ("no onions", "collect at 7")
    suspend fun setNote(note: String) = updateMeta({ it.copy(note = note.ifBlank { null }) }) { put("note", note) }
    // hands the order to another waiter
    suspend fun setWaiter(employeeId: String, approvedBy: String? = null) =
        updateMeta({ it.copy(opened_by = employeeId) }) { put("opened_by", employeeId); approvedBy?.let { put("approved_by", it) } }

    // who the order is for; null takes the customer off it
    suspend fun setCustomer(customerId: String?) =
        updateMeta({ it.copy(customer_id = customerId) }) { if (customerId == null) put("customer_id", JsonNull) else put("customer_id", customerId) }

    // An order given up: a table seated by mistake, or an order cancelled once
    // everything on it was taken off. It is closed for good, here and on the
    // server, and lets go of its table and of the board. Nothing is deleted.
    suspend fun cancelOrder(ticketId: String): Result<Unit> = runCatching {
        val t = db.tickets().openTicket(ticketId) ?: return@runCatching
        require(db.tickets().lines(ticketId).first().isEmpty()) { "Take the items off this order first" }
        db.withTransaction {
            db.tickets().upsertTicket(t.copy(status = "cancelled", table_id = null, stage = t.stage?.let { "done" }, updated_at = System.currentTimeMillis()))
            db.outbox().enqueue(op("ticket.cancel", buildJsonObject { put("ticket_id", ticketId) }))
        }
        if (session.activeTicket() == ticketId) session.clearActiveTicket()
        pushNow(context)
    }

    // Moves lines of the order on the register to another seat (null: the
    // table) and/or course. Paid and voided lines stay where they are.
    suspend fun placeLines(lineIds: List<String>, moveSeat: Boolean, seat: Int?, course: Int?): Result<Unit> = runCatching {
        val t = activeTicket() ?: error("No order is open")
        val rows = db.tickets().allLines(t.id).filter { lineIds.contains(it.id) && it.voided_at == null && !it.paid }
        require(rows.isNotEmpty()) { "Pick the items first" }
        db.withTransaction {
            db.tickets().upsertLines(rows.map { it.copy(seat = if (moveSeat) seat else it.seat, course = course ?: it.course) })
            db.outbox().enqueue(op("ticket.place_lines", buildJsonObject {
                put("ticket_id", t.id)
                put("line_ids", buildJsonArray { rows.forEach { add(it.id) } })
                if (moveSeat) { if (seat == null) put("seat", JsonNull) else put("seat", seat) }
                course?.let { put("course", it) }
            }))
        }
        pushNow(context)
    }

    // A customer made or changed on this till. It is on the tablet at once and
    // goes to the server and the other tills from there.
    suspend fun saveCustomer(id: String?, name: String, phone: String, email: String, note: String): Result<CustomerEntity> = runCatching {
        require(name.isNotBlank()) { "Type the customer's name" }
        val (tenant, _, _) = ctx()
        val row = CustomerEntity(id ?: Uuid7.next(), tenant, name.trim().take(120), phone.trim().ifEmpty { null }, email.trim().ifEmpty { null }, note.trim().ifEmpty { null })
        db.withTransaction {
            db.customers().upsert(listOf(row))
            db.outbox().enqueue(op("customer.upsert", buildJsonObject {
                put("id", row.id); put("name", row.name)
                row.phone?.let { put("phone", it) }; row.email?.let { put("email", it) }; row.note?.let { put("note", it) }
            }))
        }
        pushNow(context)
        row
    }

    // The discount picked on the register and waiting for the payment: one of
    // the back office's, or one typed in ("custom:percent:10").
    // Whoever approved it follows an "@".
    suspend fun pendingDiscount(): DiscountPick? {
        val raw = session.pendingDiscount() ?: return null
        // kept with the order it was picked on: another order does not get it
        val saved = if (raw.contains('#')) { if (raw.substringBefore('#') != session.activeTicket()) return null; raw.substringAfter('#') } else raw
        val v = saved.substringBefore('@')
        val by = saved.substringAfter('@', "").ifEmpty { null }
        if (v.startsWith("custom:")) {
            val parts = v.split(':')
            val value = parts.getOrNull(2)?.toLongOrNull() ?: return null
            val percent = parts.getOrNull(1) == "percent"
            return DiscountPick(null, if (percent) "percent" else "amount", value, if (percent) "$value%" else com.restopos.core.common.Money.format(value), by)
        }
        return db.catalog().discount(v)?.takeIf { it.deleted_at == null }?.let { DiscountPick(it.id, it.type, it.value, it.name, by) }
    }
    suspend fun setPendingDiscount(d: DiscountPick?) {
        session.setPendingDiscount(d?.let { (session.activeTicket()?.let { t -> "$t#" } ?: "") + (it.discountId ?: "custom:${it.type}:${it.value}") + (it.approvedBy?.let { by -> "@$by" } ?: "") })
    }

    // Whether a member of staff, by id, may do something: for an approval
    // given earlier (a discount picked on the register, used at payment).
    private suspend fun may(employeeId: String?, permission: String): Boolean {
        val e = employeeId?.let { db.staff().employee(it) }?.takeIf { it.is_active && it.deleted_at == null } ?: return false
        val perms = e.role_id?.let { db.staff().role(it) }?.takeIf { it.deleted_at == null }?.permissions ?: return false
        return perms.contains("\"*\"") || perms.contains("\"$permission\"")
    }

    fun openTickets(store: String): Flow<List<TicketEntity>> = db.tickets().openTickets(store)
    fun ticketLines(ticket: String) = db.tickets().lines(ticket)
    fun receipts(store: String) = db.receipts().receipts(store)
    suspend fun receiptPayments(receipt: String) = db.receipts().payments(receipt)

    // Tap item: merge into a same-signature unsent line, else insert with tax
    // snapshots + validated modifier links. Availability is checked; live
    // stock counts arrive with inventory (Phase 9).
    // course: which course of the meal the line belongs to (table service), or
    // null on an order that is not split into courses.
    // again: the line is one already on the order being put back with another
    // quantity, so what was true when it was rung up (the item was on sale,
    // its options were offered) is not asked a second time.
    suspend fun addItem(itemId: String, qty: Int, mods: List<ModPick>, note: String?, course: Int? = null, seat: Int? = null, again: Boolean = false): Result<Unit> =
        runCatching {
            require(qty > 0) { "bad qty" }
            val t = ensureTicket()
            val (tenant, _, _) = ctx()
            val dao = db.catalog()
            val item = dao.item(itemId) ?: error("unknown item")
            require(item.is_available || again) { "${item.name} is sold out" }
            val taxes = dao.taxesForItem(itemId)
            if (mods.isNotEmpty() && !again) {
                val linked = dao.modifiersForItem(itemId).map { it.id }.toSet()
                mods.forEach { require(linked.contains(it.id)) { "bad modifier" } }
            }
            val modIds = mods.map { it.id }.sorted()
            val lines = db.tickets().lines(t.id).first()
            val match = lines.filter { it.voided_at == null && it.sent_to_kitchen_at == null && it.item_id == itemId && (it.note ?: "") == (note ?: "") && it.course == course && it.seat == seat }
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
                    TicketLineEntity(lineId, tenant, t.id, itemId, null, item.name, item.price, qty, note, course, seat = seat),
                ))
                db.tickets().upsertLineMods(mods.map { TicketLineModEntity(lineId, it.id, it.name, it.price) })
                db.catalog().upsertLineTaxes(taxes.map { TicketLineTaxEntity(lineId, it.id, it.rate_bp, it.type) })
                db.outbox().enqueue(op("ticket.add_line", buildJsonObject {
                    put("id", lineId); put("ticket_id", t.id); put("item_id", itemId)
                    put("qty", qty); note?.let { put("note", it) }; course?.let { put("course", it) }; seat?.let { put("seat", it) }
                    put("unit_price", item.price); put("name_snapshot", item.name)
                    put("modifiers", modArr)
                }))
            }
            if (t.bill_at != null) setBill(t.id, null)
            pushNow(context)
        }

    suspend fun setQty(lineId: String, qty: Int, reason: String): Result<Unit> = runCatching {
        val lines = currentLines()
        val line = lines.firstOrNull { it.id == lineId } ?: error("bad line")
        val itemId = line.item_id ?: error("bad line")
        // Everything that could refuse the new line is checked before the old
        // one comes off: more of something that has run out is refused here,
        // and fewer of it is always allowed.
        val item = db.catalog().item(itemId) ?: error("unknown item")
        require(qty <= line.qty || item.is_available) { "${item.name} is sold out" }
        // its options as they were rung up, at the prices charged then
        val mods = db.tickets().lineMods(lineId).map { ModPick(it.modifier_id, it.name_snapshot, it.price) }
        voidLine(lineId, reason).getOrThrow()
        if (qty > 0) addItem(itemId, qty, mods, line.note, line.course, line.seat, again = true).getOrThrow()
    }

    // Split check: takes `units` off a line and puts them on a new line of the
    // same order, on the check given. Same item, price, note, course, taxes
    // and kitchen state: nothing is voided and nothing goes to the kitchen
    // again. A line with a priced add-on is not divided (the add-on is charged
    // once per line); it moves whole.
    suspend fun splitLine(lineId: String, units: Int, toCheck: Int): Result<String> = runCatching {
        val line = db.tickets().line(lineId) ?: error("That line is gone")
        require(!line.paid && line.voided_at == null) { "That line cannot be divided" }
        require(line.qty % 1000 == 0 && units >= 1 && units * 1000 < line.qty) { "Pick fewer than the line has" }
        require(db.tickets().modSum(lineId) == 0L) { "This line has an add-on that is charged once. Move the whole line instead." }
        val newId = Uuid7.next()
        db.withTransaction {
            db.tickets().setQty(lineId, line.qty - units * 1000)
            db.tickets().upsertLines(listOf(line.copy(id = newId, qty = units * 1000, server_seq = null, check_no = toCheck)))
            db.tickets().upsertLineMods(db.tickets().lineMods(lineId).map { it.copy(line_id = newId) })
            db.catalog().upsertLineTaxes(db.catalog().lineTaxes(lineId).map { it.copy(line_id = newId) })
            db.outbox().enqueue(op("ticket.split_line", buildJsonObject {
                put("line_id", lineId); put("new_id", newId); put("qty", units * 1000)
            }))
        }
        pushNow(context)
        newId
    }

    // No reason is asked for: "void" stands in when none is given.
    suspend fun voidLine(lineId: String, reason: String, approvedBy: String? = null): Result<Unit> = runCatching {
        val why = reason.ifBlank { "void" }
        val at = java.time.Instant.now().toString()
        db.withTransaction {
            db.tickets().voidLine(lineId, at, why)
            db.outbox().enqueue(op("ticket.void_line", buildJsonObject {
                put("line_id", lineId); put("reason", why)
                approvedBy?.let { put("approved_by", it) }
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
        // a discount needs someone allowed to give it: the person paying, or whoever approved it on the register
        val approver = discounts.firstNotNullOfOrNull { it.approvedBy }
        require(discounts.isEmpty() || staff.can("sale.apply_discount") || may(approver, "sale.apply_discount")) { "You are not allowed to give a discount" }
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
                    require((staff.id() != null && staff.can("sale.apply_restricted_discount")) || may(d.approvedBy, "sale.apply_restricted_discount")) { "${row.name} needs a manager" }
                    restricted.add(row.id)
                }
                Calc.Discount(if (row.type == "percent") row.value.toInt() else null, row.value)
            } else {
                Calc.Discount(if (d.type == "percent") d.value.toInt() else null, d.value)
            }
        }
        val totals = Calc.totalsRounded(calcLines, discPicks, servicePct)
        val chunk = payments.sumOf { it.amount }
        require(chunk == totals.total) { "Payment must equal the amount due" }
        // the ticket closes when this receipt leaves no unpaid line behind
        val closing = lines.none { !it.paid && !covered.contains(it.id) }

        val device = db.catalog().device(deviceId) ?: error("no device")
        val storeRow = db.catalog().store(store) ?: error("no store")
        val seq = device.last_receipt_seq + 1
        // "Start again each day": the bill is numbered within its day closing,
        // with the closing's number in front so no two bills ever share one.
        val settings = PosSettings.parse(db.ops().settings())
        val daySeq = session.periodSeq() + 1
        val number = if (settings.billReset) {
            val closing = (db.ops().lastDayClose(deviceId)?.number ?: 0) + 1
            "${storeRow.code}-${device.code}-${closing.toString().padStart(4, '0')}-${daySeq.toString().padStart(4, '0')}"
        } else {
            "${storeRow.code}-${device.code}-${seq.toString().padStart(6, '0')}"
        }
        val receiptId = Uuid7.next()
        val now = System.currentTimeMillis()
        val types = db.ops().allPaymentTypes().associateBy { it.id }
        // what the receipt prints, kept with it so a reprint is the same paper
        val doc = docs.encode(docs.receipt(
            "receipt", t, payLines, totals,
            discounts.mapIndexed { i, d -> com.restopos.core.print.DocAmount(d.name, totals.discountAmounts[i]) }.filter { it.amount > 0 },
            payments.map { com.restopos.core.print.DocPayment(types[it.paymentTypeId]?.name ?: "Paid", it.amount, it.tendered, it.change, it.reference) },
            number, now,
        ))
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
                    if (restricted.contains(d.discountId)) {
                        (d.approvedBy?.takeIf { !staff.can("sale.apply_restricted_discount") } ?: staff.id())?.let { put("approved_by", it) }
                    }
                })
            }
        }
        val lineArr = buildJsonArray { payLines.forEach { add(it.id) } }
        db.withTransaction {
            db.receipts().insertReceipt(
                ReceiptEntity(receiptId, tenant, store, deviceId, t.id, number,
                    subtotal = totals.subtotal, discount_total = totals.discount,
                    tax_total = totals.tax, service_charge = totals.service, rounding = totals.rounding, total = totals.total,
                    device_time = now, doc = doc),
            )
            db.receipts().insertLines(payLines.map {
                ReceiptLineEntity(Uuid7.next(), tenant, receiptId, it.name_snapshot, it.unit_price, it.qty, it.id)
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
                if (totals.rounding != 0L) put("rounding", totals.rounding)
                put("payments", payArr); put("discounts", discArr); put("line_ids", lineArr)
                if (discounts.isNotEmpty() && !staff.can("sale.apply_discount")) approver?.let { put("approved_by", it) }
            }))
        }
        session.setPeriodSeq(daySeq)
        if (closing) session.clearActiveTicket()
        pushNow(context)
        ReceiptEntity(receiptId, tenant, store, deviceId, t.id, number,
            subtotal = totals.subtotal, discount_total = totals.discount,
            tax_total = totals.tax, service_charge = totals.service, rounding = totals.rounding, total = totals.total,
            device_time = now, doc = doc)
    }
}

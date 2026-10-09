package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.PinHash
import com.restopos.core.common.Uuid7
import com.restopos.core.database.BookingEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import com.restopos.core.network.ApiError
import com.restopos.core.network.AuthRequired
import com.restopos.core.network.dto.OutboxOp
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.mapLatest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import javax.inject.Inject
import javax.inject.Singleton

// A line as the screens show it: with its add-ons spelled out and what it comes to.
data class LineInfo(val line: TicketLineEntity, val mods: String, val amount: Long) {
    val units: Int get() = (line.qty + 500) / 1000
    // add-ons and the kitchen note on one line
    val detail: String get() = listOfNotNull(mods.ifBlank { null }, line.note?.ifBlank { null }).joinToString(" · ")
}

// An order that is still being served: open on a table or at the counter, or
// a takeaway that is paid and waiting to be collected.
data class OrderInfo(
    val ticket: TicketEntity,
    val kind: String, // dine | counter | takeaway | delivery | tab
    val typeName: String,
    val table: TableEntity?,
    val lines: List<LineInfo>,
    val due: Long, // what is still to pay, service charge included
    val waiter: String?,
) {
    val id: String get() = ticket.id
    val open: Boolean get() = ticket.status == "open"
    val openedAt: Long get() = Uuid7.millis(ticket.id) ?: ticket.updated_at
    val units: Int get() = lines.sumOf { it.units }
    val unsent: Int get() = lines.filter { it.line.sent_to_kitchen_at == null && !it.line.paid }.sumOf { it.units }
    val paid: Boolean get() = lines.isNotEmpty() && lines.all { it.line.paid }
    val total: Long get() = lines.sumOf { it.amount }
    // what the floor and the kitchen call it: the table, else its number
    val label: String get() = table?.name ?: ticket.order_no ?: ticket.name ?: "—"
}

// What the service screens share: the orders in progress with their totals,
// the bookings, and what may be sold. Reads are Flows from Room; every write
// is the row and its outbox op in one transaction, like the rest of the till.
@OptIn(ExperimentalCoroutinesApi::class)
@Singleton
class ServiceRepository @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val api: ApiClient,
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    // The service charge an order carries, in basis points: the back office's
    // percentage on orders served at a table, nothing on the others.
    suspend fun servicePct(t: TicketEntity?): Int {
        val pct = PosSettings.parse(db.ops().settings()).servicePct
        if (pct <= 0 || t == null) return 0
        val kind = t.dining_option_id?.let { db.ops().dining(it)?.kind } ?: if (t.table_id != null) "dine" else "counter"
        return if (kind == "dine") pct * 100 else 0
    }

    // Lines with their add-ons and amounts, for any number of orders at once.
    suspend fun describe(rows: List<TicketLineEntity>): List<LineInfo> {
        if (rows.isEmpty()) return emptyList()
        val sums = HashMap<String, Long>()
        val texts = HashMap<String, String>()
        rows.map { it.id }.chunked(800).forEach { ids ->
            db.service().modSums(ids).forEach { sums[it.line_id] = it.total }
            db.service().modTexts(ids).forEach { texts[it.line_id] = it.text ?: "" }
        }
        return rows.map { LineInfo(it, texts[it.id] ?: "", Calc.lineAmount(it.unit_price, it.qty) + (sums[it.id] ?: 0)) }
    }

    // What is still to pay on a set of lines, as the receipt will come to.
    suspend fun dueOf(lines: List<LineInfo>, servicePct: Int, discount: DiscountPick? = null): Calc.Totals {
        val unpaid = lines.filter { !it.line.paid && it.line.voided_at == null }
        val taxes = HashMap<String, MutableList<Calc.TaxRate>>()
        unpaid.map { it.line.id }.chunked(800).forEach { ids ->
            db.service().taxesOf(ids).forEach { taxes.getOrPut(it.line_id) { ArrayList() }.add(Calc.TaxRate(it.rate_bp, it.type)) }
        }
        return Calc.totalsRounded(
            unpaid.map { Calc.Line(it.amount, taxes[it.line.id].orEmpty()) },
            listOfNotNull(discount?.let { Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value) }),
            servicePct,
        )
    }

    // Every order in progress in this store, newest first.
    fun orders(store: String): Flow<List<OrderInfo>> = combine(
        db.tickets().openTickets(store), db.service().board(store), db.service().liveLines(store), db.tables().tables(store), db.ops().settingsFlow(),
    ) { open, board, lines, tables, settings -> Quad(open + board.filter { b -> open.none { it.id == b.id } }, lines, tables, settings) }
        .mapLatest { (ts, rows, tables, settings) ->
            val pct = PosSettings.parse(settings).servicePct
            val types = db.catalog().diningOptions().associateBy { it.id }
            val tableById = tables.associateBy { it.id }
            val names = HashMap<String, String?>()
            val info = describe(rows).groupBy { it.line.ticket_id }
            ts.map { t ->
                val type = t.dining_option_id?.let { types[it] ?: db.ops().dining(it) }
                val kind = type?.kind ?: if (t.table_id != null) "dine" else "counter"
                val mine = info[t.id].orEmpty()
                val waiter = t.opened_by?.let { id -> names.getOrPut(id) { db.staff().employee(id)?.name } }
                OrderInfo(
                    t, kind, type?.name ?: if (kind == "dine") "Dine-in" else "Counter", t.table_id?.let { tableById[it] }, mine,
                    dueOf(mine, if (kind == "dine") pct * 100 else 0).total, waiter,
                )
            }
        }

    private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)

    // ---- bookings ----
    private fun dayStart(): Long = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli()
    fun bookingsToday(store: String): Flow<List<BookingEntity>> = dayStart().let { from -> db.service().bookings(store, from, from + 24 * 3_600_000L) }

    suspend fun saveBooking(row: BookingEntity): Result<BookingEntity> = runCatching {
        require(row.name.isNotBlank()) { "Type the name the table is booked under" }
        require(row.size in 1..99) { "How many guests?" }
        db.withTransaction {
            db.service().upsertBookings(listOf(row))
            db.outbox().enqueue(op("booking.upsert", buildJsonObject {
                put("id", row.id); put("store_id", row.store_id); put("booked_for", Instant.ofEpochMilli(row.booked_for).toString())
                put("name", row.name.trim()); put("size", row.size); put("status", row.status)
                put("phone", row.phone ?: ""); put("area", row.area ?: ""); put("tags", row.tags ?: "")
                if (row.table_id == null) put("table_id", JsonNull) else put("table_id", row.table_id)
                row.ticket_id?.let { put("ticket_id", it) }
            }))
        }
        pushNow(context)
        row
    }

    suspend fun newBooking(at: Long, name: String, size: Int, phone: String, area: String?, tags: String): Result<BookingEntity> {
        val store = session.storeId() ?: return Result.failure(IllegalStateException("This tablet is not set up"))
        val tenant = session.tenantId() ?: ""
        return saveBooking(BookingEntity(
            Uuid7.next(), tenant, store, at, name.trim().take(120), size, phone.trim().ifEmpty { null }, area?.ifBlank { null },
            null, tags.trim().ifEmpty { null }, "confirmed",
        ))
    }

    suspend fun changeBooking(id: String, change: (BookingEntity) -> BookingEntity): Result<BookingEntity> {
        val row = db.service().booking(id) ?: return Result.failure(IllegalStateException("That booking is gone"))
        return saveBooking(change(row))
    }

    // ---- what may be sold ----
    // Sold out, or back on sale. Someone who may edit the menu, or who was
    // given this alone; anyone else asks for one of them.
    suspend fun setAvailable(itemId: String, on: Boolean, approver: StaffMember? = null): Result<Unit> = runCatching {
        val mine = staff.can("items.availability") || staff.can("items.edit")
        val theirs = approver?.let { it.can("items.availability") || it.can("items.edit") } == true
        if (!mine && !theirs) throw NeedsApproval("items.availability", "mark an item sold out or back on sale")
        db.withTransaction {
            db.service().setAvailable(itemId, on)
            db.outbox().enqueue(op("item.set_available", buildJsonObject {
                put("item_id", itemId); put("available", on)
                if (!mine) approver?.employee?.id?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
    }

    // An item made or changed from the till (its name, its price or that its
    // price is typed at the sale, its category, its barcode, whether it is on
    // sale), by someone allowed to edit the menu or with their approval.
    //
    // Unlike a sale it is not queued: it goes to the server now and its answer
    // is waited for, so it needs a connection. An item that was queued and
    // then refused (its barcode is another item's) would take every sale that
    // named it down with it. Once the server has it, a sync brings it onto
    // this till, and the others have it at their next.
    // Returns the item's id.
    // countStock: whether its stock is counted, when the sheet says; null leaves it as it is.
    suspend fun saveItem(id: String?, item: ItemForm.Item, categoryId: String?, available: Boolean, shop: Boolean, approver: StaffMember? = null, countStock: Boolean? = null): Result<String> = runCatching {
        staff.allow("items.edit", if (shop) "change the products" else "change the menu", approver)
        val itemId = id ?: Uuid7.next()
        ask("item.save", { ItemForm.refused(it, shop) }, buildJsonObject {
            put("id", itemId); put("name", item.name); put("price", item.price); put("open_price", item.open)
            put("category_id", categoryId ?: ""); put("barcode", item.barcode ?: ""); put("available", available)
            countStock?.let { put("track_stock", it) }
            staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
        })
        itemId
    }

    // Removed from the menu, the same way. Receipts that sold it keep its name.
    suspend fun removeItem(itemId: String, shop: Boolean, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", if (shop) "change the products" else "change the menu", approver)
        ask("item.remove", { ItemForm.refused(it, shop) }, buildJsonObject {
            put("item_id", itemId)
            staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
        })
    }

    // A category made or changed from the till: its name and its colour. Its
    // printers, its place and whether its stock is counted are the back
    // office's, and the server leaves them as they are. Asked now and waited
    // for, as an item is. Returns the category's id.
    suspend fun saveCategory(id: String?, category: CategoryForm.Category, shop: Boolean, approver: StaffMember? = null): Result<String> = runCatching {
        staff.allow("items.edit", if (shop) "change the products" else "change the menu", approver)
        val categoryId = id ?: Uuid7.next()
        ask("category.save", CategoryForm::refused, buildJsonObject {
            put("id", categoryId); put("name", category.name); put("color", category.color ?: "")
            staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
        })
        categoryId
    }

    // Removed, the same way. The server refuses while items are in it.
    suspend fun removeCategory(categoryId: String, shop: Boolean, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", if (shop) "change the products" else "change the menu", approver)
        ask("category.remove", CategoryForm::refused, buildJsonObject {
            put("category_id", categoryId)
            staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
        })
    }

    // Stock put in or taken out in this till's store, by someone allowed to
    // adjust stock or with their approval; the reason need not be given.
    // Asked now and waited for: the server holds the floor (no more out than
    // there is) and only it knows what the other tills have sold.
    // left: what this till believes is there, for the words of a refusal.
    suspend fun adjustStock(itemId: String, variantId: String?, units: Int, way: StockForm.Way, reason: String?, shop: Boolean, left: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("stock.adjust", "change stock", approver)
        val store = session.storeId() ?: error("This till is not set up for a store yet.")
        ask("stock.adjust", { StockForm.refused(it, shop, left) }, buildJsonObject {
            put("store_id", store); put("item_id", itemId); put("variant_id", variantId ?: "")
            put("units", units); put("direction", way.code); put("reason", reason ?: "")
            staff.approvedBy("stock.adjust", approver)?.let { put("approved_by", it) }
        })
    }

    // ---- the first-run set-up (server 0089) ----
    // What a new business is walked through on its tablet, beyond its menu:
    // its tables, its printer, its details and its staff's PINs. Each is asked
    // now and waited for, as an item is, and a sync brings the row. Who it is
    // made by is ask's own rule: the person signed in, or the login that set
    // the tablet up when nobody is. The ids are the caller's, minted when its
    // form opened, so a second try after a lost answer sends the same ones and
    // the server makes nothing twice.

    // The tables of one new room. ids: one for each table, in order.
    suspend fun addTables(room: String, tables: List<TableLayout.Table>, ids: List<String>, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "set this till up", approver)
        val store = session.storeId() ?: error("This till is not set up for a store yet.")
        ask("tables.add", ::tablesRefused, buildJsonObject {
            put("store_id", store); put("area", room)
            putJsonArray("tables") {
                tables.forEachIndexed { i, t ->
                    addJsonObject {
                        put("id", ids[i]); put("name", t.name); put("seats", t.seats); put("shape", "square")
                        put("x", t.x); put("y", t.y); put("w", t.w); put("h", t.h)
                    }
                }
            }
            staff.approvedBy("settings.device", approver)?.let { put("approved_by", it) }
        })
    }

    // The server's refusal of tables.add, in words.
    private fun tablesRefused(code: String?): String = when (code) {
        "room-exists" -> "There is already a room of that name."
        "name-taken" -> "A table already has one of those numbers. Close this and try again."
        "too-many" -> "A store holds 300 tables at most."
        "bad-store" -> "This till's store is no longer there."
        "conflict" -> "That did not work. Close this and try again."
        "forbidden" -> "You are not allowed to set up tables. Ask a manager."
        "unknown-op" -> "The server has to be updated before tables can be added from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }

    // A printer made, or its name, connection and paper changed.
    // onePrinter: whether kitchen orders print on it too; null leaves that as it is.
    suspend fun savePrinter(id: String, p: PrinterForm.Printer, onePrinter: Boolean?, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "set this till up", approver)
        val store = session.storeId() ?: error("This till is not set up for a store yet.")
        ask("printer.save", PrinterForm::refused, buildJsonObject {
            put("id", id); put("store_id", store); put("name", p.name); put("kind", p.kind)
            put("address", p.address ?: ""); put("paper_mm", p.paper)
            onePrinter?.let { put("one_printer", it) }
            staff.approvedBy("settings.device", approver)?.let { put("approved_by", it) }
        })
    }

    // What prints at the top of every receipt.
    suspend fun saveCompany(c: CompanyForm.Company, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "set this till up", approver)
        ask("company.save", CompanyForm::refused, buildJsonObject {
            put("name", c.name); put("address", c.address); put("phone", c.phone); put("brn", c.brn); put("vat", c.vat)
            staff.approvedBy("settings.device", approver)?.let { put("approved_by", it) }
        })
    }

    // A member of staff with no login, and their PIN. The PIN is hashed here
    // and only the hash is sent. Only someone who may manage staff: the owner.
    suspend fun addStaff(id: String, name: String, roleId: String, pin: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("employees.edit", "add staff or set a PIN", approver)
        val hash = withContext(Dispatchers.Default) { PinHash.make(pin) }
        ask("staff.save", StaffForm::refused, buildJsonObject {
            put("id", id); put("name", name); put("role_id", roleId); put("pin_hash", hash)
            staff.approvedBy("employees.edit", approver)?.let { put("approved_by", it) }
        })
    }

    suspend fun setPin(employeeId: String, pin: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("employees.edit", "add staff or set a PIN", approver)
        val hash = withContext(Dispatchers.Default) { PinHash.make(pin) }
        ask("staff.set_pin", StaffForm::refused, buildJsonObject {
            put("employee_id", employeeId); put("pin_hash", hash)
            staff.approvedBy("employees.edit", approver)?.let { put("approved_by", it) }
        })
    }

    // "Open the till": the set-up is finished, for every tablet of the
    // business. Queued like a sale and not waited for; this tablet remembers
    // it at once, so its start screen stops offering the set-up.
    suspend fun finishSetup(approver: StaffMember? = null) {
        db.outbox().enqueue(op("setup.finish", buildJsonObject {
            staff.approvedBy("settings.device", approver)?.let { put("approved_by", it) }
        }))
        session.setSetupClosed(true)
        pushNow(context)
    }

    // One op sent now, outside the outbox, and its answer waited for.
    // refused: the server's code for why not, in the words of whoever asked.
    private suspend fun ask(type: String, refused: (String?) -> String, payload: JsonObject) {
        val answer = try {
            api.push(listOf(OutboxOp(Uuid7.next(), type, payload, staff.id()))).firstOrNull()
        } catch (e: java.io.IOException) {
            error("This needs a connection: the server has to answer first. Try again when the tablet is online.")
        } catch (e: AuthRequired) {
            error("This tablet has to be signed in again before the menu can be changed from it.")
        } catch (e: ApiError) {
            error(if (e.status == ApiClient.UPDATE_REQUIRED) "This till has to be updated first." else "The server could not do that just now. Try again in a moment.")
        }
        when (answer?.status) {
            "applied" -> SyncScheduler.pullNow(context)
            "rejected" -> error(refused(answer.code))
            else -> error("The server is busy. Try again in a moment.")
        }
    }

    // An item's price, changed from the till by someone allowed to edit the
    // menu, or with their approval. It is on this tablet at once and on the
    // others when they next sync; the server writes down who changed it, from
    // what to what. Orders already open keep the price each line was rung up
    // at: a line carries its own.
    suspend fun setPrice(itemId: String, price: Long, approver: StaffMember? = null): Result<Unit> = runCatching {
        require(price in 0..100_000_000L) { "That is not a price" }
        staff.allow("items.edit", "change a price", approver)
        val item = db.catalog().item(itemId) ?: error("That item is gone")
        if (item.price == price) return@runCatching
        db.withTransaction {
            db.service().setPrice(itemId, price)
            db.outbox().enqueue(op("item.set_price", buildJsonObject {
                put("item_id", itemId); put("price", price)
                staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
    }

    // One variant's price, the same way (a shop's Products & stock screen).
    suspend fun setVariantPrice(itemId: String, variantId: String, price: Long, approver: StaffMember? = null): Result<Unit> = runCatching {
        require(price in 0..100_000_000L) { "That is not a price" }
        staff.allow("items.edit", "change a price", approver)
        val v = db.retail().variant(variantId)?.takeIf { it.item_id == itemId && it.deleted_at == null } ?: error("That variant is gone")
        if (v.price == price) return@runCatching
        db.withTransaction {
            db.retail().setVariantPrice(variantId, price)
            db.outbox().enqueue(op("item.set_price", buildJsonObject {
                put("item_id", itemId); put("variant_id", variantId); put("price", price)
                staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
    }
}

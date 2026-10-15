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
import com.restopos.core.database.TillLogEntity
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
import kotlinx.coroutines.flow.first
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

// What an item's sheet needs for its second page (ServiceRepository.itemMore).
class ItemMore(
    val taxes: List<com.restopos.core.database.TaxEntity>, val taxId: String?,
    val suppliers: List<com.restopos.core.database.SupplierEntity>,
    val reorder: Int?, val orderQty: Int?, val mayCost: Boolean, val variants: Boolean,
    // the add-on groups there are, and the ones the item carries
    val groups: List<com.restopos.core.database.ModifierGroupEntity> = emptyList(), val groupIds: Set<String> = emptySet(),
)

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
    // more: the sheet's second page (its tax, and a shop's cost, SKU, brand, supplier and reorder level), when the sheet had one.
    suspend fun saveItem(id: String?, item: ItemForm.Item, categoryId: String?, available: Boolean, shop: Boolean, approver: StaffMember? = null, countStock: Boolean? = null, more: ItemForm.More? = null): Result<String> = runCatching {
        staff.allow("items.edit", if (shop) "change the products" else "change the menu", approver)
        val itemId = id ?: Uuid7.next()
        ask("item.save", { ItemForm.refused(it, shop) }, OfficePayloads.itemSave(itemId, item, categoryId, available, countStock, more, session.storeId(), staff.approvedBy("items.edit", approver)))
        itemId
    }

    // What the sheet's second page starts from: the taxes to pick from and
    // the item's own (a new one starts on the usual tax), a shop's suppliers,
    // the reorder figures of this till's store, and whether the person signed
    // in may see cost. itemId: null for a new item.
    suspend fun itemMore(itemId: String?): ItemMore {
        val taxes = db.catalog().taxes().first()
        // an item that carries no tax is not given one by being opened
        val own = ItemForm.startTax(itemId == null, itemId?.let { db.catalog().taxesForItem(it).firstOrNull()?.id }, taxes.firstOrNull()?.id)
        val store = session.storeId()
        val level = if (itemId != null && store != null) db.retail().levelsOf(store, itemId).firstOrNull() else null
        return ItemMore(
            taxes, own, db.stock().suppliers().first(), level?.reorder_point, level?.reorder_qty,
            mayCost = staff.can("costs.view"), variants = itemId != null && db.retail().variantsOf(itemId).any { it.deleted_at == null },
            groups = db.catalog().groupsFlow().first(), groupIds = itemId?.let { db.alone().groupsOf(it).toSet() } ?: emptySet(),
        )
    }

    // A tax made or changed from the till (server 0094), by someone allowed
    // to edit the menu or with their approval. Asked now and waited for, as
    // an item is. id: made when the sheet opened, so a second try after a
    // lost answer sends the same one.
    suspend fun saveTax(id: String, tax: TaxForm.Tax, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "change the taxes", approver)
        ask("tax.save", TaxForm::refused, OfficePayloads.taxSave(id, tax, staff.approvedBy("items.edit", approver)))
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
    // printerIds: the printers its orders print on, when the sheet changed them (server 0098); null leaves them as they are.
    suspend fun saveCategory(id: String?, category: CategoryForm.Category, shop: Boolean, approver: StaffMember? = null, printerIds: List<String>? = null): Result<String> = runCatching {
        staff.allow("items.edit", if (shop) "change the products" else "change the menu", approver)
        val categoryId = id ?: Uuid7.next()
        ask("category.save", CategoryForm::refused, buildJsonObject {
            put("id", categoryId); put("name", category.name); put("color", category.color ?: "")
            printerIds?.let { ids -> putJsonArray("printer_ids") { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } } }
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

    // ---- the floor plan, changed on a till (server 0101) ----
    // What the back office's floor plan page does, for a restaurant that has
    // none. One room as its plan stands when Save is pressed: the whole room
    // is one change, so a second try after a lost answer leaves what the
    // first left.
    suspend fun saveFloor(
        room: String, tables: List<FloorPlan.Table>, removed: List<String>,
        elements: List<FloorPlan.Element>, removedElements: List<String>, approver: StaffMember? = null,
    ): Result<Unit> = runCatching {
        staff.allow("settings.device", "change the floor plan", approver)
        val store = session.storeId() ?: error("This till is not set up for a store yet.")
        ask("floor.save", ::floorRefused, FloorPlan.save(store, room, tables, removed, elements, removedElements, staff.approvedBy("settings.device", approver)))
    }

    suspend fun renameRoom(from: String, to: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "change the floor plan", approver)
        val store = session.storeId() ?: error("This till is not set up for a store yet.")
        ask("room.rename", ::floorRefused, FloorPlan.rename(store, from, to, staff.approvedBy("settings.device", approver)))
    }

    suspend fun removeRoom(room: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "change the floor plan", approver)
        val store = session.storeId() ?: error("This till is not set up for a store yet.")
        ask("room.remove", ::floorRefused, FloorPlan.remove(store, room, staff.approvedBy("settings.device", approver)))
    }

    private fun floorRefused(code: String?): String = when (code) {
        "name-taken" -> "Another table in this store already has one of those numbers. It may be in another room."
        "room-exists" -> "There is already a room of that name."
        "too-many" -> "A store holds 300 tables at most, and 200 walls, doors, windows and bars."
        "bad-store" -> "This till's store is no longer there."
        "conflict" -> "That did not work. Close the plan and open it again."
        "forbidden" -> "You are not allowed to change the floor plan. Ask a manager."
        "unknown-op" -> "The server has to be updated before the floor plan can be changed from a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
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

    // ---- roles, staff and discounts (server 0095) ----
    // Asked now and waited for, as an item is; on a tablet that works on its
    // own, answered by the tablet (ask). Ids are the caller's, made when the
    // sheet opened.
    suspend fun saveRole(id: String, name: String, ticked: Set<String>, offered: List<String>, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("employees.edit", "change roles", approver)
        ask("role.save", RoleForm::refused, OfficePayloads.roleSave(id, name, ticked, offered, staff.approvedBy("employees.edit", approver)))
    }

    suspend fun removeRole(id: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("employees.edit", "change roles", approver)
        ask("role.remove", RoleForm::refused, OfficePayloads.roleRemove(id, staff.approvedBy("employees.edit", approver)))
    }

    // name, roleId, active: what is null is left as it is
    suspend fun updateStaff(id: String, name: String?, roleId: String?, active: Boolean?, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("employees.edit", "change staff", approver)
        ask("staff.update", StaffForm::refused, OfficePayloads.staffUpdate(id, name, roleId, active, staff.approvedBy("employees.edit", approver)))
    }

    suspend fun saveDiscount(id: String, d: DiscountForm.Discount, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "change the discounts", approver)
        ask("discount.save", DiscountForm::refused, OfficePayloads.discountSave(id, d, staff.approvedBy("items.edit", approver)))
    }

    suspend fun removeDiscount(id: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "change the discounts", approver)
        ask("discount.remove", DiscountForm::refused, OfficePayloads.discountRemove(id, staff.approvedBy("items.edit", approver)))
    }

    // ---- add-ons and a few settings (server 0096) ----
    suspend fun saveAddon(id: String, g: AddonForm.Group, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "change the add-ons", approver)
        ask("addon.save", AddonForm::refused, OfficePayloads.addonSave(id, g, staff.approvedBy("items.edit", approver)))
    }

    suspend fun removeAddon(id: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "change the add-ons", approver)
        ask("addon.remove", AddonForm::refused, OfficePayloads.addonRemove(id, staff.approvedBy("items.edit", approver)))
    }

    // The receipt's two notes and the service charge; what is null is left as it is.
    suspend fun saveSettings(header: String?, footer: String?, servicePct: Int?, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "change the settings", approver)
        ask("settings.save", { code ->
            when (code) {
                "bad-value" -> "A service charge is a whole number from 0 to 30."
                "forbidden" -> "You are not allowed to change the settings. Ask a manager."
                "unknown-op" -> "The server has to be updated before this can be changed from a till."
                null -> "The server refused it."
                else -> "The server refused it ($code)."
            }
        }, OfficePayloads.settingsSave(header, footer, servicePct, staff.approvedBy("settings.device", approver)))
    }

    // The notes offered when an item is added ("No onion", "Rush"), whole: the
    // list the back office's Settings keeps (server 0108).
    suspend fun saveKitchenNotes(notes: List<String>, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "change the kitchen notes", approver)
        ask("settings.save", { code ->
            when (code) {
                "forbidden" -> "You are not allowed to change the kitchen notes. Ask a manager."
                "unknown-op" -> "The server has to be updated before this can be changed from a till."
                null -> "The server refused it."
                else -> "The server refused it ($code)."
            }
        }, OfficePayloads.kitchenNotesSave(notes, staff.approvedBy("settings.device", approver)))
    }

    // The minutes before an order for later is due that the tills ring; 0 is
    // off (server 0111). The same for every till of the business.
    suspend fun saveDueReminder(minutes: Int, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "change the reminder before an order is due", approver)
        ask("settings.save", { code ->
            when (code) {
                "bad-payload" -> "A reminder is a whole number of minutes, from 0 to 120."
                "forbidden" -> "You are not allowed to change the settings. Ask a manager."
                "unknown-op" -> "The server has to be updated before this can be changed from a till."
                null -> "The server refused it."
                else -> "The server refused it ($code)."
            }
        }, OfficePayloads.dueReminderSave(minutes, staff.approvedBy("settings.device", approver)))
    }

    // ---- a product's variants (server 0097) ----
    // whether the person signed in may see cost: a sheet shows it, and sends it, only then
    fun mayCost(): Boolean = staff.can("costs.view")

    // Returns how many lines are made.
    suspend fun makeVariants(itemId: String, make: VariantForm.Make, approver: StaffMember? = null): Result<Int> = runCatching {
        staff.allow("items.edit", "change the products", approver)
        ask("variants.make", VariantForm::refused, OfficePayloads.variantsMake(itemId, make, staff.approvedBy("items.edit", approver)))
        make.lines.size
    }

    suspend fun saveVariant(itemId: String, variantId: String, barcode: String, sku: String, costShown: Boolean, cost: Long?, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "change the products", approver)
        ask("variants.save", VariantForm::refused, OfficePayloads.variantSave(itemId, variantId, barcode, sku, costShown, cost, staff.approvedBy("items.edit", approver)))
    }

    suspend fun removeVariant(variantId: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "change the products", approver)
        ask("variant.remove", VariantForm::refused, OfficePayloads.variantRemove(variantId, staff.approvedBy("items.edit", approver)))
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
    // internal, not private: a shop's stock work (StockRepository) leaves the tablet through here too.
    internal suspend fun ask(type: String, refused: (String?) -> String, payload: JsonObject) {
        // A tablet that works on its own answers by its own rules, which are
        // the server's written again (LocalAnswers), and keeps the change in
        // the queue: the day the business goes Premium the server takes it
        // as it takes a linked till's. The change and its place in the queue
        // are one transaction, so neither is there without the other.
        Journey.alone = PosSettings.parse(db.ops().settings()).alone
        if (Journey.alone) {
            val local = LocalAnswers(db.alone())
            if (!local.answers(type)) error("This tablet works on its own, and this is not something it can do by itself yet.")
            val tenant = session.tenantId() ?: error("This tablet is not set up")
            try {
                db.withTransaction {
                    // kept as the tablet answered it: a barcode it gave goes with the change
                    local.apply(type, payload, tenant, staff.id()).forEach { (kind, kept) -> db.outbox().enqueue(op(kind, kept)) }
                }
            } catch (e: Refused) {
                error(refused(e.code))
            }
            return
        }
        // Just connected, and what the tablet kept is still going up, in the
        // order it happened. A change sent straight to the server now would
        // get there before an older one of the queue, and be overwritten by
        // it when its turn came. So it waits until the queue has gone. A
        // linked till never has one of these in its queue.
        if (db.outbox().pendingOf(LocalAnswers.KINDS.toList()) > 0) {
            com.restopos.core.sync.pushNow(context)
            error("This tablet is still sending what it kept while it worked on its own. Try again in a moment.")
        }
        val answer = try {
            api.push(listOf(OutboxOp(Uuid7.next(), type, payload, staff.id()))).firstOrNull()
        } catch (e: java.io.IOException) {
            error("This needs a connection: the server has to answer first. Try again when the tablet is online.")
        } catch (e: AuthRequired) {
            error("This tablet has to be signed in again before anything can be changed from it.")
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
            // the old price is gone from the product now: written down for the Price Change report
            db.log().add(TillLogEntity(Uuid7.next(), System.currentTimeMillis(), "price", staff.id(), staff.approvedBy("items.edit", approver), item_id = itemId, was = item.price.toString(), became = price.toString()))
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
            db.log().add(TillLogEntity(Uuid7.next(), System.currentTimeMillis(), "price", staff.id(), staff.approvedBy("items.edit", approver), item_id = itemId, variant_id = variantId, was = v.price.toString(), became = price.toString()))
            db.outbox().enqueue(op("item.set_price", buildJsonObject {
                put("item_id", itemId); put("variant_id", variantId); put("price", price)
                staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
    }
}

package com.restopos.feature.order

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Uuid7
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Approvals
import com.restopos.core.data.Calc
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.LineInfo
import com.restopos.core.data.ModPick
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.OrderInfo
import com.restopos.core.data.OrderOps
import com.restopos.core.data.PosSettings
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffSession
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.L
import com.restopos.core.ui.Toaster
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// The order on screen: what it is, what is on it, and what it comes to.
data class OrderUi(
    val loaded: Boolean = false,
    val session: Int = 0, // goes up when another order is brought onto the screen
    val ticket: TicketEntity? = null,
    val kind: String = "counter", // dine | counter | takeaway | delivery | tab
    val typeId: String? = null,
    val title: String = "",
    val sub: String = "",
    val tableName: String? = null,
    val modes: List<DiningOptionEntity> = emptyList(), // what an order with no table can be
    val sent: List<LineInfo> = emptyList(),
    val fresh: List<LineInfo> = emptyList(),
    val totals: Calc.Totals = Calc.Totals(0, 0, 0, 0),
    val paid: Long = 0,
    val discount: DiscountPick? = null,
    val customer: String? = null,
    val waiter: String? = null,
    val selected: String? = null,
    val busy: Boolean = false,
    val notes: List<String> = emptyList(), // the kitchen notes offered when an item is added
) {
    val dine: Boolean get() = kind == "dine"
    val board: Boolean get() = kind == "takeaway" || kind == "delivery"
    val unsent: Int get() = fresh.sumOf { it.units }
    val empty: Boolean get() = sent.isEmpty() && fresh.isEmpty()
    val covers: Int get() = ticket?.covers ?: 1
}

// The options of an item being added.
data class OptionSheet(val item: ItemEntity, val groups: List<ModifierGroupEntity>, val mods: List<ModifierEntity>)

private val HM = SimpleDateFormat("HH:mm", Locale.US)

// Behind the order screen: the menu from Room, the order with its totals, and
// everything a waiter does to it. Every action reloads the order from Room, so
// what is on screen is always what is stored.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class OrderViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val tickets: TicketRepository,
    private val orderOps: OrderOps,
    private val service: ServiceRepository,
    private val staff: StaffSession,
    private val approvals: Approvals,
) : ViewModel() {
    private val _ui = MutableStateFlow(OrderUi())
    val ui: StateFlow<OrderUi> = _ui

    val cats: StateFlow<List<CategoryEntity>> = db.catalog().categories().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    private val pickedCat = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    // a category is always showing: the one tapped, else the first
    val cat: StateFlow<String?> = combine(cats, pickedCat) { all, sel -> sel?.takeIf { id -> all.any { it.id == id } } ?: all.firstOrNull()?.id }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)
    // a search looks through the whole menu, not only the open category
    val items: StateFlow<List<ItemEntity>> = combine(cat, query) { c, q -> (if (q.isBlank()) c else null) to q.trim() }
        .distinctUntilChanged()
        .flatMapLatest { (c, q) -> db.service().items(c, q) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    // the items that ask a question when they are added
    val withOptions: StateFlow<Set<String>> = db.service().itemGroups().map { rows -> rows.map { it.item_id }.toSet() }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptySet())

    // Settings, Display: the order on the right and the menu on the left
    val leftHanded: StateFlow<Boolean> = session.leftHanded.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    private val _sheet = MutableStateFlow<OptionSheet?>(null)
    val sheet: StateFlow<OptionSheet?> = _sheet
    // the keypad, when an item's price is typed at the sale
    val asking = MutableStateFlow<com.restopos.feature.retail.NumAsk?>(null)
    fun closeAsk() { asking.value = null }
    // the price typed for the item whose options are being picked
    private var typedPrice: Long? = null

    // The item that has just gone onto the order, said once: its card on the
    // menu answers the tap. Nothing is said for an order that is only shown.
    private val _added = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val added: SharedFlow<String> = _added

    fun pickCat(id: String) { pickedCat.value = id; query.value = "" }

    // Called when the screen opens: another order may be on it now.
    fun open() = viewModelScope.launch {
        query.value = ""
        _sheet.value = null
        reload(fresh = true)
    }

    private suspend fun reload(fresh: Boolean = false) {
        val t = tickets.activeTicket()
        val types = db.catalog().diningOptions()
        val typeId = t?.dining_option_id ?: session.pendingDining()
        val table = (t?.table_id ?: session.pendingTable())?.let { db.tables().table(it) }
        val type = types.firstOrNull { it.id == typeId }
        val kind = type?.kind ?: if (table != null) "dine" else "counter"
        val lines = if (t == null) emptyList() else service.describe(db.tickets().lines(t.id).first())
        val discount = tickets.pendingDiscount()
        val waiter = (t?.opened_by ?: staff.id())?.let { db.staff().employee(it)?.name }
        val typeName = when (kind) { "counter" -> L.quick; else -> type?.name ?: L.quick }
        val before = _ui.value
        _ui.value = OrderUi(
            loaded = true,
            session = if (fresh || before.ticket?.id.let { it != null && it != t?.id }) before.session + 1 else before.session,
            ticket = t, kind = kind, typeId = type?.id,
            title = if (table != null) tableLabel(table.name) else listOfNotNull(typeName, t?.order_no).joinToString(" "),
            sub = if (table != null) listOfNotNull(table.area, waiter).joinToString(" · ")
            else listOfNotNull(waiter, t?.let { "opened ${HM.format(Date(Uuid7.millis(it.id) ?: it.updated_at))}" } ?: "new order").joinToString(" · "),
            tableName = table?.name,
            modes = types.filter { it.kind != "dine" }.sortedBy { listOf("counter", "takeaway", "delivery", "tab").indexOf(it.kind) },
            sent = lines.filter { it.line.sent_to_kitchen_at != null || it.line.paid },
            fresh = lines.filter { it.line.sent_to_kitchen_at == null && !it.line.paid },
            totals = service.dueOf(lines, service.servicePct(t), discount),
            paid = t?.let { db.receipts().paidForTicket(it.id) } ?: 0,
            discount = discount,
            customer = t?.customer_id?.let { db.customers().customer(it)?.name },
            waiter = waiter,
            selected = before.selected?.takeIf { id -> lines.any { it.line.id == id && !it.line.paid } },
            notes = PosSettings.parse(db.ops().settings()).kitchenNotes,
        )
    }

    fun select(lineId: String?) { _ui.value = _ui.value.copy(selected = lineId) }

    // Tapping an item. One with options asks first; the others go straight on.
    // One whose price is typed at the sale (a service, anything charged
    // differently each time) brings the keypad up first: what is typed is its
    // price, and each tap is a line of its own.
    fun tap(item: ItemEntity, ask: Boolean = false) = viewModelScope.launch {
        if (!item.is_available) { Toaster.say("${item.name} is sold out"); return@launch }
        if (item.open_price) {
            asking.value = com.restopos.feature.retail.NumAsk(item.name, "Type its price for this order", "Rs", 2, "") { typed ->
                val price = com.restopos.core.data.LinePrice.typed(typed)
                if (price == null) Toaster.say("Type the price") else viewModelScope.launch { put(item, ask, price) }
            }
            return@launch
        }
        put(item, ask, null)
    }

    private suspend fun put(item: ItemEntity, ask: Boolean, price: Long?) {
        val groups = db.catalog().groupsForItem(item.id)
        if (groups.isEmpty() && !ask) {
            tickets.addItem(item.id, 1000, emptyList(), null, price = price).fold({ _added.tryEmit(item.id) }, { Toaster.say(it.message) })
            reload()
        } else {
            typedPrice = price
            _sheet.value = OptionSheet(item, groups, db.catalog().modifiersForItem(item.id))
        }
    }

    fun closeSheet() { _sheet.value = null; typedPrice = null }

    // A barcode read by the scanner: the item that carries it goes on the
    // order, as if it had been tapped. What the scanner typed into the search
    // box on its way is cleared.
    fun scanned(code: String) = viewModelScope.launch {
        query.value = ""
        val item = db.catalog().itemByBarcode(code.trim())
        if (item == null) { Toaster.say("No item has the barcode $code. It is set on the item in the back office."); return@launch }
        tap(item)
    }

    fun confirm(qty: Int, picks: List<ModPick>, note: String) = viewModelScope.launch {
        val item = _sheet.value?.item ?: return@launch
        _sheet.value = null
        val price = typedPrice.takeIf { item.open_price }
        typedPrice = null
        tickets.addItem(item.id, qty.coerceIn(1, 99) * 1000, picks, note.ifBlank { null }, price = price).fold({ _added.tryEmit(item.id) }, { Toaster.say(it.message) })
        reload()
    }

    // one more or one fewer of a line that has not been sent
    fun bump(line: LineInfo, by: Int) = viewModelScope.launch {
        val qty = line.units + by
        if (qty <= 0) { remove(line.line.id); return@launch }
        val item = line.line.item_id
        tickets.setQty(line.line.id, qty * 1000, "quantity change").onFailure { Toaster.say(it.message) }
        reload()
        // a quantity change replaces the line; keep its replacement selected
        _ui.value = _ui.value.copy(selected = _ui.value.fresh.lastOrNull { it.line.item_id == item }?.line?.id)
    }

    // Taking a line off: deleted before it is sent; after, a void the kitchen is told about.
    fun remove(lineId: String) = viewModelScope.launch { approved { by -> orderOps.remove(lineId, by) } }

    fun clearNew() = viewModelScope.launch {
        val ids = _ui.value.fresh.map { it.line.id }
        if (ids.isEmpty()) return@launch
        approved { by -> runCatching { removeAll(ids, by) } }
    }

    // Everything a removal needs is checked before anything comes off, so an
    // approval that is not given leaves the order whole.
    private suspend fun removeAll(ids: List<String>, by: StaffMember?) {
        val rows = ids.mapNotNull { db.tickets().line(it) }.filter { it.voided_at == null && !it.paid }
        if (rows.any { it.sent_to_kitchen_at != null }) staff.allow("sale.void_sent_line", "void an item the kitchen already has", by)
        if (rows.any { it.sent_to_kitchen_at == null }) staff.allow("sale.void_line", "take an item off an order", by)
        rows.forEach { orderOps.remove(it.id, by).getOrThrow() }
    }

    // Send: the kitchen gets what it has not had. An order on a table then
    // goes back to the floor; the others stay on screen for the payment.
    fun send(sentFromTable: () -> Unit) = viewModelScope.launch {
        val s = _ui.value
        if (s.busy) return@launch
        if (s.unsent == 0) { Toaster.say(if (s.empty) "Add an item first" else "Everything on this order is already in the kitchen"); return@launch }
        _ui.value = s.copy(busy = true)
        // the name just typed goes on the kitchen ticket
        contactJob?.cancel()
        saveContact()
        val out = orderOps.save()
        out.fold(
            onSuccess = { r ->
                val trouble = r.trouble()
                when {
                    trouble != null -> Toaster.say(trouble)
                    r.sent == 0 -> Toaster.say("This order type is set never to go to the kitchen (back office, Settings).")
                    else -> Toaster.say("${s.unsent} item${if (s.unsent == 1) "" else "s"} sent to kitchen" + (s.tableName?.let { " · $it" } ?: ""))
                }
                reload()
                if (r.sent > 0 && s.dine) sentFromTable()
            },
            onFailure = { Toaster.say(it.message); reload() },
        )
    }

    // New sale: the counter order on screen is parked as it is (it waits under
    // Orders, with what it has not sent still not sent) and an empty one of the
    // same kind takes its place. One with nothing on it is already a new sale.
    fun newSale() = viewModelScope.launch {
        val s = _ui.value
        if (s.busy) return@launch
        if (s.empty) { Toaster.say("This sale is empty. Tap items to start it."); return@launch }
        // a name typed a moment ago stays with the order it was typed on
        contactJob?.cancel()
        saveContact()
        tickets.startOrder(s.typeId ?: tickets.counterTypeId())
        query.value = ""
        _sheet.value = null
        reload(fresh = true)
        Toaster.say("${s.ticket?.order_no ?: "Sale"} parked · it waits under ${L.orders}" + if (s.unsent > 0) " · ${s.unsent} not sent to the kitchen" else "")
    }

    fun printBill() = viewModelScope.launch {
        if (_ui.value.empty) { Toaster.say("Add an item first"); return@launch }
        orderOps.printBill(_ui.value.discount).fold(
            onSuccess = { Toaster.say("Bill printed" + (_ui.value.tableName?.let { " · $it" } ?: "")) },
            onFailure = { Toaster.say((if (_ui.value.dine) "Marked as waiting for the bill. " else "") + it.message) },
        )
        reload()
    }

    fun covers(by: Int) = viewModelScope.launch {
        tickets.setCovers((_ui.value.covers + by).coerceIn(1, 99)).onFailure { Toaster.say(it.message) }
        reload()
    }

    fun setType(optionId: String) = viewModelScope.launch {
        tickets.setType(optionId).onFailure { Toaster.say(it.message) }
        reload()
    }

    // Who a takeaway is for. Typing is not saved letter by letter: it waits
    // for a pause. What was typed in one box is kept while the next is typed
    // in, and all of it is saved together.
    private var contactJob: Job? = null
    private var typed: Triple<String?, String?, String?>? = null
    private var typedOn: Pair<String?, Int>? = null // the order it was typed on: its id, or the screen's turn if it had none yet
    fun contact(name: String? = null, phone: String? = null, address: String? = null) {
        val was = typed
        typed = Triple(name ?: was?.first, phone ?: was?.second, address ?: was?.third)
        if (typedOn == null) typedOn = _ui.value.ticket?.id to _ui.value.session
        contactJob?.cancel()
        contactJob = viewModelScope.launch {
            delay(700)
            saveContact()
            reload()
        }
    }

    // Saves what was typed, if the order it was typed on is still the one on
    // the register. Someone who typed a name and left for another order within
    // the pause does not get that name put on the other order.
    private suspend fun saveContact() {
        val what = typed ?: return
        val (forTicket, forTurn) = typedOn ?: (null to _ui.value.session)
        typed = null
        typedOn = null
        val active = tickets.activeTicket()?.id
        if (if (forTicket != null) active != forTicket else _ui.value.session != forTurn) return
        tickets.setContact(what.first?.trim(), what.second?.trim(), what.third?.trim()).onFailure { Toaster.say(it.message) }
    }

    fun mayPay(): Boolean {
        if (_ui.value.empty) { Toaster.say("Add items before paying"); return false }
        // a name typed a moment ago is on the order before it is paid: a
        // takeaway's kitchen ticket prints when it is paid
        if (typed != null) viewModelScope.launch { contactJob?.cancel(); saveContact() }
        return true
    }

    // ---- the More sheet ----
    suspend fun discounts(): List<DiscountEntity> = db.catalog().discounts().filter { !it.requires_approval || staff.id() != null }
    suspend fun waiters(): List<EmployeeEntity> = session.storeId()?.let { db.staff().staff(it).first() } ?: emptyList()
    suspend fun freeTables(): List<TableEntity> {
        val store = session.storeId() ?: return emptyList()
        return db.tables().tablesNow(store).filter { db.tickets().openTicketForTable(it.id) == null }
    }

    // A discount this person may not give asks for someone who may; who
    // approved goes with it to the receipt.
    fun setDiscount(d: DiscountPick?, restricted: Boolean = false, by: StaffMember? = null) {
        if (_ui.value.ticket == null) { Toaster.say("Add an item first"); return }
        if (d != null) {
            val need = when {
                !staff.can("sale.apply_discount") && by?.can("sale.apply_discount") != true -> "sale.apply_discount"
                restricted && !staff.can("sale.apply_restricted_discount") && by?.can("sale.apply_restricted_discount") != true -> "sale.apply_restricted_discount"
                else -> null
            }
            if (need != null) {
                approvals.ask(need, if (restricted) "give the discount ${d.name}" else "give a discount") { approver -> setDiscount(d, restricted, approver) }
                return
            }
        }
        viewModelScope.launch {
            tickets.setPendingDiscount(d?.copy(approvedBy = by?.employee?.id))
            reload()
            Toaster.say(if (d == null) "Discount taken off" else "${d.name} will be taken off at payment")
        }
    }

    fun setNote(note: String) = viewModelScope.launch {
        tickets.setNote(note.trim()).onFailure { Toaster.say(it.message) }
        reload()
    }

    fun setWaiter(employeeId: String) = viewModelScope.launch { approved("Order handed over") { by -> orderOps.setWaiter(employeeId, by) } }

    fun setCustomer(customerId: String?) = viewModelScope.launch {
        tickets.setCustomer(customerId).onFailure { Toaster.say(it.message) }
        reload()
    }

    fun moveTo(table: TableEntity) = viewModelScope.launch {
        tickets.moveToTable(table.id).fold({ Toaster.say("Moved to ${table.name}") }, { Toaster.say(it.message) })
        reload()
    }

    // the other tables that have an order: this one's could go onto theirs
    suspend fun seatedTables(): List<OrderInfo> {
        val store = session.storeId() ?: return emptyList()
        val mine = tickets.activeTicket()?.id
        return service.orders(store).first().filter { it.open && it.table != null && it.id != mine }.sortedBy { it.table?.name }
    }

    // This order goes onto another table's: one bill, and this table is free.
    // The order that is left is the one on the screen afterwards.
    fun mergeInto(other: OrderInfo, name: String) = viewModelScope.launch {
        val mine = tickets.activeTicket() ?: return@launch
        approved("One bill now, on $name") { by -> tickets.merge(mine.id, other.id, by) }
    }

    fun reprintKitchen() = viewModelScope.launch { approved("Sent to the kitchen printer again") { by -> orderOps.reprintKitchen(by) } }

    // Cancel order: every item comes off (the kitchen is told about the ones
    // it has, which needs someone allowed to void them), and the order is
    // closed: it lets go of its table and leaves the board. One that is partly
    // paid cannot be cancelled.
    fun cancel(then: () -> Unit) = viewModelScope.launch {
        val t = tickets.activeTicket()
        if (t == null) { tickets.newTicket(); then(); return@launch }
        if (db.tickets().allLines(t.id).any { it.paid && it.voided_at == null }) {
            Toaster.say("Part of this order is already paid, so it cannot be cancelled. Take payment for the rest.")
            return@launch
        }
        approved("Order cancelled", then = then) { by ->
            runCatching {
                removeAll(db.tickets().allLines(t.id).map { it.id }, by)
                tickets.cancelOrder(t.id).getOrThrow()
                tickets.newTicket()
                session.setPendingDiscount(null)
            }
        }
    }

    // Runs something that may need someone else's go-ahead. If it does, asks
    // for it and runs the same thing again with whoever approved.
    private suspend fun approved(done: String? = null, by: StaffMember? = null, then: (() -> Unit)? = null, block: suspend (StaffMember?) -> Result<*>) {
        val out = block(by)
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) {
            approvals.ask(need.permission, need.what) { approver -> viewModelScope.launch { approved(done, approver, then, block) } }
        } else {
            out.fold({ done?.let { Toaster.say(it) }; reload(); then?.invoke() }, { Toaster.say(it.message); reload() })
        }
    }

    fun money(cents: Long) = Money.format(cents)
}

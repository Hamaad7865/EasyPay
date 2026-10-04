package com.restopos.feature.sale

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.paging.PagingData
import androidx.paging.cachedIn
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.Calc
import com.restopos.core.data.CatalogRepository
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.ModPick
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.OrderOps
import com.restopos.core.data.PayInput
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
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// The register: category strip and item tiles from Room, the live order with
// its totals, and a keypad whose number is used by whatever is tapped next
// (an item: that many; a line: its quantity; Tables: that table; Cash: the amount received).
sealed interface SaleUiState {
    data class Ready(val categories: List<CategoryEntity>, val selectedCat: String?) : SaleUiState
}

sealed interface SaleAction {
    data class SelectCategory(val id: String?) : SaleAction
    data class Search(val query: String) : SaleAction
    data class TapItem(val item: ItemEntity) : SaleAction
    data class ConfirmMods(val qty: Int, val picks: List<ModPick>, val note: String) : SaleAction
    data class SetQty(val lineId: String, val qty: Int) : SaleAction
    data class VoidLine(val lineId: String, val reason: String) : SaleAction
    data class Key(val key: String) : SaleAction
    data class SelectLine(val lineId: String?) : SaleAction
    data class SetName(val name: String) : SaleAction
    data class SetDining(val optionId: String) : SaleAction
    data class QuickPay(val kind: String) : SaleAction // "cash" or "card"
    data object ApplyQty : SaleAction
    data object OpenTable : SaleAction // the table whose name is on the keypad
    data class SetGuests(val guests: Int) : SaleAction
    data class ByCourse(val on: Boolean) : SaleAction // the order shown course by course, or as rung up
    data class PickCourse(val course: Int) : SaleAction // the course new items go to
    data object AddCourse : SaleAction
    data object NewTicket : SaleAction
    data class RemoveLine(val lineId: String) : SaleAction // deleted before it is sent, voided after
    data object Save : SaleAction // sends what the kitchen has not had, and puts the order away
    data object PrintBill : SaleAction
    data object ReprintKitchen : SaleAction
    data class SetWaiter(val employeeId: String) : SaleAction
    data class SetNote(val note: String) : SaleAction
    data object DismissSheet : SaleAction
}

// amount = the line with its modifiers, as charged
data class LineUi(val line: TicketLineEntity, val mods: String, val amount: Long)
data class SheetData(
    val item: ItemEntity,
    val groups: List<ModifierGroupEntity>,
    val mods: List<ModifierEntity>,
    val qty: Int = 1,
)
data class PaidEvent(val receiptId: String, val change: Long, val total: Long)

object Keys {
    const val CLEAR = "C"
    const val BACK = "back"
    const val TIMES = "times"
}

@HiltViewModel
class SaleViewModel @Inject constructor(
    private val repo: CatalogRepository,
    private val tickets: TicketRepository,
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val orderOps: OrderOps,
    private val approvals: Approvals,
) : ViewModel() {
    private val cat = MutableStateFlow<String?>(null)
    private val query = MutableStateFlow("")
    private val _toast = MutableStateFlow<String?>(null)
    val toast: StateFlow<String?> = _toast

    private val _ticket = MutableStateFlow<TicketEntity?>(null)
    val ticket: StateFlow<TicketEntity?> = _ticket

    private val _lines = MutableStateFlow<List<LineUi>>(emptyList())
    val lines: StateFlow<List<LineUi>> = _lines

    private val _totals = MutableStateFlow(Calc.Totals(0, 0, 0, 0))
    val totals: StateFlow<Calc.Totals> = _totals

    private val _discounts = MutableStateFlow<List<DiscountEntity>>(emptyList())
    val discounts: StateFlow<List<DiscountEntity>> = _discounts

    private val _discount = MutableStateFlow<DiscountPick?>(null)
    val discount: StateFlow<DiscountPick?> = _discount

    private val _dining = MutableStateFlow<List<DiningOptionEntity>>(emptyList())
    val dining: StateFlow<List<DiningOptionEntity>> = _dining

    // The name of the table this order is on, or will be on once it has an item.
    private val _tableName = MutableStateFlow<String?>(null)
    val tableName: StateFlow<String?> = _tableName

    // Table service: the order split into courses. Kept per order while it is
    // on the register: which course new items go to, and how many there are.
    private val _byCourse = MutableStateFlow(true)
    val byCourse: StateFlow<Boolean> = _byCourse
    private val _course = MutableStateFlow(1)
    val course: StateFlow<Int> = _course
    private val _courses = MutableStateFlow(1)
    val courses: StateFlow<Int> = _courses

    // Who the order can be handed to.
    private val _waiters = MutableStateFlow<List<EmployeeEntity>>(emptyList())
    val waiters: StateFlow<List<EmployeeEntity>> = _waiters

    // True when this order's type goes to the kitchen on Save (dine in). A
    // type that goes when it is paid (take away) has no Save.
    private val _saves = MutableStateFlow(true)
    val saves: StateFlow<Boolean> = _saves

    // Set when Save has sent the order and put it away: the screen goes back
    // to the list it came from.
    private val _saved = MutableStateFlow(false)
    val saved: StateFlow<Boolean> = _saved
    fun savedShown() { _saved.value = false }
    // true while Save is waiting on the printers: a second tap must not send the same lines again
    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving

    private val _sheet = MutableStateFlow<SheetData?>(null)
    val sheet: StateFlow<SheetData?> = _sheet

    // What has been typed on the keypad and not used yet.
    private val _buffer = MutableStateFlow("")
    val buffer: StateFlow<String> = _buffer

    private val _selected = MutableStateFlow<String?>(null)
    val selected: StateFlow<String?> = _selected

    // Set when a quick Cash or Card payment closed the order; the screen shows
    // the change due and clears it.
    private val _paid = MutableStateFlow<PaidEvent?>(null)
    val paid: StateFlow<PaidEvent?> = _paid

    // "Store name · till code" for the top bar.
    private val _till = MutableStateFlow("")
    val till: StateFlow<String> = _till

    // Who is at the register (null on a till with no staff PINs), and this
    // till's open shift.
    val user: StateFlow<StaffMember?> = staff.current

    @OptIn(ExperimentalCoroutinesApi::class)
    val shift: StateFlow<ShiftEntity?> = flow { emit(session.deviceId()) }
        .flatMapLatest { d -> if (d == null) emptyFlow() else db.staff().openShiftFlow(d) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    // Settings, Display: the order and keypad on the right instead of the left.
    val leftHanded: StateFlow<Boolean> = session.leftHanded
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    val needsSignIn: StateFlow<Boolean> = session.needsSignIn
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    val pending: StateFlow<Long> = db.outbox().pendingCountFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    val rejected: StateFlow<Long> = db.outbox().deadCountFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    // A category is always showing: the one tapped, else the first.
    val state: Flow<SaleUiState> = combine(repo.categories(), cat) { cats, sel ->
        SaleUiState.Ready(cats, sel?.takeIf { id -> cats.any { it.id == id } } ?: cats.firstOrNull()?.id)
    }

    // A search looks through the whole menu, not only the open category.
    @OptIn(ExperimentalCoroutinesApi::class)
    val items: Flow<PagingData<ItemEntity>> = combine(state, query) { s, q ->
        (if (q.isBlank()) (s as SaleUiState.Ready).selectedCat else null) to q.trim()
    }
        .distinctUntilChanged()
        .flatMapLatest { (c, q) -> repo.items(c, q) }
        .cachedIn(viewModelScope)

    init {
        viewModelScope.launch {
            val store = session.storeId()?.let { db.catalog().store(it) }
            val device = session.deviceId()?.let { db.catalog().device(it) }
            _till.value = listOfNotNull(store?.name, device?.code).joinToString(" · ")
        }
        refresh()
    }

    // Reloads the order from Room. Called when the register comes back on
    // screen (after paying, or after picking an order under Orders).
    fun refresh() = viewModelScope.launch { reload() }

    // New order from the top bar: the order on the register is parked first,
    // then the register is shown, so it never flashes the old order.
    fun newOrder(then: () -> Unit) = viewModelScope.launch {
        tickets.newTicket()
        session.setPendingDiscount(null)
        reload()
        then()
    }

    private suspend fun reload() {
        val before = _ticket.value?.id
        _ticket.value = tickets.activeTicket()
        val changed = _ticket.value?.id != before
        if (changed) { _selected.value = null; _buffer.value = ""; _course.value = 1; _courses.value = 1 }
        _tableName.value = (_ticket.value?.table_id ?: session.pendingTable())?.let { db.tables().table(it)?.name }
        // Every discount is offered: one this person may not give asks for
        // someone who may when it is picked. On a till without staff PINs
        // there is nobody to ask, so one that needs approval is left out.
        _discounts.value = db.catalog().discounts().filter { !it.requires_approval || staff.id() != null }
        _dining.value = db.catalog().diningOptions()
        // the discount the pay screen will apply, so both show the same total
        _discount.value = tickets.pendingDiscount()
        val type = (_ticket.value?.dining_option_id ?: session.pendingDining())?.let { id -> _dining.value.firstOrNull { it.id == id } }
            ?: _dining.value.firstOrNull { it.is_default }
        _saves.value = (type?.kitchen ?: "save") == "save"
        _waiters.value = session.storeId()?.let { db.staff().staff(it).first() } ?: emptyList()
        reloadLines()
    }

    private suspend fun reloadLines() {
        val t = _ticket.value
        if (t == null) { _lines.value = emptyList(); _totals.value = Calc.Totals(0, 0, 0, 0); return }
        val dao = db.tickets()
        val rows = dao.lines(t.id).first()
        _lines.value = rows.map {
            LineUi(it, dao.modText(it.id) ?: "", Calc.lineAmount(it.unit_price, it.qty) + dao.modSum(it.id))
        }
        if (rows.none { it.id == _selected.value && !it.paid }) _selected.value = null
        // never fewer course headings than the order has courses
        _courses.value = maxOf(_courses.value, rows.maxOfOrNull { it.course ?: 1 } ?: 1)
        val calcLines = rows.filter { it.voided_at == null && !it.paid }.map { l ->
            val taxes = db.catalog().lineTaxes(l.id)
            val mods = dao.modSum(l.id)
            Calc.Line(Calc.lineAmount(l.unit_price, l.qty) + mods, taxes.map { Calc.TaxRate(it.rate_bp, it.type) })
        }
        val d = _discount.value
        _totals.value = Calc.totalsRounded(calcLines, listOfNotNull(d?.let {
            Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value)
        }))
    }

    fun onAction(a: SaleAction) = viewModelScope.launch {
        when (a) {
            is SaleAction.SelectCategory -> cat.value = a.id
            is SaleAction.Search -> query.value = a.query
            is SaleAction.Key -> press(a.key)
            is SaleAction.SelectLine -> _selected.value = a.lineId
            is SaleAction.TapItem -> {
                val qty = typedQty() ?: return@launch
                val groups = db.catalog().groupsForItem(a.item.id)
                _buffer.value = ""
                if (groups.isEmpty()) {
                    tickets.addItem(a.item.id, qty * 1000, emptyList(), null, courseForNewLine())
                        .onFailure { _toast.value = it.message }
                    reload()
                } else {
                    _sheet.value = SheetData(a.item, groups, db.catalog().modifiersForItem(a.item.id), qty)
                }
            }
            is SaleAction.ConfirmMods -> {
                val item = _sheet.value?.item ?: return@launch
                _sheet.value = null
                tickets.addItem(item.id, a.qty * 1000, a.picks, a.note.ifBlank { null }, courseForNewLine())
                    .onFailure { _toast.value = it.message }
                reload()
            }
            is SaleAction.SetQty -> setQty(a.lineId, a.qty)
            is SaleAction.ApplyQty -> {
                val line = _selected.value
                if (line == null) { _toast.value = "Tap an item to add that many, or pick a line first"; return@launch }
                if (_buffer.value.isEmpty()) { _toast.value = "Type the quantity first"; return@launch }
                val qty = typedQty() ?: return@launch
                _buffer.value = ""
                setQty(line, qty)
            }
            is SaleAction.VoidLine -> approved { by -> orderOps.remove(a.lineId, by) }
            is SaleAction.RemoveLine -> approved { by -> orderOps.remove(a.lineId, by) }
            is SaleAction.Save -> save()
            is SaleAction.PrintBill -> orderOps.printBill(_discount.value).onFailure { _toast.value = it.message }
            is SaleAction.ReprintKitchen -> approved("Sent to the kitchen again") { by -> orderOps.reprintKitchen(by) }
            is SaleAction.SetWaiter -> approved { by -> orderOps.setWaiter(a.employeeId, by) }
            is SaleAction.SetNote -> {
                tickets.setNote(a.note.trim()).onFailure { _toast.value = it.message }
                reload()
            }
            is SaleAction.SetName -> {
                tickets.setName(a.name.trim()).onFailure { _toast.value = it.message }
                reload()
            }
            is SaleAction.SetDining -> {
                tickets.setDining(a.optionId).onFailure { _toast.value = it.message }
                reload()
            }
            is SaleAction.OpenTable -> {
                val wanted = _buffer.value.trim()
                val store = session.storeId() ?: return@launch
                val table = db.tables().tablesNow(store).firstOrNull { it.name.equals(wanted, ignoreCase = true) }
                if (table == null) { _toast.value = "There is no table $wanted"; return@launch }
                _buffer.value = ""
                session.setPendingDiscount(null)
                tickets.openTable(table.id)
                reload()
            }
            is SaleAction.SetGuests -> {
                tickets.setCovers(a.guests.coerceIn(1, 99)).onFailure { _toast.value = it.message }
                reload()
            }
            is SaleAction.ByCourse -> _byCourse.value = a.on
            is SaleAction.PickCourse -> _course.value = a.course.coerceIn(1, _courses.value)
            is SaleAction.AddCourse -> { _courses.value += 1; _course.value = _courses.value }
            is SaleAction.QuickPay -> quickPay(a.kind)
            is SaleAction.NewTicket -> {
                tickets.newTicket()
                session.setPendingDiscount(null)
                reload()
            }
            is SaleAction.DismissSheet -> _sheet.value = null
        }
    }

    private suspend fun setQty(lineId: String, qty: Int) {
        val item = _lines.value.firstOrNull { it.line.id == lineId }?.line?.item_id
        tickets.setQty(lineId, qty * 1000, "quantity change")
            .onFailure { _toast.value = it.message }
        reload()
        // a quantity change replaces the line; keep its replacement selected
        _selected.value = _lines.value.lastOrNull { it.line.item_id == item && !it.line.paid }?.line?.id
    }

    // Courses are for table service: an order on a table, or a named tab.
    // A direct sale has none.
    // Save: the kitchen gets what it has not had, then the order is put away
    // (it stays open, on its table and under Orders) and the register is free.
    // If a printer did not answer, its items stay unsent and the order stays
    // on the register so Save can be pressed again.
    private suspend fun save() {
        if (_saving.value) return
        if (_lines.value.isEmpty()) { _toast.value = "Add an item first"; return }
        _saving.value = true
        val result = orderOps.save()
        _saving.value = false
        result.fold(
            onSuccess = { r ->
                if (r.errors.isNotEmpty()) {
                    _toast.value = r.errors.first() + " Press Save again to send what is left."
                    reload()
                } else {
                    tickets.newTicket()
                    session.setPendingDiscount(null)
                    reload()
                    _saved.value = true
                }
            },
            onFailure = { _toast.value = it.message },
        )
    }

    private fun courseForNewLine(): Int? =
        if (_byCourse.value && (_ticket.value?.name != null || _tableName.value != null)) _course.value else null

    private fun press(key: String) {
        val b = _buffer.value
        _buffer.value = when (key) {
            Keys.CLEAR -> ""
            Keys.BACK -> b.dropLast(1)
            "." -> if (b.contains('.')) b else if (b.isEmpty()) "0." else "$b."
            else -> {
                // digits, or "00": whole part up to 6 digits, two decimals
                var out = if (b == "0") "" else b
                for (ch in key) {
                    val whole = out.substringBefore('.')
                    val full = if (out.contains('.')) out.substringAfter('.').length >= 2 else whole.length >= 6
                    if (!full && !(out.isEmpty() && ch == '0' && key.length > 1)) out += ch
                }
                out
            }
        }
    }

    // The keypad number as a quantity: nothing typed means one.
    private fun typedQty(): Int? {
        val b = _buffer.value
        if (b.isEmpty()) return 1
        val n = b.toIntOrNull()
        if (n == null || n !in 1..999) {
            _toast.value = "A quantity is a whole number from 1 to 999"
            return null
        }
        return n
    }

    // Cash or Card straight from the register: pays everything still unpaid in
    // one receipt. For cash, the keypad number is the amount received; nothing
    // typed means the exact amount. Splitting the bill is done from Pay.
    private suspend fun quickPay(kind: String) {
        _ticket.value = tickets.activeTicket()
        reloadLines()
        if (_lines.value.none { !it.line.paid }) { _toast.value = "Nothing to pay on this order"; return }
        val type = db.catalog().paymentTypes().first().firstOrNull { it.kind == kind }
        if (type == null) { _toast.value = "No $kind payment type is set up for this restaurant"; return }
        val due = _totals.value.total
        val typed = _buffer.value
        val received = if (kind == "cash" && typed.isNotEmpty()) Money.parseRs(typed) else due
        if (received == null) { _toast.value = "That amount is not a number"; return }
        if (received < due) {
            _toast.value = "${Money.format(received)} received is less than the ${Money.format(due)} due"
            return
        }
        // a zero total (fully discounted) is paid with no payment row
        val payments = if (due > 0) listOf(PayInput(type.id, due, received, received - due)) else emptyList()
        tickets.pay(payments, listOfNotNull(_discount.value)).fold(
            onSuccess = { receipt ->
                orderOps.afterPay(receipt)
                session.setPendingDiscount(null)
                _buffer.value = ""
                reload()
                _paid.value = PaidEvent(receipt.id, received - due, receipt.total)
            },
            onFailure = { _toast.value = it.message },
        )
    }

    // Runs something that may need someone else's go-ahead. If it does, asks
    // for it and runs the same thing again with whoever approved.
    private suspend fun approved(done: String? = null, by: StaffMember? = null, block: suspend (StaffMember?) -> Result<*>) {
        val out = block(by)
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) {
            approvals.ask(need.permission, need.what) { approver -> viewModelScope.launch { approved(done, approver, block) } }
        } else {
            out.fold({ done?.let { _toast.value = it } }, { _toast.value = it.message })
        }
        reload()
    }

    // A discount this person may not give asks for someone who may; who
    // approved goes with the discount to the receipt.
    fun setDiscount(d: DiscountPick?, by: StaffMember? = null) {
        if (d != null) {
            val restricted = d.discountId != null && _discounts.value.firstOrNull { it.id == d.discountId }?.requires_approval == true
            val need = when {
                !staff.can("sale.apply_discount") && by?.can("sale.apply_discount") != true -> "sale.apply_discount"
                restricted && !staff.can("sale.apply_restricted_discount") && by?.can("sale.apply_restricted_discount") != true -> "sale.apply_restricted_discount"
                else -> null
            }
            if (need != null) {
                approvals.ask(need, if (restricted) "give the discount ${d.name}" else "give a discount") { approver -> setDiscount(d, approver) }
                return
            }
        }
        val pick = d?.copy(approvedBy = by?.employee?.id)
        _discount.value = pick
        viewModelScope.launch {
            tickets.setPendingDiscount(pick)
            reloadLines()
        }
    }

    // A new order of the type picked (Dine in, Take away): the order on the
    // register is put away first.
    fun startOrder(diningId: String?, then: () -> Unit) = viewModelScope.launch {
        tickets.startOrder(diningId)
        session.setPendingDiscount(null)
        reload()
        then()
    }
    fun toastShown() { _toast.value = null }

    // Asked before the pay screen opens; says why not when the answer is no.
    fun mayPay(): Boolean {
        if (staff.can("payment.take")) return true
        _toast.value = "You are not allowed to take payment. Ask someone who is."
        return false
    }
    fun paidShown() { _paid.value = null }
}

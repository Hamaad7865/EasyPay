package com.restopos.feature.retail

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.Calc
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.ExchangeDraft
import com.restopos.core.data.Exchanges
import com.restopos.core.data.Found
import com.restopos.core.data.LinePrice
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.OrderInfo
import com.restopos.core.data.OrderOps
import com.restopos.core.data.PriceEdit
import com.restopos.core.data.RetailSales
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffSession
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemLeft
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.TicketEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Toaster
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

// A line of the sale as the screen shows it.
data class SaleLine(val line: TicketLineEntity, val name: String, val variant: String?, val weighed: Boolean, val amount: Long) {
    // what it would have come to at its listed price, when it is charged another
    val was: Long? get() = line.list_price?.let { Calc.lineAmount(it, line.qty) }?.takeIf { it != amount }
}

// The sale on the screen.
data class SaleUi(
    val loaded: Boolean = false,
    val ticket: TicketEntity? = null,
    val lines: List<SaleLine> = emptyList(),
    val totals: Calc.Totals = Calc.Totals(0, 0, 0, 0),
    val lineOff: Long = 0, // what discounts and changed prices on lines took off, in all
    val discount: DiscountPick? = null,
    val customer: String? = null,
    val open: String? = null, // the line whose keys are showing
) {
    val empty: Boolean get() = lines.isEmpty()
    // the lines at their listed prices, and everything taken off them
    val listed: Long get() = totals.subtotal + lineOff
    val off: Long get() = lineOff + totals.discount
    // VAT that goes on top of the prices (none when the prices include it)
    val taxOnTop: Long get() = totals.total - (totals.subtotal - totals.discount + totals.service + totals.rounding)
}

// A product that comes in variants, being picked: its options ("Size",
// "Colour"), each variant's values for them, and what is left of each.
class VariantPick(
    val item: ItemEntity,
    val variants: List<ItemVariantEntity>,
    val options: List<String>,
    val values: Map<String, List<String>>, // variant id to its option values
    val left: Map<String, Int>, // variant id to what the shop holds
    val counted: Boolean,
)

// A number being typed: how many, how heavy, what price, how much off.
class NumAsk(val title: String, val sub: String?, val unit: String, val decimals: Int, val start: String, val done: (String) -> Unit)

// Behind a shop's sell screen: the products from Room with what is left of
// each, the sale with its totals, and everything a cashier does to it. Every
// action reloads the sale from Room, so what is on screen is what is stored.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class RetailViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val tickets: TicketRepository,
    private val sales: RetailSales,
    private val orderOps: OrderOps,
    private val service: ServiceRepository,
    private val staff: StaffSession,
    private val approvals: Approvals,
    private val exchanges: Exchanges,
) : ViewModel() {
    private val _ui = MutableStateFlow(SaleUi())
    val ui: StateFlow<SaleUi> = _ui

    // what comes back in an exchange that is being rung up on the sale on screen
    val exchange: StateFlow<ExchangeDraft?> = combine(exchanges.drafts, _ui) { drafts, ui -> ui.ticket?.id?.let { drafts[it] } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)
    fun cancelExchange() {
        exchanges.cancel(_ui.value.ticket?.id)
        Toaster.say("Exchange cancelled. Nothing was refunded.")
    }

    private val store = flow { emit(session.storeId()) }
    val cats: StateFlow<List<CategoryEntity>> = db.catalog().categories().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    // null is "All"
    val cat = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    // a search looks through the whole catalog, not only the open category
    val products: StateFlow<List<ItemEntity>> = combine(cat, query) { c, q -> (if (q.isBlank()) c else null) to q.trim() }
        .distinctUntilChanged()
        .flatMapLatest { (c, q) -> db.retail().products(c, q) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val left: StateFlow<Map<String, ItemLeft>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else db.retail().leftByItem(s) }
        .map { rows -> rows.associateBy { it.item_id } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())
    val variantCounts: StateFlow<Map<String, Int>> = db.retail().variantCounts().map { rows -> rows.associate { it.item_id to it.n } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())
    // the sales set aside: counter orders that are open, hold something, and are not the one on screen
    val parked: StateFlow<List<OrderInfo>> = combine(store.flatMapLatest { s -> if (s == null) emptyFlow() else service.orders(s) }, _ui) { orders, ui ->
        orders.filter { it.open && it.kind == "counter" && it.id != ui.ticket?.id && it.lines.any { l -> !l.line.paid } }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val picking = MutableStateFlow<VariantPick?>(null)
    val asking = MutableStateFlow<NumAsk?>(null)

    private val json = Json { ignoreUnknownKeys = true }
    private fun strings(text: String): List<String> =
        runCatching { json.parseToJsonElement(text).jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull } }.getOrDefault(emptyList())

    // Called when the screen opens, and after a sale is paid: the sale on it may be another now.
    fun open() = viewModelScope.launch {
        picking.value = null
        asking.value = null
        reload()
    }

    private suspend fun reload() {
        sales.open()
        val t = tickets.activeTicket()
        val rows = if (t == null) emptyList() else db.tickets().lines(t.id).first()
        val infos = service.describe(rows)
        val discount = tickets.pendingDiscount()
        val lines = infos.map { info ->
            val l = info.line
            val item = l.item_id?.let { db.catalog().item(it) }
            val variant = l.variant_id?.let { db.retail().variant(it) }
            SaleLine(l, item?.name ?: l.name_snapshot, variant?.name, item?.sold_by == "weight", info.amount)
        }
        _ui.value = SaleUi(
            loaded = true, ticket = t, lines = lines, totals = service.dueOf(infos, 0, discount), lineOff = sales.saved(rows), discount = discount,
            customer = t?.customer_id?.let { db.customers().customer(it)?.name },
            open = _ui.value.open?.takeIf { id -> rows.any { it.id == id } },
        )
    }

    fun pickCat(id: String?) { cat.value = id; query.value = "" }
    fun toggle(lineId: String) { _ui.value = _ui.value.copy(open = if (_ui.value.open == lineId) null else lineId) }

    private suspend fun counted(item: ItemEntity): Boolean = item.track_stock || db.ops().categoryOfItem(item.id)?.is_stock == true

    // A tile was tapped. A product with variants asks which; one sold by
    // weight asks how heavy; the others go straight on.
    fun tap(item: ItemEntity) = viewModelScope.launch {
        if (!item.is_available) { Toaster.say("${item.name} is not on sale"); return@launch }
        val variants = db.retail().variantsOf(item.id)
        if (variants.isNotEmpty()) {
            val storeId = session.storeId()
            val levels = if (storeId == null) emptyList() else db.retail().levelsOf(storeId, item.id)
            picking.value = VariantPick(
                item, variants, strings(item.option_names), variants.associate { it.id to strings(it.option_values) },
                levels.associate { it.variant_id to it.qty }, counted(item),
            )
        } else put(item, null)
    }

    fun closePicker() { picking.value = null }
    fun pick(item: ItemEntity, variant: ItemVariantEntity) { picking.value = null; viewModelScope.launch { put(item, variant) } }

    private suspend fun put(item: ItemEntity, variant: ItemVariantEntity?) {
        if (item.sold_by == "weight") {
            val unit = variant?.price ?: item.price
            asking.value = NumAsk("How heavy?", "${sales.nameOf(item, variant)} · ${Money.format(unit)} a kilo", "kg", 3, "") { typed ->
                val grams = typed.toDoubleOrNull()?.let { Math.round(it * 1000).toInt() } ?: 0
                if (grams <= 0) Toaster.say("Type the weight in kilos") else viewModelScope.launch { add(item, variant, grams) }
            }
        } else add(item, variant, 1000)
    }

    private suspend fun add(item: ItemEntity, variant: ItemVariantEntity?, qty: Int) {
        sales.add(item, variant, qty).onFailure { Toaster.say(it.message) }
        reload()
    }

    // A barcode read by the scanner, or a whole code typed and entered: the
    // product that carries it goes on the sale. What the scanner typed into
    // the search box on its way is cleared.
    fun scanned(code: String) = viewModelScope.launch {
        query.value = ""
        when (val f = sales.find(code)) {
            is Found.Product -> put(f.item, f.variant)
            is Found.Pick -> tap(f.item)
            is Found.Several -> Toaster.say("Two products carry the code ${f.code}. Find it by its name.")
            is Found.Nothing -> Toaster.say("No product has the code ${f.code}. Nothing was added.")
        }
    }

    // Enter in the search box: a whole code adds its product; anything else stays a search.
    fun enter() = viewModelScope.launch {
        val q = query.value.trim()
        if (q.isEmpty()) return@launch
        when (val f = sales.find(q)) {
            is Found.Product -> { query.value = ""; put(f.item, f.variant) }
            is Found.Pick -> { query.value = ""; tap(f.item) }
            else -> products.value.singleOrNull()?.let { query.value = ""; tap(it) }
        }
    }

    // one more or one fewer; none left takes the line off
    fun bump(l: SaleLine, by: Int) = viewModelScope.launch {
        val qty = l.line.qty + by * 1000
        if (qty <= 0) { remove(l.line.id); return@launch }
        sales.edit(l.line.id, qty = qty).onFailure { Toaster.say(it.message) }
        reload()
    }

    // how many, typed; or how heavy, for what is weighed
    fun askQty(l: SaleLine) {
        asking.value = if (l.weighed) {
            NumAsk("How heavy?", l.name, "kg", 3, "") { typed ->
                val grams = typed.toDoubleOrNull()?.let { Math.round(it * 1000).toInt() } ?: 0
                if (grams <= 0) Toaster.say("Type the weight in kilos") else setQty(l.line.id, grams)
            }
        } else {
            NumAsk("How many?", listOfNotNull(l.name, l.variant).joinToString(", "), "", 0, "") { typed ->
                val n = typed.toIntOrNull() ?: 0
                if (n <= 0 || n > 9999) Toaster.say("Type how many, from 1 to 9999") else setQty(l.line.id, n * 1000)
            }
        }
    }

    private fun setQty(lineId: String, qty: Int) = viewModelScope.launch {
        sales.edit(lineId, qty = qty).onFailure { Toaster.say(it.message) }
        reload()
    }

    fun remove(lineId: String) = viewModelScope.launch { approved { by -> orderOps.remove(lineId, by) } }

    fun setNote(lineId: String, note: String) = viewModelScope.launch {
        sales.edit(lineId, note = note).onFailure { Toaster.say(it.message) }
        reload()
    }

    // ---- one line's price ----
    private fun listed(l: SaleLine) = l.line.list_price ?: l.line.unit_price

    fun percentOff(l: SaleLine, pct: Int) = viewModelScope.launch {
        val c = LinePrice.percentOff(listed(l), pct) ?: return@launch
        approved { by -> sales.edit(l.line.id, price = PriceEdit.To(c), approver = by) }
    }

    fun noDiscount(l: SaleLine) = viewModelScope.launch {
        sales.edit(l.line.id, price = PriceEdit.Back).onFailure { Toaster.say(it.message) }
        reload()
    }

    fun askPercent(l: SaleLine) {
        asking.value = NumAsk("Discount on this line", l.name, "%", 0, "") { typed ->
            val c = typed.toIntOrNull()?.let { LinePrice.percentOff(listed(l), it) }
            if (c == null) Toaster.say("Type a percentage from 1 to 100") else viewModelScope.launch { approved { by -> sales.edit(l.line.id, price = PriceEdit.To(c), approver = by) } }
        }
    }

    fun askAmountOff(l: SaleLine) {
        asking.value = NumAsk("Rupees off each", "${l.name} · listed at ${Money.format(listed(l))}", "Rs", 2, "") { typed ->
            val c = Money.parseRs(typed)?.let { LinePrice.amountOff(listed(l), it) { m -> Money.format(m) } }
            if (c == null) Toaster.say("Type an amount up to ${Money.format(listed(l))}") else viewModelScope.launch { approved { by -> sales.edit(l.line.id, price = PriceEdit.To(c), approver = by) } }
        }
    }

    fun askPrice(l: SaleLine) {
        asking.value = NumAsk("Price for this sale", "${l.name} · listed at ${Money.format(listed(l))}" + if (l.weighed) " a kilo" else "", "Rs", 2, "") { typed ->
            val price = Money.parseRs(typed)
            when {
                price == null -> Toaster.say("Type the price")
                price == listed(l) -> noDiscount(l)
                else -> LinePrice.changed(listed(l), price)?.let { c -> viewModelScope.launch { approved { by -> sales.edit(l.line.id, price = PriceEdit.To(c), approver = by) } } }
                    ?: Toaster.say("That is not a price")
            }
        }
    }

    fun closeAsk() { asking.value = null }

    // ---- the whole sale ----
    suspend fun discounts(): List<DiscountEntity> = db.catalog().discounts().filter { !it.requires_approval || staff.id() != null }

    // A discount this person may not give asks for someone who may; who
    // approved goes with it to the receipt.
    fun setDiscount(d: DiscountPick?, restricted: Boolean = false, by: StaffMember? = null) {
        if (_ui.value.empty) { Toaster.say("Ring something up first"); return }
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
            Toaster.say(if (d == null) "Discount taken off the sale" else "${d.name} off the sale")
        }
    }

    // a discount on the whole sale, typed on the till's keys
    fun askSaleDiscount(percent: Boolean) {
        asking.value = if (percent) {
            NumAsk("Discount on the sale", "A percentage off everything on it", "%", 0, "") { typed ->
                val pct = typed.toLongOrNull()?.takeIf { it in 1..100 }
                if (pct == null) Toaster.say("Type a percentage from 1 to 100") else setDiscount(DiscountPick(null, "percent", pct, "$pct%"))
            }
        } else {
            NumAsk("Discount on the sale", "Rupees off the whole sale", "Rs", 2, "") { typed ->
                val off = Money.parseRs(typed)?.takeIf { it > 0 }
                if (off == null) Toaster.say("Type the amount to take off") else setDiscount(DiscountPick(null, "amount", off, Money.format(off)))
            }
        }
    }

    fun setCustomer(customerId: String?) = viewModelScope.launch {
        if (_ui.value.ticket == null && customerId == null) return@launch
        tickets.setCustomer(customerId).onFailure { Toaster.say(it.message) }
        reload()
    }

    // Park: the sale waits as it is, and an empty one takes its place.
    fun park() = viewModelScope.launch {
        if (_ui.value.empty) { Toaster.say("This sale is empty. Scan or tap a product to start it."); return@launch }
        tickets.startOrder(tickets.counterTypeId())
        _ui.value = _ui.value.copy(open = null)
        reload()
        Toaster.say("Sale parked. It waits under Parked.")
    }

    // A parked sale comes back. The one on screen, if it holds anything, is parked in its turn.
    fun resume(ticketId: String) = viewModelScope.launch {
        tickets.select(ticketId)
        _ui.value = _ui.value.copy(open = null)
        reload()
    }

    // Clear: every line comes off and the sale is closed. One that is partly paid cannot be.
    fun clear() = viewModelScope.launch {
        val t = tickets.activeTicket() ?: return@launch
        if (db.tickets().allLines(t.id).any { it.paid && it.voided_at == null }) {
            Toaster.say("Part of this sale is already paid, so it cannot be cleared. Take payment for the rest.")
            return@launch
        }
        approved("Sale cleared") { by ->
            runCatching {
                val rows = db.tickets().allLines(t.id).filter { it.voided_at == null }
                if (rows.isNotEmpty()) staff.allow("sale.void_line", "take a line off a sale", by)
                rows.forEach { orderOps.remove(it.id, by).getOrThrow() }
                tickets.cancelOrder(t.id).getOrThrow()
                exchanges.cancel(t.id)
                tickets.newTicket()
                session.setPendingDiscount(null)
            }
        }
    }

    fun mayPay(): Boolean {
        if (_ui.value.empty) {
            Toaster.say(if (exchanges.of(_ui.value.ticket?.id) != null) "Ring up what the customer takes instead. To give the money back, cancel the exchange and refund the receipt." else "Ring something up before taking payment")
            return false
        }
        return true
    }

    // Runs something that may need someone else's go-ahead. If it does, asks
    // for it and runs the same thing again with whoever approved.
    private suspend fun approved(done: String? = null, by: StaffMember? = null, block: suspend (StaffMember?) -> Result<*>) {
        val out = block(by)
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) {
            approvals.ask(need.permission, need.what) { approver -> viewModelScope.launch { approved(done, approver, block) } }
        } else {
            out.fold({ done?.let { Toaster.say(it) } }, { Toaster.say(it.message) })
            reload()
        }
    }
}

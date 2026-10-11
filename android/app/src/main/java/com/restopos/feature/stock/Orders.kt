package com.restopos.feature.stock

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.common.Uuid7
import com.restopos.core.data.DocLines
import com.restopos.core.data.OrderForm
import com.restopos.core.data.PoFill
import com.restopos.core.data.RetailSales
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StockRepository
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.PurchaseOrderEntity
import com.restopos.core.database.PurchaseOrderLineEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.SupplierEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.panel
import com.restopos.core.ui.press
import com.restopos.feature.retail.NumAsk
import com.restopos.feature.retail.NumSheet
import com.restopos.feature.retail.ProductPane
import com.restopos.feature.retail.ProductPick
import com.restopos.feature.retail.WhichSheet
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// What an order's state reads as, and the colours of its chip.
internal fun orderState(status: String): Triple<String, Color, Color> = when (status) {
    "draft" -> Triple("Draft", V.Key, V.Text2)
    "sent" -> Triple("Sent", V.Blue.copy(alpha = 0.16f), V.BlueText)
    "part" -> Triple("Part received", V.Amber.copy(alpha = 0.18f), V.AmberText)
    "received" -> Triple("Received", V.Green.copy(alpha = 0.18f), V.GreenText)
    "closed" -> Triple("Closed", V.Key, V.Text2)
    "cancelled" -> Triple("Cancelled", V.Key, V.Text3)
    else -> Triple(status, V.Key, V.Text2)
}

// Behind the Orders tab: the shop's orders to its suppliers, the one being
// written, and one opened to look at. An order being written is kept on the
// tablet at every change (StockRepository), so closing the app or losing the
// connection in the middle of it costs nothing; its id is made when it is
// begun, so a save tried twice is one order.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class OrdersViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val sales: RetailSales,
    private val stock: StockRepository,
) : ViewModel() {
    private val store = flow { emit(session.storeId()) }
    private fun <T> kept(of: kotlinx.coroutines.flow.Flow<T>, first: T): StateFlow<T> = of.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), first)

    val orders: StateFlow<List<PurchaseOrderEntity>> = kept(store.flatMapLatest { s -> if (s == null) emptyFlow() else db.stock().orders(s) }, emptyList())
    val lines: StateFlow<Map<String, List<PurchaseOrderLineEntity>>> = kept(db.stock().everyOrderLine().map { rows -> rows.groupBy { it.order_id } }, emptyMap())
    // every supplier, removed ones too: an old order still names its own
    val suppliers: StateFlow<List<SupplierEntity>> = kept(db.stock().everySupplier(), emptyList())
    val items: StateFlow<Map<String, ItemEntity>> = db.stock().everyItem().map { rows -> rows.associateBy { it.id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    val variants: StateFlow<Map<String, ItemVariantEntity>> = db.stock().everyVariant().map { rows -> rows.associateBy { it.id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    private val levels: StateFlow<List<StockLevelEntity>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else db.retail().levels(s) }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    // the order being written, or none
    private val _draft = MutableStateFlow<OrderForm.Order?>(null)
    val draft: StateFlow<OrderForm.Order?> = _draft
    // a draft that was kept from before, when New order is tapped: carried on with, or thrown away
    val waiting = MutableStateFlow<OrderForm.Order?>(null)
    // the order opened to look at
    val open = MutableStateFlow<String?>(null)
    val asking = MutableStateFlow<NumAsk?>(null)
    val busy = MutableStateFlow(false)
    val problem = MutableStateFlow<String?>(null)
    // the lines the last save was refused for, marked on the list
    val marked = MutableStateFlow<Set<Pair<String, String>>>(emptySet())

    val pane = ProductPick(viewModelScope, db, session, sales, said = { i, v -> "Order · ${sales.nameOf(i, v)}" }, onAdd = { i, v -> add(i, v) })

    private fun counted(item: ItemEntity): Boolean = item.track_stock || pane.cats.value.firstOrNull { it.id == item.category_id }?.is_stock == true
    fun name(l: DocLines.Line): String = items.value[l.item]?.let { sales.nameOf(it, variants.value[l.variant]) } ?: "A product that is no longer there"
    fun name(item: String, variant: String): String = name(DocLines.Line(item, variant, 0, 0))
    fun weighed(item: String): Boolean = items.value[item]?.sold_by == "weight"
    fun supplierName(id: String?): String = suppliers.value.firstOrNull { it.id == id }?.name ?: "No supplier"

    private fun keep(o: OrderForm.Order) {
        _draft.value = o
        problem.value = null
        viewModelScope.launch { stock.keepOrderDraft(o) }
    }

    // ---- beginning, and coming back to, an order ----
    fun new() = viewModelScope.launch {
        val was = stock.orderDraft()
        if (was != null) waiting.value = was else keep(OrderForm.Order(Uuid7.next()))
    }
    fun carryOn() { waiting.value?.let { _draft.value = it }; waiting.value = null; marked.value = emptySet() }
    fun startAgain() = viewModelScope.launch { waiting.value = null; marked.value = emptySet(); stock.dropOrderDraft(); keep(OrderForm.Order(Uuid7.next())) }
    fun notNow() { waiting.value = null }

    // A row of the list was tapped. A draft is written on with the same id;
    // anything else is looked at.
    fun tap(o: PurchaseOrderEntity) = viewModelScope.launch {
        if (o.status != "draft") { open.value = o.id; return@launch }
        val was = stock.orderDraft()
        if (was != null && was.id != o.id) {
            Toaster.say("Another order is being written on this tablet. Tap New order to carry on with it or throw it away first.")
            return@launch
        }
        marked.value = emptySet()
        keep(was ?: OrderForm.Order(o.id, o.supplier_id, o.expected_on.orEmpty(), o.note.orEmpty(), db.stock().orderLines(o.id).map { DocLines.Line(it.item_id, it.variant_id, it.qty, it.unit_cost) }))
    }
    // The editor is left: what was typed stays kept, and New order offers it again.
    // One that was opened and left with nothing on it is not kept: there is nothing to come back to.
    fun leave() {
        if (busy.value) return
        val o = _draft.value
        _draft.value = null
        problem.value = null
        if (o != null && o.supplier == null && o.lines.isEmpty() && o.expectedOn.isBlank() && o.note.isBlank()) viewModelScope.launch { stock.dropOrderDraft() }
    }

    // ---- writing it ----
    fun supplier(id: String) { _draft.value?.let { keep(it.copy(supplier = id)) } }
    fun expected(day: String) { _draft.value?.let { keep(it.copy(expectedOn = day)) } }
    fun note(text: String) { _draft.value?.let { keep(it.copy(note = text.take(200))) } }

    // a tile tapped, a variant picked, a barcode scanned: one more of it, at what it last cost
    private fun add(item: ItemEntity, variant: ItemVariantEntity?): Boolean {
        val o = _draft.value ?: return false
        if (!counted(item)) {
            Toaster.say("${item.name}: its stock is not counted, so it is not ordered here. Switch on \"Count its stock\" for it on Products & stock.")
            return false
        }
        val line = variant?.id ?: ""
        val level = levels.value.firstOrNull { it.item_id == item.id && it.variant_id == line }
        keep(o.copy(lines = DocLines.add(o.lines, item.id, line, 1000, OrderForm.startCost(item, variant, level))))
        marked.value = marked.value - (item.id to line)
        return true
    }
    fun scanned(code: String) { if (_draft.value != null) pane.scanned(code) }

    fun askQty(l: DocLines.Line) {
        val w = weighed(l.item)
        asking.value = NumAsk(name(l), "How much to order", if (w) "kg" else "", if (w) 3 else 0, "") { typed ->
            val qty = DocLines.typed(typed)
            if (qty == null) Toaster.say("That is not a quantity.")
            else _draft.value?.let { keep(it.copy(lines = DocLines.setQty(it.lines, l.item, l.variant, qty))) }
        }
    }
    fun askCost(l: DocLines.Line) {
        asking.value = NumAsk(name(l), "What one costs", "Rs", 2, "") { typed ->
            val cost = DocLines.typedCost(typed)
            if (cost == null) Toaster.say("That is not an amount.")
            else _draft.value?.let { keep(it.copy(lines = DocLines.setCost(it.lines, l.item, l.variant, cost))) }
        }
    }
    fun closeAsk() { asking.value = null }
    fun remove(l: DocLines.Line) { _draft.value?.let { keep(it.copy(lines = DocLines.setQty(it.lines, l.item, l.variant, 0))) } }

    // Everything of this supplier's that is at or under the level it is ordered again at, and is not on the order yet.
    fun addLow() {
        val o = _draft.value ?: return
        val from = o.supplier
        if (from == null) { problem.value = "Pick the supplier first: what is low is looked for among their products."; return }
        val low = PoFill.low(from, o.lines, items.value.values.toList(), variants.value.values.toList(), levels.value, ::counted)
        if (low.isEmpty()) Toaster.say("Nothing of ${supplierName(from)}'s is low. A product is low when it is at or under the level set for ordering it again.")
        else { keep(o.copy(lines = o.lines + low)); Toaster.say(if (low.size == 1) "1 product that is low was added." else "${low.size} products that are low were added.") }
    }

    // what a save was refused for, and the lines it was refused for marked
    private fun failed(o: OrderForm.Order, e: Throwable) {
        problem.value = e.message ?: "That did not work. Try again."
        marked.value = DocLines.gone(o.lines, items.value, ::counted) { item -> variants.value.values.filter { it.item_id == item && it.deleted_at == null } }.map { it.item to it.variant }.toSet()
    }
    private suspend fun done(said: String) {
        stock.dropOrderDraft()
        _draft.value = null
        marked.value = emptySet()
        Toaster.say(said)
    }

    fun saveDraft(approver: StaffMember?) = viewModelScope.launch {
        val o = _draft.value ?: return@launch
        if (busy.value) return@launch
        OrderForm.problem(o, toSend = false)?.let { problem.value = it; return@launch }
        busy.value = true
        val out = stock.saveOrder(o, approver)
        busy.value = false
        out.fold({ done("The order is saved as a draft. It can be changed until it is sent.") }, { failed(o, it) })
    }

    fun send(approver: StaffMember?) = viewModelScope.launch {
        val o = _draft.value ?: return@launch
        if (busy.value) return@launch
        OrderForm.problem(o, toSend = true)?.let { problem.value = it; return@launch }
        busy.value = true
        val out = stock.saveAndSend(o, approver)
        busy.value = false
        out.fold(
            // nothing leaves the till for the supplier: "sent" fixes the order's lines, as in the back office
            { done("The order to ${supplierName(o.supplier)} is marked as sent, and its lines are fixed. Tell the supplier as you always do. What arrives is received under Deliveries.") },
            // saved, and not sent: it is a draft in the list now, and nothing of it is the tablet's own any more
            { e -> if (e is StockRepository.SavedNotSent) done(e.message ?: "The order is saved as a draft, but it was not sent.") else failed(o, e) },
        )
    }

    // ---- an order that is looked at ----
    fun shut() { if (!busy.value) { open.value = null; problem.value = null } }
    private fun state(what: suspend () -> Result<Unit>, said: String) = viewModelScope.launch {
        if (busy.value) return@launch
        busy.value = true
        val out = what()
        busy.value = false
        out.fold({ open.value = null; problem.value = null; Toaster.say(said) }, { problem.value = it.message ?: "That did not work. Try again." })
    }
    fun cancel(id: String, approver: StaffMember?) = state({ stock.cancelOrder(id, approver) }, "The order is cancelled.")
    fun close(id: String, approver: StaffMember?) = state({ stock.closeOrder(id, approver) }, "The order is closed: the rest of it is not expected.")
}

// Orders: the list, or the order being written.
// approver: who gave their word for this tab, when the person at the till may not order. costs: rupees of cost may be shown.
// onReceive: an order that is waiting is handed to Deliveries.
@Composable
fun OrdersTab(vm: OrdersViewModel, approver: StaffMember?, costs: Boolean, onReceive: (PurchaseOrderEntity) -> Unit) {
    val draft by vm.draft.collectAsState()
    val waiting by vm.waiting.collectAsState()
    val open by vm.open.collectAsState()
    val asking by vm.asking.collectAsState()
    val picking by vm.pane.picking.collectAsState()
    // while an order is being written, a scanned barcode is one more of its product
    LaunchedEffect(Unit) { Scanner.codes.collect { vm.scanned(it) } }

    val o = draft
    if (o == null) OrderList(vm, costs) else OrderEdit(vm, o, approver)

    waiting?.let { was ->
        Sheet(onDismiss = { vm.notNow() }, width = 560.dp) {
            SheetHead("An order was being written", "${vm.supplierName(was.supplier)} · ${lineCount(was.lines.size)}") { vm.notNow() }
            T("It was kept on this tablet. Carry on with it, or throw it away and start a new one.", 15.sp, 500, V.Text2, lines = 3)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Throw it away", Modifier.weight(1f), fg = V.Red) { vm.startAgain() }
                VBtn("Carry on with it", Modifier.weight(1f), V.Blue, Color.White, weight = 800) { vm.carryOn() }
            }
        }
    }
    open?.let { id -> OrderRecord(vm, id, approver, costs, onReceive) }
    picking?.let { WhichSheet(vm.pane, it, "Which ones are ordered? One of each is added: change how many on the order.", none = "Tap the ones to order") { n -> if (n == 1) "Add 1 to the order" else "Add $n to the order" } }
    asking?.let { NumSheet(it) { vm.closeAsk() } }
}

private fun lineCount(n: Int) = if (n == 1) "1 product" else "$n products"

@Composable
private fun OrderList(vm: OrdersViewModel, costs: Boolean) {
    val orders by vm.orders.collectAsState()
    val lines by vm.lines.collectAsState()
    val suppliers by vm.suppliers.collectAsState()
    val names = remember(suppliers) { suppliers.associate { it.id to it.name } }
    val groups = listOf(
        "Drafts" to orders.filter { it.status == "draft" },
        "Waiting for the supplier" to orders.filter { it.status == "sent" || it.status == "part" },
        "Finished" to orders.filter { it.status !in setOf("draft", "sent", "part") },
    ).filter { it.second.isNotEmpty() }

    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            T(if (orders.size == 1) "1 order" else "${orders.size} orders", 15.sp, 600, V.Text2)
            Gap()
            VBtn("New order", bg = V.Blue, fg = Color.White, height = 48.dp, pad = 20.dp, icon = VI.Plus) { vm.new() }
        }
        if (orders.isEmpty()) {
            T("No order yet. An order is written to a supplier, sent, and what arrives is received against it under Deliveries.", 15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3)
        } else LazyColumn(Modifier.fillMaxWidth().weight(1f).panel(), contentPadding = PaddingValues(vertical = 6.dp)) {
            groups.forEach { (title, rows) ->
                item(key = title) { Caps(title, modifier = Modifier.padding(start = 18.dp, top = 12.dp, bottom = 4.dp)) }
                items(rows, key = { it.id }) { o ->
                    val of = lines[o.id].orEmpty().map { DocLines.Line(it.item_id, it.variant_id, it.qty, it.unit_cost) }
                    Row(
                        Modifier.fillMaxWidth().press(0.99f) { vm.tap(o) }.padding(horizontal = 18.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            T("${o.number} · ${names[o.supplier_id] ?: "A supplier"}", 16.sp, 700)
                            T(listOfNotNull(lineCount(of.size), o.expected_on?.let { "expected $it" }, if (costs) Money.format(DocLines.value(of)) else null).joinToString(" · "), 13.sp, 500, V.Text2)
                        }
                        val (word, bg, fg) = orderState(o.status)
                        Chip(word, bg, fg)
                    }
                }
            }
        }
    }
}

// An order being written: on the left what it holds, on the right the products to tap or scan onto it.
@Composable
private fun OrderEdit(vm: OrdersViewModel, o: OrderForm.Order, approver: StaffMember?) {
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    val marked by vm.marked.collectAsState()
    val suppliers by vm.suppliers.collectAsState()
    // read so that a product's name follows a change of it
    val items by vm.items.collectAsState()
    var picking by remember { mutableStateOf(false) }

    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        // The column is kept low: on a 10-inch drawn a fifth larger it has some 490 dp of height,
        // and the lines of the order are what has to be seen. One row a line, three rows of keys.
        Column(Modifier.width(460.dp).fillMaxHeight().panel().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                T("Order to a supplier", 19.sp, 800, spacing = (-0.4).sp)
                Gap()
                VBtn("Back to the list", height = 40.dp, pad = 14.dp, size = 14.sp, enabled = !busy) { vm.leave() }
            }
            VBtn(if (o.supplier == null) "Pick the supplier" else vm.supplierName(o.supplier), Modifier.fillMaxWidth(), bg = if (o.supplier == null) V.Blue else V.Key, fg = if (o.supplier == null) Color.White else V.Text, height = 44.dp) { picking = true }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(o.expectedOn, { vm.expected(it.filter { c -> c.isDigit() || c == '-' }.take(10)) }, "Expected: 2026-10-20", Modifier.weight(1f), height = 44.dp)
                Field(o.note, { vm.note(it) }, "A note for it", Modifier.weight(1f), height = 44.dp)
            }
            if (o.lines.isEmpty()) {
                T("Nothing on it yet. Tap a product on the right, search for one, or scan it. Add what is low puts on everything of this supplier's that is due to be ordered again.", 14.sp, 500, V.Text2, Modifier.weight(1f).padding(vertical = 12.dp), lines = 6)
            } else LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(o.lines, key = { it.item + "/" + it.variant }) { l ->
                    DocLineRow(
                        if (items.isEmpty()) "" else vm.name(l), Money.format(DocLines.value(l)), DocLines.shown(l.qty, vm.weighed(l.item)), Money.format(l.cost),
                        bad = (l.item to l.variant) in marked, onQty = { vm.askQty(l) }, onCost = { vm.askCost(l) }, onRemove = { vm.remove(l) },
                    )
                }
            }
            problem?.let {
                T(it, 14.sp, 600, V.Red, Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(V.Red.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 8.dp), lines = 4)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                T(lineCount(o.lines.size), 14.sp, 600, V.Text2)
                Gap()
                T(Money.format(DocLines.value(o.lines)), 18.sp, 800)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VBtn("Add what is low", Modifier.weight(1f), height = 48.dp, size = 14.sp, enabled = !busy) { vm.addLow() }
                VBtn(if (busy) "Saving…" else "Save as a draft", Modifier.weight(1f), height = 48.dp, size = 14.sp, enabled = !busy) { vm.saveDraft(approver) }
                VBtn(if (busy) "Sending…" else "Send", Modifier.weight(1f), V.Green, V.GreenInk, 48.dp, weight = 800, enabled = !busy) { vm.send(approver) }
            }
        }
        ProductPane(vm.pane, Modifier.weight(1f))
    }

    if (picking) Sheet(onDismiss = { picking = false }, width = 520.dp, gap = 10.dp) {
        SheetHead("Which supplier?") { picking = false }
        val live = suppliers.filter { it.deleted_at == null }.sortedBy { it.name.lowercase() }
        if (live.isEmpty()) T("No supplier yet. Add who the shop buys from under Suppliers, then come back.", 15.sp, 500, V.Text2, lines = 3)
        else LazyColumn(Modifier.heightIn(max = 380.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(live, key = { it.id }) { s ->
                VBtn(s.name, Modifier.fillMaxWidth(), bg = if (s.id == o.supplier) V.On else V.Key, fg = if (s.id == o.supplier) V.OnText else V.Text, height = 52.dp) { vm.supplier(s.id); picking = false }
            }
        }
    }
}

// An order that is sent or finished, to look at: what was ordered, what has arrived, what is still due.
@Composable
private fun OrderRecord(vm: OrdersViewModel, id: String, approver: StaffMember?, costs: Boolean, onReceive: (PurchaseOrderEntity) -> Unit) {
    val orders by vm.orders.collectAsState()
    val lines by vm.lines.collectAsState()
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    val items by vm.items.collectAsState()
    val o = orders.firstOrNull { it.id == id } ?: return
    val of = lines[id].orEmpty()
    var asking by remember(id) { mutableStateOf<String?>(null) } // cancel | close
    val (word, _, _) = orderState(o.status)

    Sheet(onDismiss = { vm.shut() }, width = 640.dp, gap = 12.dp) {
        SheetHead("${o.number} · ${vm.supplierName(o.supplier_id)}", listOfNotNull(word, o.expected_on?.let { "expected $it" }, o.note).joinToString(" · ")) { vm.shut() }
        when (asking) {
            "cancel" -> {
                T("Cancel ${o.number}? Nothing has arrived for it. It stays in the list as cancelled.", 15.sp, 500, V.Text2, lines = 3)
                problem?.let { T(it, 14.sp, 600, V.Red, lines = 3) }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VBtn("Keep it", Modifier.weight(1f), enabled = !busy) { asking = null }
                    VBtn(if (busy) "Cancelling…" else "Cancel the order", Modifier.weight(1f), V.Red, Color.White, weight = 800, enabled = !busy) { vm.cancel(id, approver) }
                }
            }
            "close" -> {
                T("Close ${o.number}? Part of it has arrived. Closing says the rest will not come: nothing more is received against it.", 15.sp, 500, V.Text2, lines = 4)
                problem?.let { T(it, 14.sp, 600, V.Red, lines = 3) }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VBtn("Leave it open", Modifier.weight(1f), enabled = !busy) { asking = null }
                    VBtn(if (busy) "Closing…" else "Close the order", Modifier.weight(1f), V.Blue, Color.White, weight = 800, enabled = !busy) { vm.close(id, approver) }
                }
            }
            else -> {
                Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                    Caps("Product", modifier = Modifier.weight(1f))
                    Caps("Ordered", modifier = Modifier.width(84.dp))
                    Caps("Arrived", modifier = Modifier.width(84.dp))
                    Caps("Still due", modifier = Modifier.width(84.dp))
                }
                LazyColumn(Modifier.heightIn(max = 300.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(of, key = { it.item_id + "/" + it.variant_id }) { l ->
                        val w = vm.weighed(l.item_id)
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(V.Well).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                T(if (items.isEmpty()) "" else vm.name(l.item_id, l.variant_id), 15.sp, 700, lines = 2)
                                if (costs) T("${Money.format(l.unit_cost)} each", 12.sp, 500, V.Text3)
                            }
                            T(DocLines.shown(l.qty, w), 15.sp, 700, modifier = Modifier.width(84.dp))
                            T(DocLines.shown(l.received, w), 15.sp, 600, V.Text2, Modifier.width(84.dp))
                            val due = (l.qty - l.received).coerceAtLeast(0)
                            T(if (due == 0) "—" else DocLines.shown(due, w), 15.sp, 700, if (due == 0) V.Text3 else V.AmberText, Modifier.width(84.dp))
                        }
                    }
                }
                if (costs) Row { T("The order", 14.sp, 600, V.Text2); Gap(); T(Money.format(DocLines.value(of.map { DocLines.Line(it.item_id, it.variant_id, it.qty, it.unit_cost) })), 16.sp, 800) }
                problem?.let { T(it, 14.sp, 600, V.Red, lines = 3) }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (o.status == "sent") VBtn("Cancel order", Modifier.weight(1f), fg = V.Red) { asking = "cancel" }
                    if (o.status == "part") VBtn("Close order", Modifier.weight(1f)) { asking = "close" }
                    if (o.status == "sent" || o.status == "part") VBtn("Receive", Modifier.weight(2f), V.Green, V.GreenInk, weight = 800) { vm.shut(); onReceive(o) }
                    if (o.status !in setOf("sent", "part")) VBtn("Done", Modifier.weight(1f)) { vm.shut() }
                }
            }
        }
    }
}

// One line of an order or of a delivery, as one row: what it is, a word under
// it, the quantity and what one costs as keys to tap, and the key that takes
// it off. bad: the last save was refused for this line.
@Composable
internal fun DocLineRow(name: String, under: String, qty: String, cost: String, bad: Boolean, onQty: () -> Unit, onCost: () -> Unit, onRemove: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (bad) V.Red.copy(alpha = 0.12f) else V.Well).padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(name, 14.sp, 700, if (bad) V.Red else V.Text, lines = 2, height = 17.sp)
            T(under, 12.sp, 500, V.Text3)
        }
        VBtn(qty, height = 44.dp, pad = 12.dp, size = 15.sp, weight = 800) { onQty() }
        VBtn(cost, height = 44.dp, pad = 10.dp, size = 14.sp) { onCost() }
        com.restopos.core.ui.IconKey(VI.Close, size = 44.dp, onClick = onRemove)
    }
}

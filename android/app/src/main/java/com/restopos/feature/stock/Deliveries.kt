package com.restopos.feature.stock

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import com.restopos.core.data.DeliveryForm
import com.restopos.core.data.DocLines
import com.restopos.core.data.OrderForm
import com.restopos.core.data.RetailSales
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StockRepository
import com.restopos.core.database.DeliveryEntity
import com.restopos.core.database.DeliveryLineEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.PurchaseOrderEntity
import com.restopos.core.database.PurchaseOrderLineEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.SupplierEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
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

// What arrived, for Print labels: the product, its variant, and how many labels.
typealias LabelsFor = List<Triple<ItemEntity, ItemVariantEntity?, Int>>

// Behind the Deliveries tab: what has arrived from suppliers, and the delivery
// being typed. A delivery is written once and never changed: the stock goes
// up and each product costs what was paid. The one being typed is kept on the
// tablet at every change, and its id is made when it is begun, so receiving
// it twice after a lost answer is one delivery.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class ReceiveViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val sales: RetailSales,
    private val stock: StockRepository,
) : ViewModel() {
    private val store = flow { emit(session.storeId()) }
    private fun <T> kept(of: kotlinx.coroutines.flow.Flow<T>, first: T): StateFlow<T> = of.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), first)

    val deliveries: StateFlow<List<DeliveryEntity>> = kept(store.flatMapLatest { s -> if (s == null) emptyFlow() else db.stock().deliveries(s) }, emptyList())
    val lines: StateFlow<Map<String, List<DeliveryLineEntity>>> = kept(db.stock().everyDeliveryLine().map { rows -> rows.groupBy { it.delivery_id } }, emptyMap())
    val orders: StateFlow<List<PurchaseOrderEntity>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else db.stock().orders(s) }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val orderLines: StateFlow<Map<String, List<PurchaseOrderLineEntity>>> = db.stock().everyOrderLine().map { rows -> rows.groupBy { it.order_id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    val suppliers: StateFlow<List<SupplierEntity>> = kept(db.stock().everySupplier(), emptyList())
    val staffNames: StateFlow<Map<String, String>> = kept(db.stock().staffNames().map { rows -> rows.associate { it.id to it.name } }, emptyMap())
    val items: StateFlow<Map<String, ItemEntity>> = db.stock().everyItem().map { rows -> rows.associateBy { it.id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    val variants: StateFlow<Map<String, ItemVariantEntity>> = db.stock().everyVariant().map { rows -> rows.associateBy { it.id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    private val levels: StateFlow<List<StockLevelEntity>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else db.retail().levels(s) }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    // the delivery being typed, or none
    private val _draft = MutableStateFlow<DeliveryForm.Delivery?>(null)
    val draft: StateFlow<DeliveryForm.Delivery?> = _draft
    // "Receive stock" was tapped: which order it is for, or none; with a delivery kept from before offered first
    val choosing = MutableStateFlow(false)
    val waiting = MutableStateFlow<DeliveryForm.Delivery?>(null)
    // the last sheet before it is received, and the one after
    val confirming = MutableStateFlow(false)
    val received = MutableStateFlow<DeliveryForm.Delivery?>(null)
    // a delivery opened to look at
    val open = MutableStateFlow<String?>(null)
    val asking = MutableStateFlow<NumAsk?>(null)
    val busy = MutableStateFlow(false)
    val problem = MutableStateFlow<String?>(null)
    val marked = MutableStateFlow<Set<Pair<String, String>>>(emptySet())

    val pane = ProductPick(viewModelScope, db, session, sales, said = { i, v -> "Delivery · ${sales.nameOf(i, v)}" }, onAdd = { i, v -> add(i, v) })

    private fun today(): String = java.time.LocalDate.now().toString()
    private fun counted(item: ItemEntity): Boolean = item.track_stock || pane.cats.value.firstOrNull { it.id == item.category_id }?.is_stock == true
    fun name(item: String, variant: String): String = items.value[item]?.let { sales.nameOf(it, variants.value[variant]) } ?: "A product that is no longer there"
    fun weighed(item: String): Boolean = items.value[item]?.sold_by == "weight"
    fun supplierName(id: String?): String = suppliers.value.firstOrNull { it.id == id }?.name ?: "No supplier"
    fun orderNumber(id: String?): String? = orders.value.firstOrNull { it.id == id }?.number
    fun waitingOrders(): List<PurchaseOrderEntity> = orders.value.filter { it.status == "sent" || it.status == "part" }

    private fun keep(d: DeliveryForm.Delivery) {
        _draft.value = d
        problem.value = null
        viewModelScope.launch { stock.keepDeliveryDraft(d) }
    }

    // ---- beginning one ----
    fun start() = viewModelScope.launch { waiting.value = stock.deliveryDraft(); choosing.value = true }
    fun notNow() { choosing.value = false; waiting.value = null }
    fun carryOn() { waiting.value?.let { _draft.value = it }; notNow(); marked.value = emptySet() }
    // For an order that is waiting: it starts with what is still due of each line, at the order's cost.
    fun forOrder(o: PurchaseOrderEntity) = viewModelScope.launch {
        notNow(); marked.value = emptySet()
        keep(DeliveryForm.fromOrder(Uuid7.next(), o, db.stock().orderLines(o.id), today()))
    }
    fun withoutOrder() { notNow(); marked.value = emptySet(); keep(DeliveryForm.Delivery(Uuid7.next(), arrivedOn = today())) }
    // The editor is left: what was typed stays kept, and Receive stock offers it again.
    // One begun with no order and left with nothing on it is not kept: there is nothing to come back to.
    fun leave() {
        if (busy.value) return
        val d = _draft.value
        _draft.value = null
        problem.value = null
        confirming.value = false
        if (d != null && d.order == null && d.supplier == null && d.lines.isEmpty() && d.invoice.isBlank() && d.note.isBlank()) viewModelScope.launch { stock.dropDeliveryDraft() }
    }
    fun throwAway() = viewModelScope.launch { if (!busy.value) { stock.dropDeliveryDraft(); _draft.value = null; problem.value = null; confirming.value = false } }

    // ---- typing it ----
    fun supplier(id: String?) { _draft.value?.takeIf { it.order == null }?.let { keep(it.copy(supplier = id)) } }
    fun invoice(text: String) { _draft.value?.let { keep(it.copy(invoice = text.take(60))) } }
    fun day(text: String) { _draft.value?.let { keep(it.copy(arrivedOn = text)) } }
    fun note(text: String) { _draft.value?.let { keep(it.copy(note = text.take(200))) } }

    private fun add(item: ItemEntity, variant: ItemVariantEntity?): Boolean {
        val d = _draft.value ?: return false
        if (!counted(item)) {
            Toaster.say("${item.name}: its stock is not counted, so it is not received here. Switch on \"Count its stock\" for it on Products & stock.")
            return false
        }
        val line = variant?.id ?: ""
        val level = levels.value.firstOrNull { it.item_id == item.id && it.variant_id == line }
        keep(d.copy(lines = DocLines.add(d.lines, item.id, line, 1000, OrderForm.startCost(item, variant, level))))
        marked.value = marked.value - (item.id to line)
        return true
    }
    fun scanned(code: String) { if (_draft.value != null && !confirming.value) pane.scanned(code) }

    fun askQty(l: DocLines.Line) {
        val w = weighed(l.item)
        asking.value = NumAsk(name(l.item, l.variant), "How much arrived", if (w) "kg" else "", if (w) 3 else 0, "") { typed ->
            val qty = DocLines.typed(typed)
            if (qty == null) Toaster.say("That is not a quantity.")
            else _draft.value?.let { keep(it.copy(lines = DocLines.setQty(it.lines, l.item, l.variant, qty))) }
        }
    }
    fun askCost(l: DocLines.Line) {
        asking.value = NumAsk(name(l.item, l.variant), "What one cost", "Rs", 2, "") { typed ->
            val cost = DocLines.typedCost(typed)
            if (cost == null) Toaster.say("That is not an amount.")
            else _draft.value?.let { keep(it.copy(lines = DocLines.setCost(it.lines, l.item, l.variant, cost))) }
        }
    }
    fun closeAsk() { asking.value = null }
    fun remove(l: DocLines.Line) { _draft.value?.let { keep(it.copy(lines = DocLines.setQty(it.lines, l.item, l.variant, 0))) } }

    // ---- receiving it ----
    fun ask() {
        val d = _draft.value ?: return
        val wrong = DeliveryForm.problem(d) ?: if (runCatching { java.time.LocalDate.parse(d.arrivedOn) }.isFailure) "The day it arrived is written like 2026-10-20." else null
        if (wrong != null) problem.value = wrong else { problem.value = null; confirming.value = true }
    }
    fun back() { if (!busy.value) confirming.value = false }
    fun receive(approver: StaffMember?) = viewModelScope.launch {
        val d = _draft.value ?: return@launch
        if (busy.value) return@launch
        busy.value = true
        val out = stock.receive(d, approver)
        busy.value = false
        confirming.value = false
        out.fold(
            {
                stock.dropDeliveryDraft()
                _draft.value = null
                marked.value = emptySet()
                received.value = d
            },
            { e ->
                problem.value = e.message ?: "That did not work. Try again."
                marked.value = DocLines.gone(d.lines, items.value, ::counted) { item -> variants.value.values.filter { it.item_id == item && it.deleted_at == null } }.map { it.item to it.variant }.toSet()
            },
        )
    }
    // what Print labels is handed for the delivery just received
    fun labels(d: DeliveryForm.Delivery): LabelsFor =
        DeliveryForm.labels(DocLines.merged(d.lines)) { item -> items.value[item]?.sold_by ?: "each" }.mapNotNull { (l, copies) ->
            val item = items.value[l.item] ?: return@mapNotNull null
            Triple(item, variants.value[l.variant], copies)
        }
    fun finish() { received.value = null }
    fun shut() { open.value = null }
}

// Deliveries: the list, or the delivery being typed.
// approver: who gave their word for this tab. costs: rupees of cost may be shown.
// order: an order handed over from Orders to be received (taken once). onLabels: Print labels for what arrived, when the till has it.
@Composable
fun DeliveriesTab(vm: ReceiveViewModel, approver: StaffMember?, costs: Boolean, order: PurchaseOrderEntity?, onTaken: () -> Unit, onLabels: ((LabelsFor) -> Unit)?) {
    val draft by vm.draft.collectAsState()
    val choosing by vm.choosing.collectAsState()
    val waiting by vm.waiting.collectAsState()
    val open by vm.open.collectAsState()
    val asking by vm.asking.collectAsState()
    val picking by vm.pane.picking.collectAsState()
    val received by vm.received.collectAsState()
    // read here so that the names and the waiting orders are there when a sheet asks for them
    val orders by vm.orders.collectAsState()
    LaunchedEffect(order?.id) { if (order != null) { vm.forOrder(order); onTaken() } }
    // while a delivery is being typed, a scanned barcode is one more of its product
    LaunchedEffect(Unit) { Scanner.codes.collect { vm.scanned(it) } }

    val d = draft
    if (d == null) DeliveryList(vm, costs) else Receive(vm, d, approver)

    if (choosing) Sheet(onDismiss = { vm.notNow() }, width = 600.dp, gap = 10.dp) {
        SheetHead("Receive stock", "What arrived is for an order, or for none.") { vm.notNow() }
        waiting?.let { was ->
            VBtn("Carry on with the one being typed (${was.lines.size} ${if (was.lines.size == 1) "line" else "lines"})", Modifier.fillMaxWidth(), V.Blue, Color.White, weight = 800) { vm.carryOn() }
        }
        val due = orders.filter { it.status == "sent" || it.status == "part" }
        if (due.isNotEmpty()) Caps("Orders that are waiting")
        LazyColumn(Modifier.heightIn(max = 300.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(due, key = { it.id }) { o ->
                VBtn("${o.number} · ${vm.supplierName(o.supplier_id)}" + if (o.status == "part") " · part received" else "", Modifier.fillMaxWidth(), height = 52.dp) { vm.forOrder(o) }
            }
        }
        VBtn("No order", Modifier.fillMaxWidth(), height = 52.dp) { vm.withoutOrder() }
        if (waiting != null) T("Starting another throws away the one that was being typed.", 13.sp, 500, V.Text3, lines = 2)
    }
    open?.let { id -> DeliveryRecord(vm, id, costs) }
    received?.let { was ->
        Sheet(onDismiss = { vm.finish() }, width = 560.dp) {
            SheetHead("The stock is in", "${DocLines.merged(was.lines).size} ${if (DocLines.merged(was.lines).size == 1) "product" else "products"} · ${Money.format(DocLines.value(DocLines.merged(was.lines)))}") { vm.finish() }
            T("What arrived is on the shelves' count, and each product costs what was paid for it.", 15.sp, 500, V.Text2, lines = 3)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (onLabels != null) VBtn("Print labels for this delivery", Modifier.weight(1f)) { val rows = vm.labels(was); vm.finish(); onLabels(rows) }
                VBtn("Done", Modifier.weight(1f), V.Green, V.GreenInk, weight = 800) { vm.finish() }
            }
        }
    }
    picking?.let { WhichSheet(vm.pane, it, "Which ones arrived? One of each is added: change how many on the delivery.", none = "Tap the ones that arrived") { n -> if (n == 1) "Add 1" else "Add $n" } }
    asking?.let { NumSheet(it) { vm.closeAsk() } }
}

@Composable
private fun DeliveryList(vm: ReceiveViewModel, costs: Boolean) {
    val deliveries by vm.deliveries.collectAsState()
    val lines by vm.lines.collectAsState()
    // read so that a supplier's name and an order's number follow their rows
    val suppliers by vm.suppliers.collectAsState()
    val orders by vm.orders.collectAsState()

    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            T(if (deliveries.size == 1) "1 delivery" else "${deliveries.size} deliveries", 15.sp, 600, V.Text2)
            Gap()
            VBtn("Receive stock", bg = V.Blue, fg = Color.White, height = 48.dp, pad = 20.dp, icon = VI.Plus) { vm.start() }
        }
        if (deliveries.isEmpty()) {
            T("Nothing received yet. What arrives from a supplier is received here, with or without an order: the stock goes up and the product costs what was paid.", 15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3)
        } else LazyColumn(Modifier.fillMaxWidth().weight(1f).panel(), contentPadding = PaddingValues(vertical = 6.dp)) {
            items(deliveries, key = { it.id }) { d ->
                val of = lines[d.id].orEmpty().map { DocLines.Line(it.item_id, it.variant_id, it.qty, it.unit_cost) }
                Row(
                    Modifier.fillMaxWidth().press(0.99f) { vm.open.value = d.id }.padding(horizontal = 18.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        T("${d.number} · ${if (suppliers.isEmpty() && d.supplier_id != null) "" else vm.supplierName(d.supplier_id)}", 16.sp, 700)
                        T(listOfNotNull(d.arrived_on, (if (orders.isEmpty()) null else vm.orderNumber(d.order_id))?.let { "for $it" }, if (of.size == 1) "1 product" else "${of.size} products").joinToString(" · "), 13.sp, 500, V.Text2)
                    }
                    if (costs) T(Money.format(DocLines.value(of)), 15.sp, 700)
                }
            }
        }
    }
}

// A delivery being typed: on the left what arrived, on the right the products to tap or scan onto it.
@Composable
private fun Receive(vm: ReceiveViewModel, d: DeliveryForm.Delivery, approver: StaffMember?) {
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    val marked by vm.marked.collectAsState()
    val suppliers by vm.suppliers.collectAsState()
    val items by vm.items.collectAsState()
    val orderLines by vm.orderLines.collectAsState()
    val confirming by vm.confirming.collectAsState()
    var picking by remember { mutableStateOf(false) }
    val ordered = d.order?.let { orderLines[it] }.orEmpty().associateBy { it.item_id to it.variant_id }

    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        // kept low, as an order's column is (Orders.kt): the lines that arrived are what has to be seen
        Column(Modifier.width(460.dp).fillMaxHeight().panel().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                T(vm.orderNumber(d.order)?.let { "Receiving $it" } ?: "Receiving, no order", 19.sp, 800, spacing = (-0.4).sp)
                Gap()
                VBtn("Back to the list", height = 40.dp, pad = 14.dp, size = 14.sp, enabled = !busy) { vm.leave() }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                // with an order the supplier is the order's
                if (d.order != null) T("From ${vm.supplierName(d.supplier)}", 15.sp, 600, V.Text2, Modifier.weight(1f))
                else VBtn(if (d.supplier == null) "From: no supplier named" else "From ${vm.supplierName(d.supplier)}", Modifier.weight(1f), height = 44.dp, size = 14.sp) { picking = true }
                Field(d.arrivedOn, { vm.day(it.filter { c -> c.isDigit() || c == '-' }.take(10)) }, "Arrived: 2026-10-20", Modifier.width(150.dp), height = 44.dp)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(d.invoice, { vm.invoice(it) }, "Invoice number", Modifier.weight(1f), height = 44.dp)
                Field(d.note, { vm.note(it) }, "A note for it", Modifier.weight(1f), height = 44.dp)
            }
            if (d.lines.isEmpty()) {
                T("Nothing on it yet. Tap what arrived on the right, search for it, or scan it.", 14.sp, 500, V.Text2, Modifier.weight(1f).padding(vertical = 12.dp), lines = 4)
            } else LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(d.lines, key = { it.item + "/" + it.variant }) { l ->
                    val w = vm.weighed(l.item)
                    // against an order: what was ordered of it and what is still to come; otherwise what the line is worth
                    val under = if (d.order == null) Money.format(DocLines.value(l))
                    else (ordered[l.item to l.variant]?.let { ol -> "Ordered ${DocLines.shown(ol.qty, w)} · due ${DocLines.shown((ol.qty - ol.received).coerceAtLeast(0), w)}" } ?: "Not on the order") + " · " + Money.format(DocLines.value(l))
                    DocLineRow(
                        if (items.isEmpty()) "" else vm.name(l.item, l.variant), under, DocLines.shown(l.qty, w), Money.format(l.cost),
                        bad = (l.item to l.variant) in marked, onQty = { vm.askQty(l) }, onCost = { vm.askCost(l) }, onRemove = { vm.remove(l) },
                    )
                }
            }
            problem?.let {
                T(it, 14.sp, 600, V.Red, Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(V.Red.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 8.dp), lines = 4)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                T(if (d.lines.size == 1) "1 product" else "${d.lines.size} products", 14.sp, 600, V.Text2)
                Gap()
                T(Money.format(DocLines.value(d.lines)), 18.sp, 800)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VBtn("Throw away", Modifier.weight(1f), height = 48.dp, size = 14.sp, fg = V.Red, enabled = !busy) { vm.throwAway() }
                VBtn("Receive", Modifier.weight(2f), V.Green, V.GreenInk, 48.dp, weight = 800, enabled = !busy) { vm.ask() }
            }
        }
        ProductPane(vm.pane, Modifier.weight(1f))
    }

    if (picking) Sheet(onDismiss = { picking = false }, width = 520.dp, gap = 10.dp) {
        SheetHead("Who is it from?") { picking = false }
        val live = suppliers.filter { it.deleted_at == null }.sortedBy { it.name.lowercase() }
        VBtn("No supplier named", Modifier.fillMaxWidth(), bg = if (d.supplier == null) V.On else V.Key, fg = if (d.supplier == null) V.OnText else V.Text, height = 52.dp) { vm.supplier(null); picking = false }
        LazyColumn(Modifier.heightIn(max = 340.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(live, key = { it.id }) { s ->
                VBtn(s.name, Modifier.fillMaxWidth(), bg = if (s.id == d.supplier) V.On else V.Key, fg = if (s.id == d.supplier) V.OnText else V.Text, height = 52.dp) { vm.supplier(s.id); picking = false }
            }
        }
    }
    if (confirming) Sheet(onDismiss = { vm.back() }, width = 560.dp) {
        val of = DocLines.merged(d.lines)
        SheetHead("Receive this delivery?", "${of.size} ${if (of.size == 1) "product" else "products"} · ${Money.format(DocLines.value(of))}") { vm.back() }
        T("The stock of each goes up by what arrived, and each costs what was paid. A delivery cannot be changed once it is received.", 15.sp, 500, V.Text2, lines = 4)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Not yet", Modifier.weight(1f), enabled = !busy) { vm.back() }
            VBtn(if (busy) "Receiving…" else "Receive", Modifier.weight(1f), V.Green, V.GreenInk, weight = 800, enabled = !busy) { vm.receive(approver) }
        }
    }
}

// A delivery that was received, to look at: what arrived and who received it.
@Composable
private fun DeliveryRecord(vm: ReceiveViewModel, id: String, costs: Boolean) {
    val deliveries by vm.deliveries.collectAsState()
    val lines by vm.lines.collectAsState()
    val staff by vm.staffNames.collectAsState()
    val items by vm.items.collectAsState()
    val d = deliveries.firstOrNull { it.id == id } ?: return
    val of = lines[id].orEmpty()

    Sheet(onDismiss = { vm.shut() }, width = 620.dp, gap = 12.dp) {
        SheetHead(
            "${d.number} · ${vm.supplierName(d.supplier_id)}",
            listOfNotNull("arrived ${d.arrived_on}", vm.orderNumber(d.order_id)?.let { "for $it" }, d.invoice_no?.let { "invoice $it" }, d.received_by?.let { staff[it] }?.let { "received by $it" }).joinToString(" · "),
        ) { vm.shut() }
        d.note?.let { T(it, 14.sp, 500, V.Text2, lines = 3) }
        LazyColumn(Modifier.heightIn(max = 320.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(of, key = { it.item_id + "/" + it.variant_id }) { l ->
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(V.Well).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    T(if (items.isEmpty()) "" else vm.name(l.item_id, l.variant_id), 15.sp, 700, modifier = Modifier.weight(1f), lines = 2)
                    T(DocLines.shown(l.qty, vm.weighed(l.item_id)), 15.sp, 700, modifier = Modifier.width(90.dp))
                    if (costs) T(Money.format(l.unit_cost), 14.sp, 600, V.Text2, Modifier.width(110.dp))
                }
            }
        }
        if (costs) Row { T("The delivery", 14.sp, 600, V.Text2); Gap(); T(Money.format(DocLines.value(of.map { DocLines.Line(it.item_id, it.variant_id, it.qty, it.unit_cost) })), 16.sp, 800) }
        VBtn("Done", Modifier.fillMaxWidth()) { vm.shut() }
    }
}

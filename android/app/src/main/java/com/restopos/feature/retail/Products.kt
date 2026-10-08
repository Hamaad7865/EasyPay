package com.restopos.feature.retail

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.data.Approvals
import com.restopos.core.data.Found
import com.restopos.core.data.LinePrice
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.RetailSales
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StockForm
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemLeft
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.L
import com.restopos.core.ui.ScanKey
import com.restopos.core.ui.ScanPill
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.Toggle
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.catColor
import com.restopos.core.ui.press
import com.restopos.feature.menu.CategoryEditor
import com.restopos.feature.menu.CategorySheets
import com.restopos.feature.menu.StockEdit
import com.restopos.feature.menu.StockEditor
import com.restopos.feature.menu.StockSheet
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// A product opened on the Products & stock screen: its variants, and what the
// shop holds of each line of it.
class ProductOpen(val item: ItemEntity, val category: String?, val variants: List<ItemVariantEntity>, val levels: Map<String, Int>, val counted: Boolean)

// Behind Products & stock: every product with what is left of it, found by
// name, SKU or barcode (typed or scanned), and what a till may change: a
// product's price, whether it is on sale, the product itself (ItemSheet), its
// stock (StockSheet: added or taken out, with a reason that need not be
// given) and the categories (CategorySheets). A delivery with its costs, a
// count and a transfer are the back office's.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class ProductsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val service: ServiceRepository,
    private val sales: RetailSales,
    private val approvals: Approvals,
) : ViewModel() {
    private val store = flow { emit(session.storeId()) }
    val cats: StateFlow<List<CategoryEntity>> = db.catalog().categories().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val cat = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    val products: StateFlow<List<ItemEntity>> = combine(cat, query) { c, q -> (if (q.isBlank()) c else null) to q.trim() }
        .distinctUntilChanged()
        .flatMapLatest { (c, q) -> db.retail().products(c, q) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val left: StateFlow<Map<String, ItemLeft>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else db.retail().leftByItem(s) }
        .map { rows -> rows.associateBy { it.item_id } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())
    val variantCounts: StateFlow<Map<String, Int>> = db.retail().variantCounts().map { rows -> rows.associate { it.item_id to it.n } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    val open = MutableStateFlow<ProductOpen?>(null)
    val asking = MutableStateFlow<NumAsk?>(null)

    // A product being added, changed or removed from this till.
    val items = com.restopos.feature.menu.ItemEditor(service, approvals, viewModelScope, shop = true)

    // The categories, made, changed and removed from this till; a list that
    // was showing one that is gone shows everything.
    val categories = CategoryEditor(service, approvals, viewModelScope, shop = true) { gone -> if (cat.value == gone) cat.value = null }
    val counts: StateFlow<Map<String, Int>> = db.catalog().itemsPerCategory().map { rows -> rows.associate { it.id to it.n } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    // The stock of one line being added to or taken from. Once it has
    // changed and the sync has brought the new level, the product is shown again.
    val stock = StockEditor(service, approvals, viewModelScope, shop = true) { itemId ->
        viewModelScope.launch { kotlinx.coroutines.delay(1500); if (open.value == null) show(itemId) }
    }

    // From the product's sheet to the stock of one of its lines: the one closes, the other opens.
    fun stockOf(p: ProductOpen, variant: ItemVariantEntity?, way: StockForm.Way) {
        close()
        stock.open(StockEdit(p.item.id, variant?.id, sales.nameOf(p.item, variant), (p.levels[variant?.id ?: ""] ?: 0).toLong(), p.item.sold_by == "weight", way))
    }

    // scan mode: the tablet's switch, the same one as on the sell screen
    val scanMode: StateFlow<Boolean> = session.scanMode.stateIn(viewModelScope, SharingStarted.Eagerly, false)
    fun setScanMode(on: Boolean) = viewModelScope.launch { session.setScanMode(on); if (on) query.value = "" }

    fun pickCat(id: String?) { cat.value = id; query.value = "" }

    fun show(itemId: String) = viewModelScope.launch {
        val item = db.catalog().item(itemId) ?: return@launch
        val storeId = session.storeId()
        val levels: List<StockLevelEntity> = if (storeId == null) emptyList() else db.retail().levelsOf(storeId, itemId)
        val category = db.ops().categoryOfItem(itemId)
        open.value = ProductOpen(item, category?.name, db.retail().variantsOf(itemId), levels.associate { it.variant_id to it.qty }, item.track_stock || category?.is_stock == true)
    }

    fun close() { open.value = null }
    fun closeAsk() { asking.value = null }

    // a scanned code opens its product
    fun scanned(code: String) = viewModelScope.launch {
        query.value = ""
        when (val f = sales.find(code)) {
            is Found.Product -> { show(f.item.id); Scanner.say(true, "Found · ${f.item.name}") }
            is Found.Pick -> { show(f.item.id); Scanner.say(true, "Found · ${f.item.name}") }
            is Found.Several -> { Toaster.say("Two products carry the code ${f.code}."); Scanner.say(false, "Two products carry ${f.code}") }
            is Found.Nothing -> { Toaster.say("No product has the code ${f.code}."); Scanner.say(false, "No match · ${f.code}") }
        }
    }

    fun askPrice(item: ItemEntity, variant: ItemVariantEntity?) {
        val now = variant?.price ?: item.price
        asking.value = NumAsk("New price", "${sales.nameOf(item, variant)} · now ${Money.format(now)}. It changes on every till at its next sync.", "Rs", 2, "") { typed -> setPrice(item, variant, typed) }
    }

    // Someone who may not change prices asks someone who may.
    private fun setPrice(item: ItemEntity, variant: ItemVariantEntity?, typed: String, by: StaffMember? = null) {
        val price = Money.parseRs(typed)
        if (price == null) { Toaster.say("Type the price as a number, for example 120 or 99.50"); return }
        viewModelScope.launch {
            val out = if (variant == null) service.setPrice(item.id, price, by) else service.setVariantPrice(item.id, variant.id, price, by)
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) approvals.ask(need.permission, need.what) { approver -> setPrice(item, variant, typed, approver) }
            else {
                out.fold({ Toaster.say("${sales.nameOf(item, variant)} is now ${Money.format(price)}") }, { Toaster.say(it.message) })
                show(item.id)
            }
        }
    }

    fun setOnSale(item: ItemEntity, on: Boolean, by: StaffMember? = null) {
        viewModelScope.launch {
            val out = service.setAvailable(item.id, on, by)
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) approvals.ask(need.permission, need.what) { approver -> setOnSale(item, on, approver) }
            else {
                out.fold({ Toaster.say(if (on) "${item.name} is on sale again" else "${item.name} is off sale on every till") }, { Toaster.say(it.message) })
                show(item.id)
            }
        }
    }
}

private const val BARS = "M4 6v12M8 6v12M11 6v12M15 6v12M18 6v12M20 6v12"

// Products & stock: look a product up, see what is left of it, change its price.
@Composable
fun ProductsScreen(vm: ProductsViewModel) {
    val cats by vm.cats.collectAsState()
    val cat by vm.cat.collectAsState()
    val q by vm.query.collectAsState()
    val items by vm.products.collectAsState()
    val left by vm.left.collectAsState()
    val variants by vm.variantCounts.collectAsState()
    val open by vm.open.collectAsState()
    val asking by vm.asking.collectAsState()
    val editing by vm.items.editing.collectAsState()
    val counts by vm.counts.collectAsState()
    val stocking by vm.stock.editing.collectAsState()
    val byId = cats.associateBy { it.id }
    val searching = q.isNotBlank()
    val scan by vm.scanMode.collectAsState()
    LaunchedEffect(Unit) { Scanner.codes.collect { vm.scanned(it) } }

    Column(Modifier.fillMaxSize().padding(start = 20.dp, end = 20.dp, top = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            ScreenHead("${items.size} ${if (items.size == 1) "product" else "products"}" + if (searching) " found" else "", L.productsStock, Modifier.weight(1f))
            VBtn("Categories", height = 52.dp, radius = 14.dp) { vm.categories.list() }
            VBtn("New product", bg = V.Blue, fg = androidx.compose.ui.graphics.Color.White, height = 52.dp, radius = 14.dp, weight = 800) { vm.items.new(cat) }
            ScanKey(scan, size = 52.dp) { vm.setScanMode(it) }
            // scan mode: nothing to type into, so nothing brings the keyboard up
            if (scan) ScanPill(Modifier.width(440.dp), height = 52.dp, idle = "Scan a barcode")
            else Box(Modifier.width(440.dp)) {
                Field(q, { vm.query.value = it.take(60) }, "Scan, or search a name, SKU or barcode", Modifier.fillMaxWidth(), height = 52.dp, bg = V.Panel, leading = { VIcon(BARS, 20.dp, V.BlueText) })
                if (searching) Box(Modifier.align(Alignment.CenterEnd).padding(end = 6.dp)) { IconKey(VI.Close, size = 40.dp, onClick = { vm.query.value = "" }) }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Cat("All", !searching && cat == null, null) { vm.pickCat(null) }
            cats.forEachIndexed { n, c -> Cat(c.name, !searching && cat == c.id, catColor(c.color, n)) { vm.pickCat(c.id) } }
        }
        Column(Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp)).background(V.Panel)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                T("PRODUCT", 12.sp, 800, V.Text3, Modifier.weight(1f), spacing = 1.sp)
                T("SKU", 12.sp, 800, V.Text3, Modifier.width(150.dp), spacing = 1.sp)
                T("PRICE", 12.sp, 800, V.Text3, Modifier.width(130.dp), spacing = 1.sp)
                T("LEFT", 12.sp, 800, V.Text3, Modifier.width(170.dp), spacing = 1.sp)
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
            if (items.isEmpty()) T(if (searching) "Nothing matches “${q.trim()}”." else "No products here yet. Tap New product, or add them in the back office, under Products.", 15.sp, 500, V.Text2, Modifier.padding(28.dp), lines = 2)
            LazyColumn(Modifier.fillMaxSize()) {
                items(items, key = { it.id }) { i ->
                    val c = byId[i.category_id]
                    val counted = i.track_stock || c?.is_stock == true
                    val n = variants[i.id] ?: 0
                    val qty = left[i.id]?.qty ?: 0L
                    Row(Modifier.fillMaxWidth().height(60.dp).press(0.99f) { vm.show(i.id) }.padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(i.name, 15.sp, 700, if (i.is_available) V.Text else V.Text3)
                            T(listOfNotNull(c?.name, if (n > 0) "$n variants" else null, if (!i.is_available) "not on sale" else null).joinToString(" · "), 12.sp, 500, V.Text3)
                        }
                        T(i.sku ?: "", 14.sp, 500, V.Text2, Modifier.width(150.dp))
                        T(if (i.open_price) "At the sale" else Money.format(i.price) + if (i.sold_by == "weight") " /kg" else "", 15.sp, 700, modifier = Modifier.width(130.dp))
                        T(
                            if (!counted) "Not stocked" else LinePrice.left(qty, i.sold_by == "weight"), 14.sp, 700,
                            if (!counted) V.Text3 else when (LinePrice.stock(qty)) { LinePrice.Stock.Plenty -> V.Text2; LinePrice.Stock.Few -> V.AmberText; LinePrice.Stock.None -> V.RedText },
                            Modifier.width(150.dp),
                        )
                        VIcon(VI.Chevron, 16.dp, V.Text3, modifier = Modifier.width(20.dp))
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                }
            }
        }
    }

    open?.let { ProductSheet(it, vm) }
    asking?.let { a -> NumSheet(a) { vm.closeAsk() } }
    editing?.let { com.restopos.feature.menu.ItemSheet(vm.items, it, cats, shop = true) }
    CategorySheets(vm.categories, cats, counts, shop = true)
    stocking?.let { StockSheet(vm.stock, it) }
}

// dot: the category's colour, as its button on the sell screen wears it
@Composable
private fun Cat(label: String, on: Boolean, dot: androidx.compose.ui.graphics.Color?, onClick: () -> Unit) {
    Row(
        Modifier.height(44.dp).press(onClick = onClick).clip(RoundedCornerShape(22.dp)).background(if (on) V.On else V.Panel).padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (dot != null) Box(Modifier.size(8.dp).clip(CircleShape).background(dot))
        T(label, 14.sp, 700, if (on) V.OnText else V.Text2)
    }
}

// One product: every line of its stock in this shop, with its code and price.
@Composable
private fun ProductSheet(p: ProductOpen, vm: ProductsViewModel) {
    val i = p.item
    val weighed = i.sold_by == "weight"
    val tone = { n: Long -> when (LinePrice.stock(n)) { LinePrice.Stock.Plenty -> V.Text2; LinePrice.Stock.Few -> V.AmberText; LinePrice.Stock.None -> V.RedText } }
    Sheet(onDismiss = { vm.close() }, width = 640.dp) {
        SheetHead(i.name, listOfNotNull(p.category, i.sku?.let { "SKU $it" }, i.barcode?.let { "barcode $it" }).joinToString(" · ").ifEmpty { null }) { vm.close() }
        if (p.variants.isEmpty()) {
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well).padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(if (i.open_price) "Price typed at the sale" else Money.format(i.price) + if (weighed) " a kilo" else "", 20.sp, 800)
                    val qty = (p.levels[""] ?: 0).toLong()
                    T(if (!p.counted) "Its stock is not counted" else LinePrice.left(qty, weighed) + " in this shop", 14.sp, 600, if (p.counted) tone(qty) else V.Text3)
                }
                if (!i.open_price) VBtn("Change price", height = 48.dp, radius = 14.dp) { vm.askPrice(i, null) }
            }
            if (p.counted) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Add stock", Modifier.weight(1f), height = 52.dp, radius = 14.dp) { vm.stockOf(p, null, StockForm.Way.In) }
                VBtn("Remove stock", Modifier.weight(1f), height = 52.dp, radius = 14.dp) { vm.stockOf(p, null, StockForm.Way.Out) }
            }
        } else {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well)) {
                p.variants.forEachIndexed { n, v ->
                    if (n > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                    val qty = (p.levels[v.id] ?: 0).toLong()
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(v.name, 15.sp, 700)
                            T(listOfNotNull(v.sku, v.barcode).joinToString(" · "), 12.sp, 500, V.Text3)
                        }
                        if (p.counted) T(LinePrice.left(qty, weighed), 14.sp, 700, tone(qty), Modifier.width(96.dp))
                        T(Money.format(v.price), 15.sp, 800, modifier = Modifier.width(110.dp))
                        VBtn("Price", height = 42.dp, radius = 12.dp, size = 14.sp, pad = 14.dp) { vm.askPrice(i, v) }
                        // its sheet adds or takes out
                        if (p.counted) VBtn("Stock", height = 42.dp, radius = 12.dp, size = 14.sp, pad = 14.dp) { vm.stockOf(p, v, StockForm.Way.In) }
                    }
                }
            }
        }
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Key).press { vm.setOnSale(i, !i.is_available) }.padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T("On sale", 15.sp, 700)
                T("Off, it cannot be rung up on any till. Its stock is not touched.", 13.sp, 500, V.Text2, lines = 2)
            }
            Toggle(i.is_available)
        }
        T(
            if (p.counted) "A delivery with its costs, a count and a transfer are done in the back office."
            else "Its stock is not counted. Edit product has the switch for that.",
            13.sp, 500, V.Text3, lines = 2,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            // its name, category, barcode, and removing it: the product's own sheet
            VBtn("Edit product", height = 52.dp, radius = 14.dp) { vm.close(); vm.items.open(i, fixedPrice = p.variants.isNotEmpty() || weighed) }
            Gap()
            VBtn("Close", height = 52.dp, radius = 14.dp) { vm.close() }
        }
    }
}

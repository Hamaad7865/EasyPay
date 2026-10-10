package com.restopos.feature.retail

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.data.Found
import com.restopos.core.data.RetailSales
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemLeft
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Field
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.ScanKey
import com.restopos.core.ui.ScanPill
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.press
import kotlinx.coroutines.CoroutineScope
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

private const val BARS = "M4 6v12M8 6v12M11 6v12M15 6v12M18 6v12M20 6v12"

// The shop's products as a place to pick from: found by tapping a tile, by
// searching a name, a SKU or a barcode, or by scanning. Print labels, an
// order, a delivery and a count each hold one and draw ProductPane from it.
// What was chosen is handed to `onAdd`, which says whether it took it (a run
// of labels is full at some point); a product with variants asks which first.
// said: the scanner's line for what it just read ("Label · Polo shirt M").
@OptIn(ExperimentalCoroutinesApi::class)
class ProductPick(
    private val scope: CoroutineScope,
    private val db: TillDatabase,
    private val session: SessionStore,
    private val sales: RetailSales,
    private val said: (ItemEntity, ItemVariantEntity?) -> String,
    private val onAdd: suspend (ItemEntity, ItemVariantEntity?) -> Boolean,
) {
    class Picked(val item: ItemEntity, val variants: List<ItemVariantEntity>)

    private val store = flow { emit(session.storeId()) }
    // kept while its holder lives: a label's category is read from it when a run is printed, whatever screen is on
    val cats: StateFlow<List<CategoryEntity>> = db.catalog().categories().stateIn(scope, SharingStarted.Eagerly, emptyList())
    val cat = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    val products: StateFlow<List<ItemEntity>> = combine(cat, query) { c, q -> (if (q.isBlank()) c else null) to q.trim() }
        .distinctUntilChanged()
        .flatMapLatest { (c, q) -> db.retail().products(c, q) }
        .stateIn(scope, SharingStarted.WhileSubscribed(5000), emptyList())
    val left: StateFlow<Map<String, ItemLeft>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else db.retail().leftByItem(s) }
        .map { rows -> rows.associateBy { it.item_id } }
        .stateIn(scope, SharingStarted.WhileSubscribed(5000), emptyMap())
    val variantCounts: StateFlow<Map<String, Int>> = db.retail().variantCounts().map { rows -> rows.associate { it.item_id to it.n } }
        .stateIn(scope, SharingStarted.WhileSubscribed(5000), emptyMap())
    val scanMode: StateFlow<Boolean> = session.scanMode.stateIn(scope, SharingStarted.Eagerly, false)
    val picking = MutableStateFlow<Picked?>(null)

    fun setScanMode(on: Boolean) = scope.launch { session.setScanMode(on); if (on) query.value = "" }
    fun pickCat(id: String?) { cat.value = id; query.value = "" }

    // A tile was tapped: one more of it. A product with variants asks which.
    fun tap(item: ItemEntity) = scope.launch {
        val variants = db.retail().variantsOf(item.id)
        if (variants.isNotEmpty()) picking.value = Picked(item, variants) else onAdd(item, null)
    }
    fun closePicker() { picking.value = null }
    fun pick(item: ItemEntity, chosen: List<ItemVariantEntity>) = scope.launch {
        picking.value = null
        for (v in chosen) if (!onAdd(item, v)) break
    }

    // A barcode read by the scanner: one more of what carries it.
    fun scanned(code: String) = scope.launch {
        query.value = ""
        when (val f = sales.find(code)) {
            is Found.Product -> if (onAdd(f.item, f.variant)) Scanner.say(true, said(f.item, f.variant))
            is Found.Pick -> { tap(f.item); Scanner.say(true, "Pick which · ${f.item.name}") }
            is Found.Several -> { Toaster.say("Two products carry the code ${f.code}. Find it by its name."); Scanner.say(false, "Two products carry ${f.code}") }
            is Found.Nothing -> { Toaster.say("No product has the code ${f.code}. Nothing was added."); Scanner.say(false, "No match · ${f.code}") }
        }
    }
    // Enter in the search box: a whole code adds its product; anything else stays a search.
    fun enter() = scope.launch {
        val q = query.value.trim()
        if (q.isEmpty()) return@launch
        when (val f = sales.find(q)) {
            is Found.Product -> { query.value = ""; onAdd(f.item, f.variant) }
            is Found.Pick -> { query.value = ""; tap(f.item) }
            else -> products.value.singleOrNull()?.let { query.value = ""; tap(it) }
        }
    }
}

// The pane: the scan key and the search box, the categories, the tiles.
// empty: what it says when the shop has no product to show.
@Composable
fun ProductPane(p: ProductPick, modifier: Modifier, empty: String = "No products here yet. They are added on Products & stock, or in the back office.") {
    val cats by p.cats.collectAsState()
    val cat by p.cat.collectAsState()
    val q by p.query.collectAsState()
    val items by p.products.collectAsState()
    val left by p.left.collectAsState()
    val variants by p.variantCounts.collectAsState()
    val byId = remember(cats) { cats.associateBy { it.id } }
    val searching = q.isNotBlank()
    val scan by p.scanMode.collectAsState()

    Column(modifier.fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ScanKey(scan) { p.setScanMode(it) }
            // scan mode: nothing to type into, so nothing brings the keyboard up
            if (scan) ScanPill(Modifier.weight(1f))
            else Box(Modifier.weight(1f)) {
                Field(
                    q, { p.query.value = it.take(60) }, "Scan, or search a name, SKU or barcode", Modifier.fillMaxWidth(), height = 56.dp, bg = V.Panel, size = 16.sp,
                    leading = { VIcon(BARS, 22.dp, V.BlueText) }, onDone = { p.enter() },
                )
                if (searching) {
                    Box(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp)) { IconKey(VI.Close, size = 40.dp, onClick = { p.query.value = "" }) }
                }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CatKey("All", !searching && cat == null) { p.pickCat(null) }
            cats.forEach { c -> CatKey(c.name, !searching && cat == c.id) { p.pickCat(c.id) } }
        }
        LazyVerticalGrid(GridCells.Adaptive(176.dp), Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (items.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                T(if (searching) "Nothing matches “${q.trim()}”." else empty, 15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3)
            }
            items(items, key = { it.id }) { i -> Tile(i, byId[i.category_id], left[i.id]?.qty, variants[i.id] ?: 0) { p.tap(i) } }
        }
    }
}

// A product that comes in variants: which of them are meant. Each is a key
// that is in or out; `all` is one tap for every size of it.
// hint: what the sheet says under the product's name. some: the key's words for how many are chosen.
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun WhichSheet(p: ProductPick, picked: ProductPick.Picked, hint: String, all: String = "All of them", none: String = "Tap the ones you mean", some: (Int) -> String) {
    var chosen by remember(picked) { mutableStateOf(emptySet<String>()) }
    Sheet(onDismiss = { p.closePicker() }, width = 600.dp, pad = 24.dp, gap = 18.dp) {
        SheetHead(picked.item.name, hint) { p.closePicker() }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            picked.variants.forEach { v ->
                val on = v.id in chosen
                Column(
                    Modifier.height(64.dp).widthIn(min = 110.dp).press { chosen = if (on) chosen - v.id else chosen + v.id }.clip(RoundedCornerShape(14.dp)).background(if (on) V.On else V.Key).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    T(v.name, 16.sp, 800, if (on) V.OnText else V.Text)
                    T(Money.format(v.price), 12.sp, 700, if (on) V.OnSub else V.Text2)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn(all, Modifier.weight(1f), height = 56.dp, radius = 16.dp, size = 16.sp) { p.pick(picked.item, picked.variants) }
            val n = chosen.size
            VBtn(
                if (n == 0) none else some(n), Modifier.weight(2f),
                if (n > 0) V.Green else V.Key, if (n > 0) V.GreenInk else V.Text3, 56.dp, 16.dp, 16.sp, 800, enabled = n > 0,
            ) { p.pick(picked.item, picked.variants.filter { it.id in chosen }) }
        }
    }
}

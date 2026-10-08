package com.restopos.feature.retail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.data.Found
import com.restopos.core.data.LinePrice
import com.restopos.core.data.RetailSales
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Field
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.ScanKey
import com.restopos.core.ui.ScanPill
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// Behind Stock check: the products that match what was typed, and the one
// that is open with what the shop holds of each line of it. Nothing is
// changed from here: a price is changed under Products & stock, and stock in
// the back office, where each change keeps its reason.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class StockCheckViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val sales: RetailSales,
) : ViewModel() {
    val query = MutableStateFlow("")
    // nothing typed, nothing listed: the list is the answer to a question
    val matches: StateFlow<List<ItemEntity>> = query.map { it.trim() }.distinctUntilChanged()
        .flatMapLatest { q -> if (q.isEmpty()) flowOf(emptyList()) else db.retail().products(null, q) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val variantCounts: StateFlow<Map<String, Int>> = db.retail().variantCounts().map { rows -> rows.associate { it.item_id to it.n } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())
    val open = MutableStateFlow<ProductOpen?>(null)
    // the figures are the till's own, as of when the back office last answered
    val lastPull: StateFlow<Long?> = session.lastPull.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    // scan mode: the tablet's switch, the same one as on the sell screen
    val scanMode: StateFlow<Boolean> = session.scanMode.stateIn(viewModelScope, SharingStarted.Eagerly, false)
    fun setScanMode(on: Boolean) = viewModelScope.launch { session.setScanMode(on) }

    fun show(itemId: String) = viewModelScope.launch {
        val item = db.catalog().item(itemId) ?: return@launch
        val storeId = session.storeId()
        val levels = if (storeId == null) emptyList() else db.retail().levelsOf(storeId, itemId)
        val category = db.ops().categoryOfItem(itemId)
        open.value = ProductOpen(item, category?.name, db.retail().variantsOf(itemId), levels.associate { it.variant_id to it.qty }, item.track_stock || category?.is_stock == true)
    }

    // Done on the keyboard: a whole code opens its product, and so does a
    // search with one answer; with several, the list waits for a tap.
    fun enter() = viewModelScope.launch {
        val q = query.value.trim()
        if (q.isEmpty()) return@launch
        when (val f = sales.find(q)) {
            is Found.Product -> show(f.item.id)
            is Found.Pick -> show(f.item.id)
            else -> matches.value.singleOrNull()?.let { show(it.id) }
        }
    }

    // A scanned barcode opens its product, and the list shows where it was found.
    fun scanned(code: String) = viewModelScope.launch {
        when (val f = sales.find(code)) {
            is Found.Product -> found(f.item)
            is Found.Pick -> found(f.item)
            is Found.Several -> { Toaster.say("Two products carry the code ${f.code}. Find it by its name."); Scanner.say(false, "Two products carry ${f.code}") }
            is Found.Nothing -> { Toaster.say("No product has the code ${f.code}."); Scanner.say(false, "No match · ${f.code}") }
        }
    }

    private fun found(item: ItemEntity) {
        query.value = item.name
        show(item.id)
        Scanner.say(true, "Found · ${item.name}")
    }
}

private val HM = SimpleDateFormat("HH:mm", Locale.US)

// Stock check, after the Kids Corner till's: scan a product or type its name,
// and see what the shop holds of every size and colour of it. The products
// that match are down the left; the one that is open fills the right, a row
// for each of its variants. The figures are the till's own: what the back
// office sent at the last sync, less what this till has sold since.
@Composable
fun StockCheckScreen(vm: StockCheckViewModel, onBack: () -> Unit) {
    val q by vm.query.collectAsState()
    val matches by vm.matches.collectAsState()
    val counts by vm.variantCounts.collectAsState()
    val open by vm.open.collectAsState()
    val scan by vm.scanMode.collectAsState()
    val lastPull by vm.lastPull.collectAsState()
    // while this screen is open, a scanned barcode opens its product
    LaunchedEffect(Unit) { Scanner.codes.collect { vm.scanned(it) } }

    Column(Modifier.fillMaxSize().padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IconKey(VI.Back, tint = V.Text, width = 2.2f, onClick = onBack)
            ScreenHead("What this shop holds of a product", "Stock check", Modifier.weight(1f))
            Box(Modifier.clip(RoundedCornerShape(999.dp)).background(V.BlueWash).padding(horizontal = 12.dp, vertical = 7.dp)) {
                T(lastPull?.let { "AS OF THE SYNC AT " + HM.format(Date(it)) } ?: "NOT SYNCED YET", 11.sp, 800, V.BlueText, spacing = 0.7.sp)
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ScanKey(scan) { vm.setScanMode(it) }
            // scan mode: nothing to type into, so nothing brings the keyboard up
            if (scan) ScanPill(Modifier.weight(1f), idle = "Scan a barcode")
            else Box(Modifier.weight(1f)) {
                Field(
                    q, { vm.query.value = it.take(60) }, "Product name, SKU or barcode", Modifier.fillMaxWidth(), height = 56.dp, bg = V.Panel, size = 16.sp,
                    leading = { VIcon(VI.Search, 20.dp, V.Text3) }, onDone = { vm.enter() },
                )
                if (q.isNotBlank()) Box(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp)) { IconKey(VI.Close, size = 40.dp, onClick = { vm.query.value = "" }) }
            }
        }
        Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Matches(q, matches, counts, open?.item?.id, Modifier.width(330.dp).fillMaxHeight()) { vm.show(it) }
            Details(open, Modifier.weight(1f).fillMaxHeight())
        }
    }
}

// The products that match, to pick from.
@Composable
private fun Matches(q: String, rows: List<ItemEntity>, counts: Map<String, Int>, on: String?, modifier: Modifier, onPick: (String) -> Unit) {
    Column(modifier.clip(RoundedCornerShape(18.dp)).background(V.Panel)) {
        when {
            q.isBlank() -> Hint(VI.Search, "Find a product", "Type a name, SKU or barcode, or scan it.")
            rows.isEmpty() -> Hint(VI.Search, "No matching product", "Try another name, SKU or barcode.")
            else -> {
                T("${rows.size} ${if (rows.size == 1) "PRODUCT" else "PRODUCTS"}", 12.sp, 800, V.Text3, Modifier.padding(start = 16.dp, top = 14.dp, bottom = 8.dp), spacing = 1.sp)
                LazyColumn(Modifier.fillMaxSize()) {
                    items(rows, key = { it.id }) { i ->
                        val n = counts[i.id] ?: 0
                        Column(
                            Modifier.fillMaxWidth().background(if (i.id == on) V.RowOn else Color.Transparent).clickable { onPick(i.id) }.padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(2.dp),
                        ) {
                            T(i.name, 15.sp, 700, if (i.is_available) V.Text else V.Text3)
                            T(listOfNotNull(i.sku, if (n > 0) "$n variants" else null, if (!i.is_available) "not on sale" else null).joinToString(" · ").ifEmpty { "No SKU" }, 12.sp, 500, V.Text3)
                        }
                        Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                    }
                }
            }
        }
    }
}

// The product that is open: what it is, what the shop holds of it in all,
// and a row for each of its variants with its code, its price and its stock.
@Composable
private fun Details(p: ProductOpen?, modifier: Modifier) {
    Column(modifier.clip(RoundedCornerShape(18.dp)).background(V.Panel)) {
        if (p == null) {
            Hint(VI.List, "Stock will appear here", "Choose a product to see every size and colour.")
            return@Column
        }
        val i = p.item
        val weighed = i.sold_by == "weight"
        val qtyOf = { variant: String -> (p.levels[variant] ?: 0).toLong() }
        val total = if (p.variants.isEmpty()) qtyOf("") else p.variants.sumOf { qtyOf(it.id) }
        val tone = { n: Long -> when (LinePrice.stock(n)) { LinePrice.Stock.Plenty -> V.Text; LinePrice.Stock.Few -> V.AmberText; LinePrice.Stock.None -> V.RedText } }
        val figure = { n: Long -> if (n <= 0) "Out" else LinePrice.qty(n.toInt(), weighed) }

        Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 18.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                T(i.name, 21.sp, 800, lines = 2, height = 26.sp)
                T(listOfNotNull(p.category, "SKU: ${i.sku ?: "not set"}", if (p.variants.isEmpty()) "Barcode: ${i.barcode ?: "not set"}" else null).joinToString(" · "), 14.sp, 500, V.Text2, lines = 2, height = 18.sp)
                if (!i.is_available) T("Not on sale: it cannot be rung up on any till.", 13.sp, 600, V.AmberText)
            }
            if (p.counted) Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
                T(figure(total), 24.sp, 800, if (total <= 0) V.RedText else V.BlueText)
                T("in all, in this shop", 12.sp, 600, V.Text3)
            }
        }
        Row(Modifier.fillMaxWidth().background(V.Well).padding(horizontal = 18.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
            T(if (p.variants.isEmpty()) "PRODUCT" else "VARIANT", 11.sp, 800, V.Text3, Modifier.weight(1f), spacing = 1.sp)
            T("PRICE", 11.sp, 800, V.Text3, Modifier.width(130.dp), align = TextAlign.End, spacing = 1.sp)
            T("IN THIS SHOP", 11.sp, 800, V.Text3, Modifier.width(140.dp), align = TextAlign.End, spacing = 1.sp)
        }
        // one row for a product with no variants; else one for each of them
        val rows = remember(p) {
            if (p.variants.isEmpty()) listOf(StockRow("", i.name, listOfNotNull(i.sku, i.barcode).joinToString(" · "), i.price))
            else p.variants.map { v -> StockRow(v.id, v.name, listOfNotNull(v.sku, v.barcode).joinToString(" · "), v.price) }
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(rows, key = { it.id }) { r ->
                val n = qtyOf(r.id)
                Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        T(r.name, 15.sp, 700)
                        if (r.codes.isNotEmpty()) T(r.codes, 12.sp, 500, V.Text3)
                    }
                    T(Money.format(r.price) + if (weighed) " /kg" else "", 15.sp, 600, V.Text2, Modifier.width(130.dp), align = TextAlign.End)
                    T(if (p.counted) figure(n) else "Not counted", 16.sp, 800, if (p.counted) tone(n) else V.Text3, Modifier.width(140.dp), align = TextAlign.End)
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
            }
        }
    }
}

private class StockRow(val id: String, val name: String, val codes: String, val price: Long)

// What a panel says while it has nothing to show.
@Composable
private fun Hint(icon: String, title: String, detail: String) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        VIcon(icon, 30.dp, V.Text3)
        T(title, 16.sp, 700)
        T(detail, 13.sp, 500, V.Text2, lines = 2, align = TextAlign.Center)
    }
}

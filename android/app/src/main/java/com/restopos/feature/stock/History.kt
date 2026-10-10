package com.restopos.feature.stock

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Scanner
import com.restopos.core.data.Found
import com.restopos.core.data.RetailSales
import com.restopos.core.data.StockHistory
import com.restopos.core.database.StockMovementEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Field
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.ScanKey
import com.restopos.core.ui.ScanPill
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.panel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import javax.inject.Inject

// One movement as the list shows it.
class MoveRow(
    val id: String, val item: String, val variant: String, val at: Long, val product: String, val qty: Int, val weighed: Boolean,
    val reason: String, val paper: String?, val who: String?, val note: String?,
)

// What the names in a movement are read from: products, variants, staff, and
// the numbers of the papers a movement belongs to.
private class Names(
    val items: Map<String, Pair<String, Boolean>>, // name, sold by weight
    val variants: Map<String, String>,
    val staff: Map<String, String>,
    val papers: Map<String, String>, // a delivery's, a count's or a receipt's id to its number
)

// Behind the History tab: every movement of this shop's stock the tablet
// holds, newest first, a page at a time. On a linked till a sale shows once
// it has been to the server and back.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class HistoryViewModel @Inject constructor(
    db: TillDatabase,
    private val session: SessionStore,
    private val sales: RetailSales,
) : ViewModel() {
    private val store = flow { emit(session.storeId()) }
    private val stock = db.stock()
    val limit = MutableStateFlow(PAGE)
    val kind = MutableStateFlow<StockHistory.Kind?>(null)
    val query = MutableStateFlow("")
    // one product only, picked by a scan: its id and variant ("" for none, null for any), and its name for the screen
    val only = MutableStateFlow<Triple<String, String?, String>?>(null)
    val scanMode: StateFlow<Boolean> = session.scanMode.stateIn(viewModelScope, SharingStarted.Eagerly, false)
    fun setScanMode(on: Boolean) = viewModelScope.launch { session.setScanMode(on); if (on) query.value = "" }

    private val names = combine(
        stock.everyItem(), stock.everyVariant(), stock.staffNames(),
        combine(store.flatMapLatest { s -> if (s == null) emptyFlow() else stock.deliveries(s) }, store.flatMapLatest { s -> if (s == null) emptyFlow() else stock.counts(s) }, stock.receiptNumbers()) { d, c, r ->
            d.associate { it.id to it.number } + c.mapNotNull { k -> k.number?.let { k.id to it } } + r.associate { it.id to it.name }
        },
    ) { items, variants, staff, papers ->
        Names(items.associate { it.id to (it.name to (it.sold_by == "weight")) }, variants.associate { it.id to it.name }, staff.associate { it.id to it.name }, papers)
    }

    private val all: StateFlow<List<MoveRow>> = combine(
        combine(store, limit) { s, n -> s to n }.flatMapLatest { (s, n) -> if (s == null) emptyFlow() else stock.movements(s, n + 1) },
        names,
    ) { moves, n -> moves.map { row(it, n) } }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    // more than a page is held: there is more to show
    val more: StateFlow<Boolean> = combine(all, limit) { rows, n -> rows.size > n }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    val rows: StateFlow<List<MoveRow>> = combine(all, limit, kind, query, only) { rows, n, k, q, o ->
        val words = q.trim().lowercase(Locale.ROOT)
        rows.take(n).filter { r ->
            (k == null || StockHistory.kind(r.reason) == k) &&
                (o == null || (r.item == o.first && (o.second == null || r.variant == o.second))) &&
                (words.isEmpty() || r.product.lowercase(Locale.ROOT).contains(words))
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private fun row(m: StockMovementEntity, n: Names): MoveRow {
        val item = n.items[m.item_id]
        val variant = m.variant_id.takeIf { it.isNotEmpty() }?.let { n.variants[it] }
        val name = (item?.first ?: "A product that is gone") + if (variant != null) ", $variant" else ""
        val paper = m.receipt_id?.let { n.papers[it] } ?: m.ref_id?.let { n.papers[it] }
        return MoveRow(m.id, m.item_id, m.variant_id, m.created_at, name, m.qty, item?.second == true, m.reason, paper, m.employee_id?.let { n.staff[it] }, m.note)
    }

    fun showMore() { limit.value += PAGE }
    fun pick(k: StockHistory.Kind?) { kind.value = k }
    fun clearOnly() { only.value = null }

    // A barcode read by the scanner: the history of what carries it.
    fun scanned(code: String) = viewModelScope.launch {
        query.value = ""
        when (val f = sales.find(code)) {
            is Found.Product -> { only.value = Triple(f.item.id, f.variant?.id ?: "", sales.nameOf(f.item, f.variant)); Scanner.say(true, "History · ${sales.nameOf(f.item, f.variant)}") }
            is Found.Pick -> { only.value = Triple(f.item.id, null, f.item.name); Scanner.say(true, "History · ${f.item.name}") }
            is Found.Several -> { Toaster.say("Two products carry the code ${f.code}. Find it by its name."); Scanner.say(false, "Two products carry ${f.code}") }
            is Found.Nothing -> { Toaster.say("No product has the code ${f.code}."); Scanner.say(false, "No match · ${f.code}") }
        }
    }
    // Enter in the search box: a whole code is a scan; anything else stays a search by name.
    fun enter() = viewModelScope.launch {
        val q = query.value.trim()
        if (q.isEmpty()) return@launch
        when (val f = sales.find(q)) {
            is Found.Product -> { query.value = ""; only.value = Triple(f.item.id, f.variant?.id ?: "", sales.nameOf(f.item, f.variant)) }
            is Found.Pick -> { query.value = ""; only.value = Triple(f.item.id, null, f.item.name) }
            else -> Unit
        }
    }

    private companion object { const val PAGE = 200 }
}

private val CLOCK = DateTimeFormatter.ofPattern("HH:mm", Locale.US)
private val DAY = DateTimeFormatter.ofPattern("d MMM", Locale.US)

// "Today 14:05", "Yesterday 09:12", "8 Oct 09:12", by the tablet's own clock and place.
internal fun whenSaid(at: Long, today: LocalDate = LocalDate.now(), zone: ZoneId = ZoneId.systemDefault()): String {
    val t = Instant.ofEpochMilli(at).atZone(zone)
    val day = t.toLocalDate()
    val said = when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> DAY.format(t)
    }
    return "$said ${CLOCK.format(t)}"
}

private const val BARS = "M4 6v12M8 6v12M11 6v12M15 6v12M18 6v12M20 6v12"

@Composable
fun HistoryTab(vm: HistoryViewModel) {
    val rows by vm.rows.collectAsState()
    val more by vm.more.collectAsState()
    val kind by vm.kind.collectAsState()
    val q by vm.query.collectAsState()
    val only by vm.only.collectAsState()
    val scan by vm.scanMode.collectAsState()
    // while this tab is open, a scanned barcode shows that product's history
    LaunchedEffect(Unit) { Scanner.codes.collect { vm.scanned(it) } }

    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ScanKey(scan, size = 48.dp) { vm.setScanMode(it) }
            if (scan) ScanPill(Modifier.weight(1f), height = 48.dp)
            else Box(Modifier.weight(1f)) {
                Field(
                    q, { vm.query.value = it.take(60) }, "Scan a product, or search its name", Modifier.fillMaxWidth(), height = 48.dp, bg = V.Panel,
                    leading = { VIcon(BARS, 20.dp, V.BlueText) }, onDone = { vm.enter() },
                )
                if (q.isNotBlank()) Box(Modifier.align(Alignment.CenterEnd).padding(end = 6.dp)) { IconKey(VI.Close, size = 36.dp, onClick = { vm.query.value = "" }) }
            }
            Seg(
                listOf(SegOption("All", kind == null) { vm.pick(null) }) + StockHistory.Kind.entries.map { k -> SegOption(k.label, kind == k) { vm.pick(k) } },
                well = V.Panel, height = 40.dp, size = 14.sp, pad = 12.dp,
            )
        }
        only?.let { o ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                T("Only ${o.third}", 14.sp, 700, V.Text)
                VBtn("Show every product", height = 36.dp, size = 13.sp, pad = 12.dp) { vm.clearOnly() }
            }
        }
        if (rows.isEmpty()) {
            T(
                if (only != null || q.isNotBlank() || kind != null) "Nothing here matches. A movement shows once the till has synced."
                else "Nothing has moved yet. A sale, a delivery, a count and a correction each show here once the till has synced.",
                15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3,
            )
        } else LazyColumn(Modifier.fillMaxWidth().weight(1f).panel(), contentPadding = PaddingValues(vertical = 6.dp)) {
            items(rows, key = { it.id }) { r -> MoveLine(r) }
            if (more) item {
                Box(Modifier.fillMaxWidth().padding(14.dp), contentAlignment = Alignment.Center) { VBtn("Show more", height = 44.dp, pad = 20.dp) { vm.showMore() } }
            }
        }
    }
}

@Composable
private fun MoveLine(r: MoveRow) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        T(whenSaid(r.at), 13.sp, 600, V.Text2, Modifier.width(132.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(r.product, 15.sp, 700)
            val under = listOfNotNull(StockHistory.says(r.reason), r.paper, r.who, r.note?.takeIf { it.isNotBlank() }).joinToString(" · ")
            T(under, 13.sp, 500, V.Text2)
        }
        T(StockHistory.shown(r.qty, r.weighed), 17.sp, 800, if (r.qty >= 0) V.GreenText else V.RedText, Modifier.width(120.dp), align = TextAlign.End)
    }
}

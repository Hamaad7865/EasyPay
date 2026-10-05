package com.restopos.feature.kds

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridItemSpan
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.Kitchen
import com.restopos.core.data.LineInfo
import com.restopos.core.data.ServiceRepository
import com.restopos.core.database.KdsTicketEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Gap
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import javax.inject.Inject

// A ticket on the kitchen display with its lines, and where each line is cooked.
data class KdsLine(val info: LineInfo, val stations: Set<String>)
data class KdsCard(val ticket: KdsTicketEntity, val lines: List<KdsLine>)
data class Station(val id: String, val name: String)
data class KdsUi(val cards: List<KdsCard> = emptyList(), val stations: List<Station> = emptyList(), val canRecall: Boolean = false, val loaded: Boolean = false)

// The kitchen display. A station is one of the back office's kitchen printers
// ("Grill", "Bar"): a line belongs to the stations its category prints at, so
// the screen and the paper always agree on who cooks what.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class KdsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val kitchen: Kitchen,
    private val service: ServiceRepository,
) : ViewModel() {
    val station = MutableStateFlow<String?>(null)
    private val since = System.currentTimeMillis() - 12 * 3_600_000L

    val ui: StateFlow<KdsUi> = combine(db.service().kdsOpen(), db.service().kdsLines(), db.service().bumpedCount(since), db.catalog().categories()) { tickets, lines, bumped, cats ->
        Quad(tickets, lines, bumped, cats)
    }.mapLatest { (tickets, lines, bumped, cats) ->
        val store = session.storeId()
        val printers = (store?.let { db.ops().printers(it) } ?: emptyList()).filter { !it.is_receipt }
        val known = printers.map { it.id }.toSet()
        val where = cats.associate { c ->
            c.id to runCatching { Json.parseToJsonElement(c.printer_ids).jsonArray.map { it.jsonPrimitive.content } }.getOrDefault(emptyList()).filter { known.contains(it) }.toSet()
        }
        val catOf = HashMap<String, String?>()
        val info = service.describe(lines)
        val rows = info.map { l ->
            val cat = l.line.item_id?.let { id -> catOf.getOrPut(id) { db.catalog().item(id)?.category_id } }
            KdsLine(l, where[cat].orEmpty())
        }.groupBy { it.info.line.kds_id }
        val used = where.values.flatten().toSet()
        KdsUi(
            tickets.mapNotNull { t -> rows[t.id]?.takeIf { it.isNotEmpty() }?.let { KdsCard(t, it) } },
            printers.filter { used.contains(it.id) }.map { Station(it.id, it.name) },
            bumped > 0,
            loaded = true,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), KdsUi())

    private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)

    // POS settings: a short sound when an order arrives
    val sound: StateFlow<Boolean> = db.ops().settingsFlow().map { com.restopos.core.data.PosSettings.parse(it).kitchenSound }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), true)

    init { viewModelScope.launch { kitchen.prune() } }

    fun toggle(lineId: String) = viewModelScope.launch { kitchen.toggle(lineId) }
    fun bump(card: KdsCard) = viewModelScope.launch { kitchen.bump(card.ticket.id)?.let { Toaster.say("$it bumped · ready at the pass") } }
    fun recall() = viewModelScope.launch { kitchen.recall()?.let { Toaster.say("$it is back on the screen") } }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KdsScreen(vm: KdsViewModel) {
    val ui by vm.ui.collectAsState()
    val picked by vm.station.collectAsState()
    // A ticket that was not on the screen a moment ago makes a sound. The ones
    // already there when the screen opens do not.
    val sound by vm.sound.collectAsState()
    val ids = ui.cards.map { it.ticket.id }
    var seen by remember { mutableStateOf<Set<String>?>(null) }
    LaunchedEffect(ui.loaded, ids) {
        if (!ui.loaded) return@LaunchedEffect
        val before = seen
        seen = ids.toSet()
        if (sound && before != null && ids.any { it !in before }) {
            runCatching {
                val tone = android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION, 90)
                tone.startTone(android.media.ToneGenerator.TONE_PROP_ACK, 300)
                delay(600)
                tone.release()
            }
        }
    }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(1000) } }
    val station = picked?.takeIf { id -> ui.stations.any { it.id == id } }
    val cards = ui.cards.mapNotNull { c -> c.lines.filter { station == null || it.stations.contains(station) }.takeIf { it.isNotEmpty() }?.let { c.copy(lines = it) } }
    val late = cards.count { now - it.ticket.created_at >= 15 * 60_000 }

    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxHeight().padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T("${cards.size} open · $late late", 13.sp, 500, V.Text2)
                    T("Kitchen display", 26.sp, 700, spacing = (-0.6).sp)
                }
                FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    (listOf(Station("", "All stations")) + ui.stations).forEach { st ->
                        val on = (st.id.isEmpty() && station == null) || st.id == station
                        val n = ui.cards.count { c -> st.id.isEmpty() || c.lines.any { it.stations.contains(st.id) } }
                        Row(
                            Modifier.height(48.dp).clip(RoundedCornerShape(12.dp)).background(if (on) V.On else V.Key2).clickable { vm.station.value = st.id.ifEmpty { null } }.padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            T(st.name, 15.sp, 600, if (on) V.OnText else V.Dim)
                            T(n.toString(), 12.sp, 600, if (on) V.OnText else V.Dim)
                        }
                    }
                }
                if (ui.canRecall) {
                    Box(
                        Modifier.height(48.dp).clip(RoundedCornerShape(12.dp)).border(1.dp, V.Stroke2, RoundedCornerShape(12.dp)).clickable { vm.recall() }.padding(horizontal = 18.dp),
                        contentAlignment = Alignment.Center,
                    ) { T("Recall last", 15.sp, 600) }
                }
            }
            LazyVerticalStaggeredGrid(
                StaggeredGridCells.Adaptive(272.dp), Modifier.weight(1f).fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(14.dp), verticalItemSpacing = 14.dp,
            ) {
                if (cards.isEmpty()) item(span = StaggeredGridItemSpan.FullLine) {
                    T("All caught up. New tickets appear here when orders are sent.", 17.sp, 500, V.Text2, Modifier.padding(horizontal = 20.dp, vertical = 80.dp), lines = 2, align = androidx.compose.ui.text.style.TextAlign.Center)
                }
                items(cards, key = { it.ticket.id }) { c ->
                    val age = (now - c.ticket.created_at).coerceAtLeast(0)
                    val m = age / 60_000
                    val head = when { m >= 15 -> V.Red to Color.White; m >= 8 -> V.Amber to V.AmberInk; else -> Color(0xFF2A2F38) to Color.White }
                    Column(Modifier.clip(RoundedCornerShape(18.dp)).background(V.Panel).border(1.dp, V.Stroke, RoundedCornerShape(18.dp))) {
                        Column(Modifier.fillMaxWidth().background(head.first).padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                T(c.ticket.label, 24.sp, 700, head.second, Modifier.weight(1f), spacing = (-0.5).sp)
                                T("$m:${((age / 1000) % 60).toString().padStart(2, '0')}", 20.sp, 600, head.second)
                            }
                            Row {
                                T(listOfNotNull(c.ticket.kind, c.ticket.covers?.let { "$it covers" }).joinToString(" · "), 13.sp, 500, head.second, Modifier.weight(1f))
                                T("#${c.ticket.no}", 13.sp, 500, head.second)
                            }
                        }
                        Column(Modifier.padding(vertical = 4.dp)) {
                            c.lines.forEach { l ->
                                val done = l.info.line.kitchen_done
                                Row(
                                    Modifier.fillMaxWidth().clickable { vm.toggle(l.info.line.id) }
                                        .drawBehind { drawRect(V.Stroke, androidx.compose.ui.geometry.Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
                                        .padding(horizontal = 16.dp, vertical = 12.dp),
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    T(l.info.units.toString(), 18.sp, 600, if (done) V.Off else V.Text, Modifier.width(30.dp), strike = done)
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                        T(l.info.line.name_snapshot, 17.sp, 600, if (done) V.Off else V.Text, lines = 3, height = 21.sp, strike = done)
                                        if (l.info.detail.isNotEmpty()) T(l.info.detail, 14.sp, 500, if (done) V.Off else V.AmberText, lines = 3)
                                    }
                                }
                            }
                        }
                        VBtn("Bump", Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 12.dp), V.Green, V.GreenInk, 58.dp, 14.dp, 17.sp) { vm.bump(c) }
                    }
                }
            }
        }
        Column(
            Modifier.width(280.dp).fillMaxHeight().background(V.Side).drawBehind { drawRect(V.Stroke, size = Size(1.dp.toPx(), size.height)) }
                .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 22.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Caps("All day", V.Text2)
                T("Items still to cook, all tickets", 13.sp, 500, V.Text2)
            }
            val left = cards.flatMap { it.lines }.filter { !it.info.line.kitchen_done }.groupBy { it.info.line.name_snapshot }
                .mapValues { e -> e.value.sumOf { it.info.units } }.entries.sortedByDescending { it.value }
            if (left.isEmpty()) T("Nothing waiting.", 14.sp, 500, V.Text3)
            left.forEach { (name, qty) ->
                Row(
                    Modifier.fillMaxWidth().drawBehind { drawRect(V.Stroke, androidx.compose.ui.geometry.Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }.padding(vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    T(qty.toString(), 20.sp, 600, V.BlueText, Modifier.width(34.dp))
                    T(name, 15.sp, 500, lines = 2)
                }
            }
        }
    }
}

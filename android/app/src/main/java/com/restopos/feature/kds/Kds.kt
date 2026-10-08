package com.restopos.feature.kds

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
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
import com.restopos.core.data.PosSettings
import com.restopos.core.data.Routing
import com.restopos.core.data.ServiceRepository
import com.restopos.core.database.TillDatabase
import com.restopos.core.kitchen.KitchenPrefs
import com.restopos.core.kitchen.KitchenPrefsStore
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Chip
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.Stepper
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.Toggle
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
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
import javax.inject.Inject

// What the kitchen board shows, whoever it is shown by: this till's own
// Kitchen screen (its rows are the till's orders) or a kitchen tablet (its
// rows are what the tills sent it, core/kitchen). One board, so the two can
// never look or behave differently.
//
// A line as the cooks read it, and where it is cooked. A voided line stays,
// struck through, on a screen that was sent it.
data class KdsLine(
    val id: String, val units: Int, val name: String, val detail: String,
    val done: Boolean, val voided: Boolean = false, val stations: Set<String> = emptySet(),
)

// A ticket: one send of an order, or one screen's part of it. `no` is as it
// is shown ("#12", or "T2 #12" where two tills share a screen); `since` is
// what its age is counted from, on this tablet's clock.
data class KdsCard(
    val id: String, val no: String, val label: String, val kind: String, val covers: Int?,
    val waiter: String?, val remark: String?, val since: Long, val lines: List<KdsLine>,
)

data class Station(val id: String, val name: String)

// `heard`: on a kitchen tablet, which till it last heard from and when.
data class KdsUi(
    val cards: List<KdsCard> = emptyList(), val stations: List<Station> = emptyList(), val canRecall: Boolean = false,
    val loaded: Boolean = false, val title: String = "Kitchen display", val heard: String? = null,
)

// The kitchen display on this till. A station is one of the back office's
// kitchen printers ("Grill", "Bar") or kitchen screens: a line belongs to the
// stations its category is ticked for, so the screen and the paper always
// agree on who cooks what.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class KdsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val kitchen: Kitchen,
    private val service: ServiceRepository,
    private val prefsStore: KitchenPrefsStore,
) : ViewModel() {
    private val since = System.currentTimeMillis() - 12 * 3_600_000L

    val ui: StateFlow<KdsUi> = combine(
        db.service().kdsOpen(), db.service().kdsLines(), db.service().bumpedCount(since), db.catalog().categories(), db.ops().settingsFlow(),
    ) { tickets, lines, bumped, cats, settings ->
        Quad(tickets, lines, bumped, cats) to settings
    }.mapLatest { (shown, settings) ->
        val (tickets, lines, bumped, cats) = shown
        val store = session.storeId()
        // the same rule the tickets are printed by (Routing)
        val printers = store?.let { db.ops().printers(it) } ?: emptyList()
        val ticked = cats.associate { c -> c.id to Routing.ids(c.printer_ids) }
        val stations = Routing.stations(ticked.values, printers, PosSettings.parse(settings).onePrinter)
        val catOf = HashMap<String, String?>()
        val rows = service.describe(lines).groupBy({ it.line.kds_id }) { l ->
            val cat = l.line.item_id?.let { id -> catOf.getOrPut(id) { db.catalog().item(id)?.category_id } }
            KdsLine(l.line.id, l.units, l.line.name_snapshot, l.detail, l.line.kitchen_done, stations = Routing.stationsFor(ticked[cat], stations))
        }
        KdsUi(
            tickets.mapNotNull { t ->
                rows[t.id]?.takeIf { it.isNotEmpty() }?.let { KdsCard(t.id, "#${t.no}", t.label, t.kind, t.covers, t.waiter, t.remark, t.created_at, it) }
            },
            stations.map { Station(it.id, it.name) },
            bumped > 0,
            loaded = true,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), KdsUi())

    private data class Quad<A, B, C, D>(val a: A, val b: B, val c: C, val d: D)

    // What this screen is set to: the minutes and what a ticket shows are
    // this tablet's own; its sound is the back office's POS setting.
    val prefs: StateFlow<KitchenPrefs> = combine(prefsStore.prefs, db.ops().settingsFlow().map { PosSettings.parse(it).kitchenSound }) { p, sound -> p.copy(sound = sound) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), KitchenPrefs())

    init { viewModelScope.launch { kitchen.prune() } }

    fun save(p: KitchenPrefs) = viewModelScope.launch { prefsStore.save(p.copy(sound = true)) }
    fun toggle(lineId: String) = viewModelScope.launch { kitchen.toggle(lineId) }
    fun bump(cardId: String) = viewModelScope.launch { kitchen.bump(cardId)?.let { Toaster.say("$it bumped · ready at the pass") } }
    fun recall() = viewModelScope.launch { kitchen.recall()?.let { Toaster.say("$it is back on the screen") } }
}

@Composable
fun KdsScreen(vm: KdsViewModel) {
    val ui by vm.ui.collectAsState()
    val prefs by vm.prefs.collectAsState()
    var settings by remember { mutableStateOf(false) }
    KdsBoard(ui, prefs, onTap = { vm.toggle(it) }, onBump = { vm.bump(it) }, onRecall = { vm.recall() }, onSettings = { settings = true })
    if (settings) KitchenPrefsSheet("Kitchen display", prefs, onChange = { vm.save(it) }, onClose = { settings = false })
}

// The board: the tickets as cards in the order they arrived, each with how
// long it has waited, the cooks' ticks, Bump, and on the right what is still
// to cook across all of them.
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun KdsBoard(ui: KdsUi, prefs: KitchenPrefs, onTap: (String) -> Unit, onBump: (String) -> Unit, onRecall: () -> Unit, onSettings: () -> Unit, modifier: Modifier = Modifier) {
    var picked by remember { mutableStateOf<String?>(null) }
    // A ticket that was not on the screen a moment ago makes a sound. The ones
    // already there when the screen opens do not.
    val ids = ui.cards.map { it.id }
    var seen by remember { mutableStateOf<Set<String>?>(null) }
    LaunchedEffect(ui.loaded, ids) {
        if (!ui.loaded) return@LaunchedEffect
        val before = seen
        seen = ids.toSet()
        if (prefs.sound && before != null && ids.any { it !in before }) {
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
    val late = cards.count { prefs.late(now - it.since) }
    // the text a step larger, for a screen read from across a kitchen
    val k = if (prefs.largeText) 1.2f else 1f

    Row(modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxHeight().padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Column(Modifier.padding(end = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(listOfNotNull("${cards.size} open · $late late", ui.heard).joinToString(" · "), 13.sp, 500, V.Text2)
                    T(ui.title, 26.sp, 700, spacing = (-0.6).sp)
                }
                FlowRow(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // with nowhere to choose between, no row of stations
                    if (ui.stations.isNotEmpty()) (listOf(Station("", "All stations")) + ui.stations).forEach { st ->
                        val on = (st.id.isEmpty() && station == null) || st.id == station
                        val n = ui.cards.count { c -> st.id.isEmpty() || c.lines.any { it.stations.contains(st.id) } }
                        Row(
                            Modifier.height(48.dp).clip(RoundedCornerShape(12.dp)).background(if (on) V.On else V.Key2).clickable { picked = st.id.ifEmpty { null } }.padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            T(st.name, 15.sp, 600, if (on) V.OnText else V.Dim)
                            T(n.toString(), 12.sp, 600, if (on) V.OnText else V.Dim)
                        }
                    }
                }
                if (ui.canRecall) {
                    Box(
                        Modifier.height(48.dp).clip(RoundedCornerShape(12.dp)).border(1.dp, V.Stroke2, RoundedCornerShape(12.dp)).clickable { onRecall() }.padding(horizontal = 18.dp),
                        contentAlignment = Alignment.Center,
                    ) { T("Recall last", 15.sp, 600) }
                }
                IconKey(VI.Gear, 48.dp, onClick = onSettings)
            }
            LazyVerticalStaggeredGrid(
                StaggeredGridCells.Adaptive((272 * k).dp), Modifier.weight(1f).fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(14.dp), verticalItemSpacing = 14.dp,
            ) {
                if (cards.isEmpty()) item(span = StaggeredGridItemSpan.FullLine) {
                    T("All caught up. New tickets appear here when orders are sent.", 17.sp, 500, V.Text2, Modifier.padding(horizontal = 20.dp, vertical = 80.dp), lines = 2, align = androidx.compose.ui.text.style.TextAlign.Center)
                }
                items(cards, key = { it.id }) { c ->
                    val age = (now - c.since).coerceAtLeast(0)
                    val head = when (prefs.tone(age)) {
                        KitchenPrefs.Tone.Red -> V.Red to Color.White
                        KitchenPrefs.Tone.Amber -> V.Amber to V.AmberInk
                        KitchenPrefs.Tone.Fresh -> Color(0xFF2A2F38) to Color.White
                    }
                    Column(Modifier.clip(RoundedCornerShape(18.dp)).background(V.Panel).border(1.dp, V.Stroke, RoundedCornerShape(18.dp))) {
                        Column(Modifier.fillMaxWidth().background(head.first).padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Row(verticalAlignment = Alignment.Bottom) {
                                T(c.label, (24 * k).sp, 700, head.second, Modifier.weight(1f), spacing = (-0.5).sp)
                                T("${age / 60_000}:${((age / 1000) % 60).toString().padStart(2, '0')}", (20 * k).sp, 600, head.second)
                            }
                            Row {
                                T(
                                    listOfNotNull(c.kind.takeIf { prefs.kind }, c.covers?.takeIf { prefs.covers }?.let { "$it covers" }, c.waiter?.takeIf { prefs.waiter }).joinToString(" · "),
                                    (13 * k).sp, 500, head.second, Modifier.weight(1f),
                                )
                                T(c.no, (13 * k).sp, 500, head.second)
                            }
                        }
                        // what was said about the whole order: an allergy, who to ring
                        if (prefs.remark && !c.remark.isNullOrBlank()) {
                            T(c.remark, (14 * k).sp, 600, V.AmberText, Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 2.dp), lines = 4, height = (18 * k).sp)
                        }
                        Column(Modifier.padding(vertical = 4.dp)) {
                            c.lines.forEach { l ->
                                val off = l.done || l.voided
                                Row(
                                    // a voided line is nobody's to tick
                                    Modifier.fillMaxWidth().then(if (l.voided) Modifier else Modifier.clickable { onTap(l.id) })
                                        .drawBehind { drawRect(V.Stroke, androidx.compose.ui.geometry.Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }
                                        .padding(horizontal = 16.dp, vertical = 12.dp),
                                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                                ) {
                                    T(l.units.toString(), (18 * k).sp, 600, if (off) V.Off else V.Text, Modifier.width((30 * k).dp), strike = off)
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                        T(l.name, (17 * k).sp, 600, if (off) V.Off else V.Text, lines = 3, height = (21 * k).sp, strike = off)
                                        if (l.detail.isNotEmpty()) T(l.detail, (14 * k).sp, 500, if (off) V.Off else V.AmberText, lines = 3)
                                    }
                                    if (l.voided) Chip("VOID", V.RedWash, V.RedText)
                                }
                            }
                        }
                        VBtn("Bump", Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 12.dp), V.Green, V.GreenInk, 58.dp, 14.dp, 17.sp) { onBump(c.id) }
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
            val left = cards.flatMap { it.lines }.filter { !it.done && !it.voided }.groupBy { it.name }
                .mapValues { e -> e.value.sumOf { it.units } }.entries.sortedByDescending { it.value }
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

// What a kitchen sets on its own screen: when a ticket turns late, and what a
// ticket shows. A kitchen tablet adds its own below (`more`): its sound, how
// it is paired. Every change is kept as it is made.
@Composable
fun KitchenPrefsSheet(title: String, prefs: KitchenPrefs, onChange: (KitchenPrefs) -> Unit, onClose: () -> Unit, more: @Composable ColumnScope.() -> Unit = {}) {
    Sheet(onClose) {
        SheetHead(title, "Kept on this tablet. Which items a screen shows is set in the back office, under Printers.", onClose)
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Caps("A ticket turns late", V.Text2)
            val set: (Int, Int) -> Unit = { a, r -> KitchenPrefs.tidy(a, r).let { (amber, red) -> onChange(prefs.copy(amberMin = amber, redMin = red)) } }
            PrefRow("Amber after", "Its head turns amber: it is taking a while.") {
                Stepper("${prefs.amberMin}", "min", onDown = { set(prefs.amberMin - 1, prefs.redMin) }, onUp = { set(prefs.amberMin + 1, maxOf(prefs.redMin, prefs.amberMin + 2)) })
            }
            PrefRow("Red after", "Its head turns red, and it counts as late.") {
                Stepper("${prefs.redMin}", "min", onDown = { set(prefs.amberMin, prefs.redMin - 1) }, onUp = { set(prefs.amberMin, prefs.redMin + 1) })
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Caps("A ticket shows", V.Text2)
            T("Its table or order number and its items always show.", 13.sp, 500, V.Text2, lines = 2)
            Switch("Covers", "How many guests are at the table.", prefs.covers) { onChange(prefs.copy(covers = !prefs.covers)) }
            Switch("Waiter", "Who took the order.", prefs.waiter) { onChange(prefs.copy(waiter = !prefs.waiter)) }
            Switch("Order type", "Dine-in, Takeaway, Delivery.", prefs.kind) { onChange(prefs.copy(kind = !prefs.kind)) }
            Switch("Remark", "What was said about the whole order: an allergy, who to ring.", prefs.remark) { onChange(prefs.copy(remark = !prefs.remark)) }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Caps("Display", V.Text2)
            Switch("Larger text", "For a screen read from across the kitchen.", prefs.largeText) { onChange(prefs.copy(largeText = !prefs.largeText)) }
        }
        more()
    }
}

// a setting with something to set it on its right
@Composable
fun PrefRow(title: String, sub: String, control: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(title, 16.sp, 700)
            T(sub, 13.sp, 500, V.Text2, lines = 3)
        }
        control()
    }
}

// a setting that is on or off: the whole row is the key
@Composable
fun Switch(title: String, sub: String, on: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).clickable(onClick = onClick).padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(title, 16.sp, 700)
            T(sub, 13.sp, 500, V.Text2, lines = 3)
        }
        Toggle(on)
    }
}

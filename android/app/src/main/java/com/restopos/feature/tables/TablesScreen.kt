package com.restopos.feature.tables

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Uuid7
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Calc
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// A table on the plan and, when it has an order with something to pay, what
// the plan can say about that order.
data class TableUi(
    val table: TableEntity,
    val occupied: Boolean,
    val total: Long = 0,
    val since: Long? = null,
    val guests: Int? = null,
    val partPaid: Boolean = false, // some of it has been paid (a split bill in progress)
    val waiter: String? = null, // who opened the order, on a till where staff sign in
)

// What the bottom half of every table shows.
enum class PlanView(val label: String) { Covers("Covers"), Total("Total"), Time("Time"), Status("Status") }

private val SEATED = Color(0xFF2E9E4F)

// The floor plan designed in the back office, with each table's open order.
// Read from Room, so it works with no connection.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class TablesViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val tickets: TicketRepository,
) : ViewModel() {
    // null while loading
    val tables: StateFlow<List<TableUi>?> = flow { emit(session.storeId()) }
        .flatMapLatest { store ->
            if (store == null) emptyFlow()
            else combine(db.tables().tables(store), db.tickets().openTickets(store)) { tables, open -> tables to open }
        }
        .mapLatest { (tables, open) ->
            tables.map { t ->
                // the table's order: the most recent open one with something left to pay
                var found: TableUi? = null
                for (ticket in open.filter { it.table_id == t.id }) {
                    val lines = db.tickets().lines(ticket.id).first()
                    val unpaid = lines.filter { !it.paid }
                    if (unpaid.isEmpty()) continue
                    val total = unpaid.sumOf { Calc.lineAmount(it.unit_price, it.qty) + db.tickets().modSum(it.id) }
                    val waiter = ticket.opened_by?.let { db.staff().employee(it)?.name }
                    found = TableUi(t, true, total, Uuid7.millis(ticket.id), ticket.covers, lines.any { it.paid }, waiter)
                    break
                }
                found ?: TableUi(t, false)
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    private val _note = MutableStateFlow<String?>(null)
    val note: StateFlow<String?> = _note
    fun noteShown() { _note.value = null }

    // Tapping a table: its order comes onto the register, or a new one starts
    // there (with its number of guests) when the first item is added.
    fun open(table: TableEntity, guests: Int?, then: () -> Unit) = viewModelScope.launch {
        session.setPendingDiscount(null)
        tickets.openTable(table.id, guests)
        then()
    }

    // Moving the order on the register to a free table.
    fun moveHere(target: TableUi, then: () -> Unit) = viewModelScope.launch {
        if (target.occupied) { _note.value = "${tableLabel(target.table.name)} already has an order. Pick a free table."; return@launch }
        tickets.moveToTable(target.table.id).fold(onSuccess = { then() }, onFailure = { _note.value = it.message })
    }
}

@Composable
fun TablesScreen(moving: Boolean, vm: TablesViewModel = hiltViewModel(), onOpen: () -> Unit, onCancelMove: () -> Unit) {
    val tables by vm.tables.collectAsState()
    val note by vm.note.collectAsState()
    var picked by rememberSaveable { mutableStateOf<String?>(null) }
    var view by rememberSaveable { mutableStateOf(PlanView.Covers) }
    var seating by remember { mutableStateOf<TableEntity?>(null) } // the free table being opened: how many guests?
    note?.let { n -> LaunchedEffect(n) { delay(3500); vm.noteShown() } }
    // refreshed once a minute so "12 min" keeps moving
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = System.currentTimeMillis() } }

    val all = tables
    val areas = all?.map { it.table.area }?.distinct()?.sorted().orEmpty()
    val area = picked?.takeIf { areas.contains(it) } ?: areas.firstOrNull()

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize()) {
            if (moving) {
                Row(Modifier.fillMaxWidth().background(Pos.Blue).padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Pick the free table to move this order to.", Modifier.weight(1f), color = Color.White, fontSize = 14.sp)
                    Text("Cancel", Modifier.clickable(onClick = onCancelMove).padding(8.dp), color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                }
            }
            // the areas, as tabs
            Row(Modifier.fillMaxWidth().background(Pos.Panel).padding(horizontal = 8.dp), verticalAlignment = Alignment.Bottom) {
                areas.forEach { a ->
                    val on = a == area
                    Column(Modifier.width(IntrinsicSize.Max).clickable { picked = a }.padding(horizontal = 12.dp)) {
                        Text(a, Modifier.padding(top = 16.dp, bottom = 14.dp), color = if (on) Pos.NavOn else Pos.Text3, fontSize = 17.sp, maxLines = 1)
                        Box(Modifier.fillMaxWidth().height(2.dp).background(if (on) Pos.NavOn else Color.Transparent))
                    }
                }
                if (areas.isEmpty()) Text("Floor plan", Modifier.padding(horizontal = 12.dp, vertical = 16.dp), color = Pos.Text3, fontSize = 17.sp)
            }
            when {
                all == null -> Unit
                all.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "No tables yet. Lay out the floor plan in the back office, under Tables; it appears here after the next sync.",
                        color = Pos.Text3, fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(32.dp),
                    )
                }
                else -> BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 72.dp)) {
                    // the plan is 100 x 60 grid units; one unit is as big as fits
                    val unit = minOf(maxWidth / 100, maxHeight / 60)
                    Box(Modifier.size(unit * 100, unit * 60).align(Alignment.Center)) {
                        all.filter { it.table.area == area }.forEach { t ->
                            TableTile(
                                t, view, now,
                                Modifier.offset(unit * t.table.x, unit * t.table.y).size(unit * t.table.w, unit * t.table.h),
                            ) {
                                when {
                                    moving -> vm.moveHere(t, onOpen)
                                    t.occupied -> vm.open(t.table, null, onOpen)
                                    else -> seating = t.table
                                }
                            }
                        }
                    }
                }
            }
        }
        // what the tables show: guests, total, time or status
        if (!all.isNullOrEmpty()) {
            Row(Modifier.align(Alignment.BottomStart).padding(12.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Key)) {
                PlanView.entries.forEach { v ->
                    val tint = if (v == view) Color.White else Pos.NavOn.copy(alpha = 0.85f)
                    Column(
                        Modifier.background(if (v == view) Pos.Blue else Color.Transparent).clickable { view = v }
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        when (v) {
                            PlanView.Total -> Text("Rs", color = tint, fontSize = 14.sp, fontWeight = FontWeight.Bold, modifier = Modifier.height(22.dp))
                            else -> Icon(icon(v), contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
                        }
                        Text(v.label, color = tint, fontSize = 13.sp)
                    }
                }
            }
        }
        note?.let { n ->
            Text(
                n,
                Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp))
                    .background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    seating?.let { table ->
        GuestsDialog("${tableLabel(table.name)}: how many guests?", table.seats, onDismiss = { seating = null }) { guests ->
            seating = null
            vm.open(table, guests, onOpen)
        }
    }
}

private fun icon(view: PlanView): ImageVector = when (view) {
    PlanView.Covers -> PosIcons.Cutlery
    PlanView.Time -> PosIcons.Clock
    PlanView.Status -> Icons.Filled.Search
    PlanView.Total -> PosIcons.Clock // not drawn: Total shows "Rs"
}

// A table: its name on top, and under the line what the chosen view says.
// A table with an order carries a green marker in its corner.
@Composable
private fun TableTile(t: TableUi, view: PlanView, now: Long, modifier: Modifier, onTap: () -> Unit) {
    val shape = if (t.table.shape == "round") CircleShape else RoundedCornerShape(4.dp)
    Box(modifier) {
        Column(
            Modifier.fillMaxSize().clip(shape).background(Pos.Tile.copy(alpha = if (t.occupied) 1f else 0.6f)).clickable(onClick = onTap),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(t.table.name, color = Pos.Text, fontSize = 20.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Pos.Line.copy(alpha = 0.6f)))
            Box(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 4.dp), contentAlignment = Alignment.Center) {
                when (view) {
                    PlanView.Covers -> Seats(t.table.seats, if (t.occupied) t.guests ?: 0 else 0)
                    PlanView.Total -> Info(if (t.occupied) Money.format(t.total) else null)
                    PlanView.Time -> Info(t.since?.takeIf { t.occupied }?.let {
                        val minutes = ((now - it) / 60_000).coerceAtLeast(0)
                        if (minutes < 60) "$minutes min" else "${minutes / 60} h ${minutes % 60}"
                    })
                    PlanView.Status -> Info(
                        if (!t.occupied) null
                        else listOfNotNull(if (t.partPaid) "Part paid" else "Open", t.waiter?.substringBefore(' ')).joinToString(" · "),
                        free = "Free",
                    )
                }
            }
        }
        if (t.occupied) {
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = 5.dp, y = (-5).dp).size(22.dp).clip(RoundedCornerShape(3.dp)).background(SEATED),
                contentAlignment = Alignment.Center,
            ) { Icon(Icons.Filled.Person, contentDescription = "Has an order", tint = Color.White, modifier = Modifier.size(15.dp)) }
        }
    }
}

// One dot per seat, lit for each guest. A big table says it in figures.
@Composable
private fun Seats(seats: Int, guests: Int) {
    if (seats > 8) {
        Info(if (guests > 0) "$guests of $seats" else null, free = "$seats seats")
        return
    }
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        repeat(seats) { i ->
            Box(Modifier.size(9.dp).clip(CircleShape).background(if (i < guests) Color.White else Color(0xFF6B6F7A)))
        }
    }
}

@Composable
private fun Info(text: String?, free: String = "—") {
    Text(
        text ?: free, color = if (text == null) Pos.Text3 else Pos.Text, fontSize = 13.sp,
        fontWeight = if (text == null) FontWeight.Normal else FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
}

// How many guests are sitting down: asked when a free table is opened, and
// from the register's guests chip. Numbers above the table's seats are dimmed,
// not refused (an extra chair happens).
@Composable
fun GuestsDialog(title: String, seats: Int, onDismiss: () -> Unit, onPick: (Int?) -> Unit) {
    Dialog(onDismissRequest = onDismiss) {
        Column(Modifier.width(380.dp).clip(RoundedCornerShape(4.dp)).background(Pos.PanelDeep)) {
            Box(Modifier.fillMaxWidth().background(Pos.Panel).padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
                Text(title, color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                (1..12).chunked(4).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { n ->
                            Box(
                                Modifier.weight(1f).height(56.dp).clip(RoundedCornerShape(3.dp))
                                    .background(if (n <= seats) Pos.Key else Pos.Key.copy(alpha = 0.5f))
                                    .border(1.dp, Pos.Line, RoundedCornerShape(3.dp)).clickable { onPick(n) },
                                contentAlignment = Alignment.Center,
                            ) { Text("$n", color = Pos.Text, fontSize = 20.sp, fontWeight = FontWeight.Medium) }
                        }
                    }
                }
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(
                        Modifier.weight(1f).height(52.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Key).clickable(onClick = onDismiss),
                        contentAlignment = Alignment.Center,
                    ) { Text("Cancel", color = Pos.NavOn, fontSize = 16.sp) }
                    Box(
                        Modifier.weight(1f).height(52.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Blue).clickable { onPick(null) },
                        contentAlignment = Alignment.Center,
                    ) { Text("Skip", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

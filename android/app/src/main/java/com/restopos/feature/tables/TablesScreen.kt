package com.restopos.feature.tables

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Uuid7
import com.restopos.core.data.Calc
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Pos
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
// that order comes to and when it was opened.
data class TableUi(val table: TableEntity, val occupied: Boolean, val total: Long, val since: Long?, val guests: Int?)

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
                    val unpaid = db.tickets().lines(ticket.id).first().filter { !it.paid }
                    if (unpaid.isEmpty()) continue
                    val total = unpaid.sumOf { Calc.lineAmount(it.unit_price, it.qty) + db.tickets().modSum(it.id) }
                    found = TableUi(t, true, total, Uuid7.millis(ticket.id), ticket.covers)
                    break
                }
                found ?: TableUi(t, false, 0, null, null)
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    private val _note = MutableStateFlow<String?>(null)
    val note: StateFlow<String?> = _note
    fun noteShown() { _note.value = null }

    // Tapping a table: its order comes onto the register, or a new one starts
    // there with the first item.
    fun open(table: TableEntity, then: () -> Unit) = viewModelScope.launch {
        session.setPendingDiscount(null)
        tickets.openTable(table.id)
        then()
    }

    // Moving the order on the register to a free table.
    fun moveHere(target: TableUi, then: () -> Unit) = viewModelScope.launch {
        if (target.occupied) { _note.value = "Table ${target.table.name} already has an order. Pick a free table."; return@launch }
        tickets.moveToTable(target.table.id).fold(onSuccess = { then() }, onFailure = { _note.value = it.message })
    }
}

@Composable
fun TablesScreen(moving: Boolean, vm: TablesViewModel = hiltViewModel(), onOpen: () -> Unit, onCancelMove: () -> Unit) {
    val tables by vm.tables.collectAsState()
    val note by vm.note.collectAsState()
    var picked by rememberSaveable { mutableStateOf<String?>(null) }
    note?.let { n -> LaunchedEffect(n) { delay(3500); vm.noteShown() } }
    // refreshed once a minute so "12 min" keeps moving
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = System.currentTimeMillis() } }

    val all = tables
    val areas = all?.map { it.table.area }?.distinct()?.sorted().orEmpty()
    val area = picked?.takeIf { areas.contains(it) } ?: areas.firstOrNull()

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (moving) {
                Row(Modifier.fillMaxWidth().background(Pos.Blue).padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Pick the free table to move this order to.", Modifier.weight(1f), color = Color.White, fontSize = 14.sp)
                    Text("Cancel", Modifier.clickable(onClick = onCancelMove).padding(8.dp), color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
                }
            }
            if (areas.size > 1) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    areas.forEach { a ->
                        val on = a == area
                        val busy = all.orEmpty().count { it.table.area == a && it.occupied }
                        Text(
                            if (busy > 0) "$a · $busy" else a,
                            Modifier.clip(RoundedCornerShape(4.dp)).background(if (on) Pos.Blue else Pos.Key).clickable { picked = a }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                            color = if (on) Color.White else Pos.Text2, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                        )
                    }
                }
            }
            when {
                all == null -> Unit
                all.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "No tables yet. Lay out the floor plan in the back office, under Tables; it appears here after the next sync.",
                        color = Pos.Text3, fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(32.dp),
                    )
                }
                else -> BoxWithConstraints(Modifier.fillMaxSize().background(Pos.PanelDeep)) {
                    // the plan is 100 x 60 grid units; one unit is as big as fits
                    val unit = minOf(maxWidth / 100, maxHeight / 60)
                    Box(Modifier.size(unit * 100, unit * 60).align(Alignment.Center)) {
                        all.filter { it.table.area == area }.forEach { t ->
                            val shape = if (t.table.shape == "round") CircleShape else RoundedCornerShape(6.dp)
                            Column(
                                Modifier.offset(unit * t.table.x, unit * t.table.y).size(unit * t.table.w, unit * t.table.h)
                                    .clip(shape).background(if (t.occupied) Pos.Blue else Pos.Tile)
                                    .border(1.dp, if (t.occupied) Pos.NavOn else Pos.TileEdge.copy(alpha = 0.35f), shape)
                                    .clickable { if (moving) vm.moveHere(t, onOpen) else vm.open(t.table, onOpen) }
                                    .padding(4.dp),
                                verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                Text(t.table.name, color = Pos.Text, fontSize = 17.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (t.occupied) {
                                    Text(Money.format(t.total), color = Color.White, fontSize = 13.sp, maxLines = 1)
                                    val minutes = t.since?.let { ((now - it) / 60_000).coerceAtLeast(0) }
                                    Text(
                                        listOfNotNull(minutes?.let { if (it < 60) "$it min" else "${it / 60} h ${it % 60} min" }, t.guests?.let { "$it guests" }).joinToString(" · "),
                                        color = Color.White.copy(alpha = 0.8f), fontSize = 11.sp, maxLines = 1,
                                    )
                                } else {
                                    Text("${t.table.seats} seats", color = Pos.Text2, fontSize = 12.sp, maxLines = 1)
                                }
                            }
                        }
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
}

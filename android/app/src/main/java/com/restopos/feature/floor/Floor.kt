package com.restopos.feature.floor

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.OrderInfo
import com.restopos.core.data.OrderOps
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.BookingEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Gap
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.L
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
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
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

// A table as the floor shows it: free, seated, waiting for its bill, or held
// for a booking.
data class TableUi(val table: TableEntity, val status: String, val order: OrderInfo?, val booking: BookingEntity?)

data class FloorUi(
    val ready: Boolean = false,
    val zones: List<String> = emptyList(),
    val tables: List<TableUi> = emptyList(),
    val orders: List<OrderInfo> = emptyList(), // what the open-orders list shows
    val upcoming: List<BookingEntity> = emptyList(),
)

@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class FloorViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val service: ServiceRepository,
    private val tickets: TicketRepository,
    private val orderOps: OrderOps,
) : ViewModel() {
    val zone = MutableStateFlow<String?>(null)
    val selected = MutableStateFlow<String?>(null)

    val ui: StateFlow<FloorUi> = flow { emit(session.storeId()) }.flatMapLatest { store ->
        if (store == null) flowOf(FloorUi(ready = true))
        else combine(db.tables().tables(store), service.orders(store), service.bookingsToday(store)) { tables, orders, bookings ->
            val waiting = bookings.filter { it.status == "confirmed" || it.status == "pending" }
            val rows = tables.map { t ->
                val order = orders.firstOrNull { it.open && it.ticket.table_id == t.id }
                val booking = waiting.firstOrNull { it.table_id == t.id }
                val status = when {
                    order != null && order.ticket.bill_at != null -> "bill"
                    order != null -> "open"
                    booking != null -> "reserved"
                    else -> "free"
                }
                TableUi(t, status, order, booking)
            }
            FloorUi(
                true, tables.map { it.area }.distinct(), rows,
                // a table's order always; another order once it has something on it
                orders.filter { it.open && (it.table != null || it.lines.isNotEmpty()) },
                waiting.take(3),
            )
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), FloorUi())

    fun pickZone(z: String) { zone.value = z; selected.value = null }
    fun pick(tableId: String?) { selected.value = tableId }
    fun show(table: TableEntity) { zone.value = table.area; selected.value = table.id }

    // Seats the table and opens its order. A booking that was waiting for the
    // table is marked as arrived.
    fun seat(tableId: String, covers: Int, booking: BookingEntity?, then: () -> Unit) = viewModelScope.launch {
        tickets.seat(tableId, covers).fold(
            onSuccess = { t ->
                if (booking != null) service.changeBooking(booking.id) { it.copy(status = "seated", table_id = tableId, ticket_id = t.id) }
                selected.value = null
                then()
            },
            onFailure = { Toaster.say(it.message) },
        )
    }

    fun open(order: OrderInfo, then: () -> Unit) = viewModelScope.launch {
        tickets.select(order.id)
        then()
    }

    fun printBill(order: OrderInfo) = viewModelScope.launch {
        tickets.select(order.id)
        orderOps.printBill(tickets.pendingDiscount()).fold(
            onSuccess = { Toaster.say("Bill printed · ${order.label}") },
            onFailure = { Toaster.say(if (it is NeedsApproval) it.message else "${order.label} is waiting for its bill. ${it.message}") },
        )
    }

    // A table seated by mistake, with nothing ordered: the order lets go of it.
    fun free(order: OrderInfo) = viewModelScope.launch {
        tickets.select(order.id)
        tickets.release().fold(
            onSuccess = { tickets.newTicket(); selected.value = null; Toaster.say("${order.label} is free again") },
            onFailure = { Toaster.say(it.message) },
        )
    }

    // The booking keeps its time and name, and waits for another table.
    fun release(booking: BookingEntity, label: String) = viewModelScope.launch {
        service.changeBooking(booking.id) { it.copy(table_id = null) }
            .fold({ Toaster.say("$label released") }, { Toaster.say(it.message) })
    }

    fun assign(booking: BookingEntity, table: TableEntity, then: () -> Unit) = viewModelScope.launch {
        service.changeBooking(booking.id) { it.copy(table_id = table.id, area = table.area) }.fold(
            onSuccess = { Toaster.say("${table.name} is held for ${booking.name}"); selected.value = null; then() },
            onFailure = { Toaster.say(it.message) },
        )
    }
}

private val HM = SimpleDateFormat("HH:mm", Locale.US)
private fun minutes(since: Long, now: Long): Int = ((now - since) / 60_000).coerceAtLeast(0).toInt()

// The floor plan: every table of the room that is open, what it is doing, and
// beside it the orders in progress or the table that was tapped.
@Composable
fun FloorScreen(
    vm: FloorViewModel,
    assigning: BookingEntity?, // a booking waiting to be given a table
    onAssigned: () -> Unit,
    onOrder: () -> Unit,
    onPay: () -> Unit,
    onBookings: () -> Unit,
) {
    val ui by vm.ui.collectAsState()
    val pickedZone by vm.zone.collectAsState()
    val sel by vm.selected.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(15_000) } }
    val zone = pickedZone?.takeIf { ui.zones.contains(it) } ?: ui.zones.firstOrNull()
    val here = ui.tables.filter { it.table.area == zone }
    val picked = ui.tables.firstOrNull { it.table.id == sel }

    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxHeight().padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (ui.zones.isNotEmpty()) {
                    Seg(ui.zones.map { z ->
                        val all = ui.tables.filter { it.table.area == z }
                        SegOption(z, z == zone, "${all.count { it.order != null }}/${all.size}") { vm.pickZone(z) }
                    })
                }
                Gap()
                Legend(V.TableFree, V.SeatOffLine, L.free)
                Legend(V.Blue, null, L.seated)
                Legend(V.Amber, null, L.billAsked)
                Legend(V.VioletDeep, V.Violet, L.reserved, dashed = true)
            }
            if (assigning != null) {
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.VioletWash).padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    T("Pick a free table for ${assigning.name} · ${assigning.size} guests · ${HM.format(Date(assigning.booked_for))}", 15.sp, 700, V.VioletText, Modifier.weight(1f))
                    VBtn("Cancel", height = 40.dp, radius = 10.dp, size = 14.sp, onClick = onAssigned)
                }
            }
            BoxWithConstraints(
                Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(V.Side).border(1.dp, V.Stroke, RoundedCornerShape(18.dp)).dots(),
            ) {
                if (ui.ready && ui.tables.isEmpty()) {
                    T(
                        "No tables yet. Draw the floor plan in the back office, under Tables, and it shows here.",
                        15.sp, 600, V.Text2, Modifier.align(Alignment.Center).padding(40.dp), lines = 3,
                    )
                }
                val cw = maxWidth - 96.dp
                val ch = maxHeight - 88.dp
                // The back office draws on a 100 x 60 plan. What this room uses of
                // it is fitted into the canvas and centred, up to a size at which
                // a table for four is still a table and not a billboard.
                val minX = here.minOfOrNull { it.table.x } ?: 0
                val minY = here.minOfOrNull { it.table.y } ?: 0
                val spanX = ((here.maxOfOrNull { it.table.x + it.table.w } ?: 100) - minX).coerceAtLeast(10)
                val spanY = ((here.maxOfOrNull { it.table.y + it.table.h } ?: 60) - minY).coerceAtLeast(10)
                val unit = minOf(cw / spanX.toFloat(), ch / spanY.toFloat(), 11.dp)
                val ox = 48.dp + (cw - unit * spanX.toFloat()) / 2 - unit * minX.toFloat()
                val oy = 44.dp + (ch - unit * spanY.toFloat()) / 2 - unit * minY.toFloat()
                here.forEach { t ->
                    val w = unit * t.table.w.toFloat()
                    val h = unit * t.table.h.toFloat()
                    Box(Modifier.offset(ox + unit * t.table.x.toFloat(), oy + unit * t.table.y.toFloat())) {
                        TableView(t, w, h, t.table.id == sel, t.order?.let { minutes(it.openedAt, now) } ?: 0) {
                            vm.pick(if (sel == t.table.id) null else t.table.id)
                        }
                    }
                }
            }
        }
        Column(Modifier.width(360.dp).fillMaxHeight().background(V.Panel).drawBehind { drawRect(V.Stroke, size = Size(1.dp.toPx(), size.height)) }) {
            if (picked == null) Overview(ui, now, vm, onOrder, onBookings)
            else Picked(picked, now, vm, assigning, onAssigned, onOrder, onPay)
        }
    }
}

@Composable
private fun Legend(fill: Color, line: Color?, label: String, dashed: Boolean = false) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(12.dp).clip(RoundedCornerShape(4.dp)).background(fill)
                .then(if (line == null) Modifier else if (dashed) Modifier.dashed(line, 4.dp, 1.5.dp) else Modifier.border(1.5.dp, line, RoundedCornerShape(4.dp))),
        )
        Spacer(Modifier.width(7.dp))
        T(label, 13.sp, 600, V.Text2)
    }
}

// the faint dot grid of the plan
private fun Modifier.dots(): Modifier = drawBehind {
    val step = 24.dp.toPx()
    val dot = Color(if (com.restopos.core.ui.Pos.light) 0x14000000 else 0x12FFFFFF)
    var y = step / 2
    while (y < size.height) {
        var x = step / 2
        while (x < size.width) { drawCircle(dot, 1.dp.toPx(), Offset(x, y)); x += step }
        y += step
    }
}

private fun Modifier.dashed(color: Color, radius: Dp, width: Dp, round: Boolean = false): Modifier = drawBehind {
    val r = if (round) minOf(size.width, size.height) / 2 else radius.toPx()
    drawRoundRect(
        color, cornerRadius = CornerRadius(r, r),
        style = Stroke(width.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))),
    )
}

// where the chairs go: round a round table, down the long sides of the others
private fun seats(shape: String, n: Int, w: Float, h: Float, g: Float): List<Pair<Float, Float>> {
    val out = ArrayList<Pair<Float, Float>>()
    if (shape == "round") {
        for (i in 0 until n) {
            val a = if (n == 1) PI / 2 else -PI / 2 + i * 2 * PI / n
            out += (w / 2 + (w / 2 + g) * cos(a).toFloat()) to (h / 2 + (h / 2 + g) * sin(a).toFloat())
        }
    } else if (n == 4 && abs(w - h) < 2f) {
        out += (w / 2) to -g; out += (w + g) to (h / 2); out += (w / 2) to (h + g); out += -g to (h / 2)
    } else {
        val top = (n + 1) / 2
        val bottom = n - top
        for (i in 0 until top) out += (w * (i + 1) / (top + 1)) to -g
        for (i in 0 until bottom) out += (w * (i + 1) / (bottom + 1)) to (h + g)
    }
    return out
}

@Composable
private fun TableView(t: TableUi, w: Dp, h: Dp, selected: Boolean, mins: Int, onTap: () -> Unit) {
    val round = t.table.shape == "round"
    val shape = if (round) RoundedCornerShape(50) else RoundedCornerShape(12.dp)
    val bg = when (t.status) { "open" -> V.Blue; "bill" -> V.Amber; "reserved" -> V.VioletDeep; else -> V.TableFree }
    val fg = when (t.status) { "open" -> Color.White; "bill" -> V.AmberInk; "reserved" -> V.VioletText; else -> V.Text }
    val sub = when (t.status) { "open" -> Color.White; "bill" -> V.AmberInk; "reserved" -> V.VioletText; else -> V.Text2 }
    val accent = when (t.status) { "open" -> V.Blue; "bill" -> V.Amber; "reserved" -> V.Violet; else -> V.TableFreeLine }
    val covers = t.order?.ticket?.covers ?: 0
    Box(Modifier.size(w, h)) {
        seats(t.table.shape, t.table.seats.coerceIn(0, 14), w.value, h.value, 12f).forEachIndexed { i, (x, y) ->
            val on = i < covers
            Box(
                Modifier.offset((x - 7).dp, (y - 7).dp).size(14.dp).clip(RoundedCornerShape(5.dp)).background(if (on) accent else V.SeatOff)
                    .border(1.5.dp, if (on || t.status == "reserved") accent else V.SeatOffLine, RoundedCornerShape(5.dp)),
            )
        }
        Column(
            Modifier.fillMaxSize()
                .then(if (selected) Modifier.drawBehind {
                    val grow = 4.5.dp.toPx()
                    val r = if (round) (minOf(size.width, size.height) / 2 + grow) else 12.dp.toPx() + grow
                    drawRoundRect(V.Cyan, Offset(-grow, -grow), Size(size.width + 2 * grow, size.height + 2 * grow), CornerRadius(r, r), style = Stroke(3.dp.toPx()))
                } else Modifier.shadow(6.dp, shape))
                .clip(shape).background(bg)
                .then(if (t.status == "reserved") Modifier.dashed(V.Violet, 12.dp, 1.5.dp, round) else if (t.status == "free") Modifier.border(1.5.dp, V.TableFreeLine, shape) else Modifier)
                .clickable(onClick = onTap),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
        ) {
            T(t.table.name, 16.sp, 800, fg, spacing = (-0.2).sp)
            if (w >= 66.dp) {
                T(
                    when (t.status) {
                        "free" -> "${t.table.seats} seat${if (t.table.seats == 1) "" else "s"}"
                        "reserved" -> t.booking?.let { HM.format(Date(it.booked_for)) } ?: ""
                        else -> Money.format(t.order?.due ?: 0)
                    },
                    12.sp, 700, sub,
                )
            }
        }
        if (t.order != null) {
            Box(
                Modifier.align(Alignment.TopEnd).offset(14.dp, (-11).dp).height(23.dp).clip(RoundedCornerShape(12.dp))
                    .background(if (mins >= 60) V.Red else Color(0xFF0D0F13)).border(1.5.dp, V.Stroke2, RoundedCornerShape(12.dp)).padding(horizontal = 8.dp),
                contentAlignment = Alignment.Center,
            ) { T("${mins}m", 11.sp, 800, Color.White) }
        }
    }
}

// Nothing tapped: the orders in progress, and who is expected next.
@Composable
private fun ColumnScope.Overview(ui: FloorUi, now: Long, vm: FloorViewModel, onOrder: () -> Unit, onBookings: () -> Unit) {
    val busy = ui.tables.count { it.order != null }
    val covers = ui.tables.sumOf { it.order?.ticket?.covers ?: 0 }
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 14.dp), verticalAlignment = Alignment.Bottom) {
        T(L.openOrders, 18.sp, 800)
        Gap()
        T("$busy/${ui.tables.size} tables · $covers ${L.covers}", 13.sp, 600, V.Text2)
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
    val list = ui.orders.sortedByDescending { (if (it.ticket.bill_at != null) 1_000_000 else 0) + minutes(it.openedAt, now) }
    LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp)) {
        if (list.isEmpty()) item { T("No orders in progress. Tap a free table to seat guests.", 14.sp, 600, V.Text3, Modifier.padding(20.dp), lines = 3) }
        items(list, key = { it.id }) { o ->
            val bill = o.ticket.bill_at != null
            val dine = o.table != null
            val m = minutes(o.openedAt, now)
            Row(
                Modifier.fillMaxWidth().heightIn(min = 62.dp).clip(RoundedCornerShape(12.dp))
                    .clickable { if (o.table != null) vm.show(o.table) else vm.open(o, onOrder) }.padding(10.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    Modifier.widthIn(min = 50.dp).height(42.dp).clip(RoundedCornerShape(10.dp))
                        .background(if (bill) V.Amber else if (dine) V.Blue else V.TableFree).padding(horizontal = 8.dp),
                    contentAlignment = Alignment.Center,
                ) { T(o.label, 14.sp, 800, if (bill) V.AmberInk else if (dine) Color.White else V.Text) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    val who = o.waiter?.let { " · $it" } ?: ""
                    T(if (dine) "${o.ticket.covers ?: 0} ${L.covers}$who" else (o.ticket.name ?: o.typeName) + who, 15.sp, 700)
                    T("${if (dine) o.table?.area ?: "" else o.typeName} · ${o.units} item${if (o.units == 1) "" else "s"}", 13.sp, 500, V.Text2)
                }
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(Money.format(o.due), 15.sp, 800)
                    T(if (bill) L.billAsked else "$m min", 12.sp, 700, if (bill) V.AmberText else if (m >= 60) V.RedText else V.Text2)
                }
            }
        }
    }
    if (ui.upcoming.isNotEmpty()) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Caps(L.arriving, modifier = Modifier.padding(bottom = 4.dp))
            ui.upcoming.forEach { b ->
                val table = ui.tables.firstOrNull { it.table.id == b.table_id }?.table
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { if (table != null) vm.show(table) else onBookings() }.padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    T(HM.format(Date(b.booked_for)), 14.sp, 800, modifier = Modifier.width(44.dp))
                    Column(Modifier.weight(1f)) {
                        T(b.name, 14.sp, 700)
                        T("${b.size} guests" + (b.area?.let { " · $it" } ?: ""), 12.sp, 500, V.Text2)
                    }
                    Chip(table?.name ?: "Unassigned", V.VioletWash, V.VioletText, 26.dp, weight = 800)
                }
            }
        }
    }
}

// A table was tapped: seat it, see its order, or greet its booking.
@Composable
private fun ColumnScope.Picked(t: TableUi, now: Long, vm: FloorViewModel, assigning: BookingEntity?, onAssigned: () -> Unit, onOrder: () -> Unit, onPay: () -> Unit) {
    val chip = when (t.status) {
        "open" -> Triple(L.seated, V.BlueWash, V.BlueSoft); "bill" -> Triple(L.billAsked, V.AmberWash, V.AmberText)
        "reserved" -> Triple(L.reserved, V.VioletWash, V.VioletText); else -> Triple(L.free, V.TableFree, V.Dim)
    }
    Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            T(t.table.name, 32.sp, 800, spacing = (-0.8).sp)
            Chip(chip.first, chip.second, chip.third, 28.dp, 14.dp, 13.sp, 800, 12.dp)
            Gap()
            IconKey(VI.Close) { vm.pick(null) }
        }
        T("${t.table.area} · ${t.table.seats} seat${if (t.table.seats == 1) "" else "s"}", 14.sp, 600, V.Text2)
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
    val o = t.order
    when {
        o != null -> {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Stat("Covers", (o.ticket.covers ?: 0).toString(), Modifier.weight(1f))
                Stat("Server", o.waiter ?: "—", Modifier.weight(1f))
                Stat("Seated", "${minutes(o.openedAt, now)} min", Modifier.weight(1f))
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
            LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp)) {
                if (o.lines.isEmpty()) item { T("Nothing ordered yet.", 14.sp, 600, V.Text3, Modifier.padding(vertical = 14.dp)) }
                items(o.lines, key = { it.line.id }) { l ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 9.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        T("${l.units}×", 15.sp, 700, V.Text2, Modifier.width(28.dp))
                        T(l.line.name_snapshot, 15.sp, 600, if (l.line.paid) V.Off else V.Text, Modifier.weight(1f), lines = 2, strike = l.line.paid)
                        T(Money.format(l.amount), 15.sp, 700, if (l.line.paid) V.Off else V.Text)
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
            Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, top = 14.dp, bottom = 18.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.Bottom) {
                    T("${o.units} item${if (o.units == 1) "" else "s"}", 14.sp, 600, V.Text2)
                    Gap()
                    T(Money.format(o.due), 26.sp, 800, spacing = (-0.5).sp)
                }
                if (o.lines.isEmpty()) {
                    VBtn("Free the table", Modifier.fillMaxWidth()) { vm.free(o) }
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        VBtn(L.printBill, Modifier.weight(1f)) { vm.printBill(o) }
                        VBtn(L.pay, Modifier.weight(1f), V.Green, V.GreenInk, weight = 800) { vm.open(o, onPay) }
                    }
                }
                VBtn(L.openOrder, Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, size = 16.sp, weight = 800) { vm.open(o, onOrder) }
            }
        }
        assigning != null && t.status == "free" -> {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                T("Hold ${t.table.name} for ${assigning.name}?", 17.sp, 800, lines = 2)
                T("${assigning.size} guests at ${HM.format(Date(assigning.booked_for))}. The table shows as reserved until they arrive.", 13.sp, 500, V.Text2, lines = 4, height = 19.sp)
                VBtn("Assign ${t.table.name}", Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, size = 16.sp, weight = 800) { vm.assign(assigning, t.table, onAssigned) }
            }
        }
        t.status == "reserved" && t.booking != null -> {
            val b = t.booking
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.VioletDeep).border(1.dp, V.VioletLine, RoundedCornerShape(14.dp)).padding(18.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    T(HM.format(Date(b.booked_for)), 14.sp, 800, V.VioletText)
                    T(b.name, 20.sp, 800, lines = 2)
                    T("${b.size} guests" + (b.phone?.let { " · $it" } ?: ""), 14.sp, 500, V.Dim)
                    if (!b.tags.isNullOrBlank()) T(b.tags, 14.sp, 700, V.VioletText, Modifier.padding(top = 4.dp), lines = 3)
                }
                VBtn("Guests arrived · seat now", Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, size = 16.sp, weight = 800) { vm.seat(t.table.id, b.size, b, onOrder) }
                VBtn("Release table", Modifier.fillMaxWidth()) { vm.release(b, t.table.name) }
            }
        }
        else -> {
            Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                T(L.howMany, 17.sp, 800)
                val max = maxOf(8, t.table.seats)
                (1..max).chunked(4).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        row.forEach { n ->
                            Box(
                                Modifier.weight(1f).height(66.dp).clip(RoundedCornerShape(12.dp)).background(V.Key).clickable { vm.seat(t.table.id, n, null, onOrder) },
                                contentAlignment = Alignment.Center,
                            ) { T(n.toString(), 24.sp, 800) }
                        }
                        repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
                T("Tapping a number seats the table and opens the order. Covers can be changed later.", 13.sp, 500, V.Text2, lines = 3, height = 19.sp)
            }
        }
    }
}

@Composable
private fun Stat(label: String, value: String, modifier: Modifier) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        T(label, 12.sp, 600, V.Text2)
        T(value, 17.sp, 800)
    }
}

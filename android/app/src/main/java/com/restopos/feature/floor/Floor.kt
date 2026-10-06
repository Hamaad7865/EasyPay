package com.restopos.feature.floor

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PointMode
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Approvals
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.OrderInfo
import com.restopos.core.data.OrderOps
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
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
import com.restopos.core.ui.Motion
import com.restopos.core.ui.Pos
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.press
import com.restopos.core.ui.rememberPress
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
import kotlin.math.atan2
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
    private val approvals: Approvals,
) : ViewModel() {
    val zone = MutableStateFlow<String?>(null)
    val selected = MutableStateFlow<String?>(null)
    // an order in hand: the table tapped next takes it, or the two become one bill
    val moving = MutableStateFlow<OrderInfo?>(null)

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

    // A table seated by mistake, with nothing ordered: its order is closed.
    fun free(order: OrderInfo) = viewModelScope.launch {
        tickets.cancelOrder(order.id).fold(
            onSuccess = { tickets.newTicket(); selected.value = null; Toaster.say("${order.label} is free again") },
            onFailure = { Toaster.say(it.message) },
        )
    }

    fun startMove(order: OrderInfo) { moving.value = order; selected.value = null }
    fun stopMove() { moving.value = null }

    // The order in hand goes to a free table as it is: its guests, its items and its time with it.
    fun moveTo(order: OrderInfo, table: TableEntity) = viewModelScope.launch {
        tickets.select(order.id)
        tickets.moveToTable(table.id).fold(
            onSuccess = { moving.value = null; zone.value = table.area; selected.value = table.id; Toaster.say("${nameOf(order)} moved to ${tableLabel(table.name)}") },
            onFailure = { Toaster.say(it.message) },
        )
    }

    // The order in hand goes onto a table that has one: one bill for both, and
    // the table it came from is free. Someone who may not transfer an order is
    // asked for someone who may.
    fun mergeInto(order: OrderInfo, target: TableUi, by: StaffMember? = null) {
        val into = target.order ?: return
        viewModelScope.launch {
            val out = tickets.merge(order.id, into.id, by)
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                approvals.ask(need.permission, need.what) { approver -> mergeInto(order, target, approver) }
            } else {
                out.fold(
                    onSuccess = { moving.value = null; zone.value = target.table.area; selected.value = target.table.id; Toaster.say("${nameOf(order)} and ${nameOf(into)} are one bill now, on ${nameOf(into)}") },
                    onFailure = { Toaster.say(it.message) },
                )
            }
        }
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
// an order as it is spoken of: "Table 3", or its number when it has no table
private fun nameOf(o: OrderInfo): String = o.table?.let { tableLabel(it.name) } ?: o.label
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
    val moving by vm.moving.collectAsState()
    // an order in hand is put down when the floor is left
    DisposableEffect(Unit) { onDispose { vm.stopMove() } }
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
            moving?.let { m ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.BlueWash).padding(horizontal = 16.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    T("${nameOf(m)} is in hand · tap a free table to move it there, or a seated one to put both on one bill", 15.sp, 700, V.BlueSoft, Modifier.weight(1f), lines = 2)
                    VBtn("Cancel", height = 40.dp, radius = 10.dp, size = 14.sp) { vm.stopMove() }
                }
            }
            // Another room comes in from the side its key is on. The room that
            // is there when the screen opens is simply there.
            val at = ui.zones.indexOf(zone)
            val turn = remember { intArrayOf(-1, 1) } // the room last shown (its place in the switch), and the side the next comes in from
            val enter = remember(zone) {
                val first = turn[0] < 0 || at < 0
                turn[1] = if (at >= turn[0]) 1 else -1
                if (at >= 0) turn[0] = at
                Animatable(if (first) 1f else 0f)
            }
            LaunchedEffect(enter) { enter.animateTo(1f, Motion.enter(260)) }
            // the plan sits on the page itself, on a dot grid that fades out toward its edges
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().dots()) {
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
                // chairs keep their size down to a point, then shrink with the tables of a big room
                val k = (unit / 11.dp).coerceIn(0.62f, 1f)
                Box(Modifier.fillMaxSize().graphicsLayer { alpha = enter.value; translationX = (1f - enter.value) * turn[1] * 28.dp.toPx() }) {
                    here.forEach { t ->
                        val w = unit * t.table.w.toFloat()
                        val h = unit * t.table.h.toFloat()
                        Box(Modifier.offset(ox + unit * t.table.x.toFloat(), oy + unit * t.table.y.toFloat())) {
                            // with an order in hand its table is ringed too, and a table held for a booking cannot take it
                            val inHand = moving != null && t.order?.id == moving?.id
                            TableView(t, w, h, k, t.table.id == sel || inHand, t.order?.let { minutes(it.openedAt, now) } ?: 0, dim = moving != null && t.status == "reserved") {
                                vm.pick(if (sel == t.table.id) null else t.table.id)
                            }
                        }
                    }
                }
            }
        }
        Column(Modifier.width(360.dp).fillMaxHeight().background(V.Panel).drawBehind { drawRect(V.Stroke, size = Size(1.dp.toPx(), size.height)) }) {
            if (picked == null) Overview(ui, now, vm, onOrder, onBookings)
            else Picked(picked, now, vm, assigning, moving?.takeIf { it.id != picked.order?.id }, onAssigned, onOrder, onPay)
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

// The faint dot grid the plan sits on: clearest in the middle of the room and
// fading out toward its edges, so the plan has no box round it.
private fun Modifier.dots(): Modifier = drawWithCache {
    val step = 24.dp.toPx()
    val bands = List(4) { ArrayList<Offset>() }
    var y = step / 2
    while (y < size.height) {
        var x = step / 2
        while (x < size.width) {
            // how far out this dot is: 0 in the middle, 1 at an edge
            val far = maxOf(abs(x / size.width - 0.5f), abs(y / size.height - 0.5f)) * 2f
            bands[((1f - far) * 4f).toInt().coerceIn(0, 3)].add(Offset(x, y))
            x += step
        }
        y += step
    }
    val ink = if (Pos.light) Color.Black else Color.White
    onDrawBehind {
        bands.forEachIndexed { i, dots -> drawPoints(dots, PointMode.Points, ink, 2.dp.toPx(), StrokeCap.Round, alpha = 0.02f + 0.02f * i) }
    }
}

private fun Modifier.dashed(color: Color, radius: Dp, width: Dp, round: Boolean = false): Modifier = drawBehind {
    val r = if (round) minOf(size.width, size.height) / 2 else radius.toPx()
    drawRoundRect(
        color, cornerRadius = CornerRadius(r, r),
        style = Stroke(width.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))),
    )
}

// A chair: where its middle is, and which way is out from the table (degrees).
private class Seat(val x: Float, val y: Float, val out: Float)

// Where the chairs go, each facing its table: evenly all the way round a
// round one (a circle, or a long table with round ends), one a side at a
// square four, and down the long sides of the others, whichever way they are
// turned. `g` is how far a chair's middle stands off the edge. With them comes
// the room each chair has along the edge, so a crowded table's are narrower.
private fun seats(shape: String, n: Int, w: Float, h: Float, g: Float): Pair<List<Seat>, Float> {
    val out = ArrayList<Seat>()
    if (n <= 0) return out to 0f
    fun deg(x: Float, y: Float) = Math.toDegrees(atan2(y.toDouble(), x.toDouble())).toFloat()
    if (shape == "round") {
        val long = maxOf(w, h)
        val short = minOf(w, h)
        val r = short / 2
        val run = long - short // the straight stretch along each long side
        val arc = PI.toFloat() * r
        val around = 2 * run + 2 * arc
        for (i in 0 until n) {
            // Walked as a table lying on its side, clockwise from the middle of
            // its far edge. A chair alone sits at the near edge instead.
            val d = ((if (n == 1) around / 2 else 0f) + i * around / n) % around
            val px: Float; val py: Float; val nx: Float; val ny: Float
            when {
                d < run / 2 -> { px = long / 2 + d; py = 0f; nx = 0f; ny = -1f }
                d < run / 2 + arc -> { val a = -PI / 2 + (d - run / 2) / r; nx = cos(a).toFloat(); ny = sin(a).toFloat(); px = long - r + r * nx; py = r + r * ny }
                d < run / 2 + arc + run -> { px = long - r - (d - run / 2 - arc); py = short; nx = 0f; ny = 1f }
                d < run / 2 + 2 * arc + run -> { val a = PI / 2 + (d - run / 2 - arc - run) / r; nx = cos(a).toFloat(); ny = sin(a).toFloat(); px = r + r * nx; py = r + r * ny }
                else -> { px = r + (d - run / 2 - 2 * arc - run); py = 0f; nx = 0f; ny = -1f }
            }
            val x = px + nx * g
            val y = py + ny * g
            out += if (w >= h) Seat(x, y, deg(nx, ny)) else Seat(y, x, deg(ny, nx))
        }
        return out to around / n
    }
    if (n == 4 && abs(w - h) < 2f) {
        out += Seat(w / 2, -g, -90f); out += Seat(w + g, h / 2, 0f); out += Seat(w / 2, h + g, 90f); out += Seat(-g, h / 2, 180f)
        return out to minOf(w, h)
    }
    val a = (n + 1) / 2
    val b = n - a
    if (w >= h) {
        for (i in 0 until a) out += Seat(w * (i + 1) / (a + 1), -g, -90f)
        for (i in 0 until b) out += Seat(w * (i + 1) / (b + 1), h + g, 90f)
        return out to w / (a + 1)
    }
    for (i in 0 until a) out += Seat(-g, h * (i + 1) / (a + 1), 180f)
    for (i in 0 until b) out += Seat(w + g, h * (i + 1) / (b + 1), 0f)
    return out to h / (a + 1)
}

// A table as a thing on the floor: a top that catches the light, its chairs
// drawn up round its edge (filled for each guest seated), and what it is
// doing in its colour, which fades to the next when that changes. It gives
// under the finger, and the ring round the one that is picked closes in on it.
@Composable
private fun TableView(t: TableUi, w: Dp, h: Dp, k: Float, selected: Boolean, mins: Int, dim: Boolean = false, onTap: () -> Unit) {
    val round = t.table.shape == "round"
    val shape = if (round) RoundedCornerShape(50) else RoundedCornerShape(14.dp)
    val fade = tween<Color>(280)
    val bg by animateColorAsState(when (t.status) { "open" -> V.Blue; "bill" -> V.Amber; "reserved" -> V.VioletDeep; else -> V.TableFree }, fade, label = "table")
    val fg by animateColorAsState(when (t.status) { "open" -> Color.White; "bill" -> V.AmberInk; "reserved" -> V.VioletText; else -> V.Text }, fade, label = "name")
    val sub = when (t.status) { "open" -> Color.White.copy(alpha = 0.86f); "bill" -> V.AmberInk.copy(alpha = 0.8f); "reserved" -> V.VioletText; else -> V.Text2 }
    val accent = when (t.status) { "open" -> V.Blue; "bill" -> V.Amber; "reserved" -> V.VioletLine; else -> V.Hover }
    // a table with guests at it is lit from under in its own colour
    val glow = when (t.status) { "open" -> V.Blue; "bill" -> V.Amber; else -> Color.Black }
    val covers = t.order?.ticket?.covers ?: 0
    val idle = V.Hover
    val source = remember { MutableInteractionSource() }
    val press = rememberPress(source, 0.97f)
    val ring = animateFloatAsState(if (selected) 1f else 0f, spring(dampingRatio = 0.7f, stiffness = 500f), label = "ring")
    val faded = animateFloatAsState(if (dim) 0.4f else 1f, tween(180), label = "dim")
    val (chairs, room) = remember(t.table.shape, t.table.seats, w, h, k) { seats(t.table.shape, t.table.seats.coerceIn(0, 14), w.value, h.value, 7.5f * k) }
    Box(
        Modifier.size(w, h)
            .graphicsLayer { val s = press.value * (1f + 0.03f * ring.value); scaleX = s; scaleY = s; alpha = faded.value }
            .drawBehind {
                val long = minOf(22f * k, room - 4f).coerceAtLeast(8f).dp.toPx()
                val deep = (9f * k).dp.toPx()
                chairs.forEachIndexed { i, c ->
                    val at = Offset(c.x.dp.toPx(), c.y.dp.toPx())
                    rotate(c.out + 90f, at) {
                        drawRoundRect(if (i < covers || t.status == "reserved") accent else idle, Offset(at.x - long / 2, at.y - deep / 2), Size(long, deep), CornerRadius(deep / 2, deep / 2))
                    }
                }
            },
    ) {
        Column(
            Modifier.fillMaxSize()
                .drawBehind {
                    val on = ring.value.coerceIn(0f, 1f)
                    if (on > 0.01f) {
                        val grow = (4.5f + 6f * (1f - on)).dp.toPx()
                        val r = if (round) (minOf(size.width, size.height) / 2 + grow) else 14.dp.toPx() + grow
                        drawRoundRect(V.Cyan, Offset(-grow, -grow), Size(size.width + 2 * grow, size.height + 2 * grow), CornerRadius(r, r), style = Stroke(3.dp.toPx()), alpha = on)
                    }
                }
                .shadow(if (t.order != null) 18.dp else 12.dp, shape, ambientColor = glow, spotColor = glow)
                .clip(shape)
                .background(Brush.verticalGradient(listOf(lerp(bg, Color.White, if (Pos.light) 0f else 0.09f), lerp(bg, Color.Black, if (Pos.light) 0.04f else 0.10f))))
                .then(
                    when {
                        t.status == "reserved" -> Modifier.dashed(V.Violet, 14.dp, 1.5.dp, round)
                        t.status == "free" && Pos.light -> Modifier.border(1.dp, V.TableFreeLine, shape)
                        // the light along the top edge
                        else -> Modifier.border(1.dp, Brush.verticalGradient(0f to Color.White.copy(alpha = if (t.status == "free") 0.14f else 0.32f), 0.55f to Color.Transparent), shape)
                    },
                )
                .clickable(interactionSource = source, indication = null, onClick = onTap),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
        ) {
            val small = minOf(w, h)
            T(t.table.name, if (small >= 84.dp) 19.sp else if (small >= 60.dp) 17.sp else 15.sp, 800, fg, spacing = (-0.3).sp)
            if (w >= 66.dp) {
                T(
                    when (t.status) {
                        "free" -> "${t.table.seats} seat${if (t.table.seats == 1) "" else "s"}"
                        "reserved" -> t.booking?.let { HM.format(Date(it.booked_for)) } ?: ""
                        else -> Money.format(t.order?.due ?: 0)
                    },
                    12.sp, 600, sub,
                )
            }
        }
        if (t.order != null) {
            val late = mins >= 60
            Box(
                Modifier.align(Alignment.TopEnd).offset(14.dp, (-11).dp).height(23.dp).clip(RoundedCornerShape(12.dp))
                    .background(if (late) V.Red else V.OnText).border(1.5.dp, if (late) V.Red else V.Stroke2, RoundedCornerShape(12.dp)).padding(horizontal = 8.dp),
                contentAlignment = Alignment.Center,
            ) { T("${mins}m", 11.sp, 800, if (late) Color.White else V.On) }
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
        if (list.isEmpty()) item {
            Column(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, top = 64.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                VIcon(VI.Floor, 38.dp, V.Stroke2, 1.6f)
                Spacer(Modifier.height(12.dp))
                T("No orders in progress", 15.sp, 700, V.Text2)
                Spacer(Modifier.height(3.dp))
                T("Tap a free table to seat guests.", 13.sp, 500, V.Text3)
            }
        }
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

// One of the two orders that are about to be one bill.
@Composable
private fun Bill(name: String, o: OrderInfo) {
    Row(Modifier.fillMaxWidth().padding(vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(name, 15.sp, 700)
            T("${o.ticket.covers ?: 0} ${L.covers} · ${o.units} item${if (o.units == 1) "" else "s"}", 13.sp, 500, V.Text2)
        }
        T(Money.format(o.due), 15.sp, 700, V.Dim)
    }
}

// A table was tapped: seat it, see its order, or greet its booking. With an
// order in hand, it is where that order might go.
@Composable
private fun ColumnScope.Picked(t: TableUi, now: Long, vm: FloorViewModel, assigning: BookingEntity?, moving: OrderInfo?, onAssigned: () -> Unit, onOrder: () -> Unit, onPay: () -> Unit) {
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
        // an order is in hand and this is where it might go
        moving != null && o != null -> {
            val here = tableLabel(t.table.name)
            val guests = (moving.ticket.covers ?: 0) + (o.ticket.covers ?: 0)
            val units = moving.units + o.units
            Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                T("Put ${nameOf(moving)} and $here on one bill?", 17.sp, 800, lines = 2)
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Key2).padding(horizontal = 16.dp, vertical = 6.dp)) {
                    Bill(nameOf(moving), moving)
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                    Bill(here, o)
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke2))
                    Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T("Together, on $here", 15.sp, 800)
                            T("$guests ${L.covers} · $units item${if (units == 1) "" else "s"}", 13.sp, 500, V.Text2)
                        }
                        T(Money.format(moving.due + o.due), 18.sp, 800)
                    }
                }
                T("Everything on ${nameOf(moving)} goes onto $here, and ${nameOf(moving)} becomes free. It cannot be undone: to pay apart again, use Split check.", 13.sp, 500, V.Text2, lines = 5, height = 19.sp)
                VBtn("One bill, on $here", Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, size = 16.sp, weight = 800) { vm.mergeInto(moving, t) }
                VBtn("Not this table", Modifier.fillMaxWidth()) { vm.pick(null) }
            }
        }
        moving != null && t.status == "free" -> {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                T("Move ${nameOf(moving)} to ${tableLabel(t.table.name)}?", 17.sp, 800, lines = 2)
                T("Its order, its guests and its time go with it, and ${nameOf(moving)} becomes free.", 13.sp, 500, V.Text2, lines = 4, height = 19.sp)
                VBtn("Move to ${tableLabel(t.table.name)}", Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, size = 16.sp, weight = 800) { vm.moveTo(moving, t.table) }
                VBtn("Not this table", Modifier.fillMaxWidth()) { vm.pick(null) }
            }
        }
        moving != null -> {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                T("${tableLabel(t.table.name)} is held for a booking", 17.sp, 800, lines = 2)
                T("${nameOf(moving)} cannot go here while it is. Pick another table, or release this one first.", 13.sp, 500, V.Text2, lines = 4, height = 19.sp)
                VBtn("Not this table", Modifier.fillMaxWidth()) { vm.pick(null) }
            }
        }
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
                // to another table, or onto another table's bill
                VBtn("Move or merge", Modifier.fillMaxWidth(), icon = VI.Swap) { vm.startMove(o) }
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
                                Modifier.weight(1f).height(66.dp).press { vm.seat(t.table.id, n, null, onOrder) }.clip(RoundedCornerShape(12.dp)).background(V.Key),
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

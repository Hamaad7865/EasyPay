package com.restopos.feature.floor

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Uuid7
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Approvals
import com.restopos.core.data.FloorPlan
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.Stepper
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.quietTap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

// The floor plan, changed on the tablet.
//
// A restaurant that works on its own (the offline edition) has no back
// office, so its tablet does what the back office's floor plan page does:
// drag a table to place it, drag its corner to size it, tap it to change its
// number, covers or shape, add several at once, take one away, and name, add
// or remove a room. Nothing is saved until Save, which sends the room as it
// stands as one change (core/data/FloorPlan, server 0101). A drag is not a
// change: the queue the tablet keeps for the day it is connected holds one
// line a save, not one a finger's move.
//
// The plan being changed is kept by the screen's view model, not by the
// screen: going to an order and coming back finds it as it was left.

// A room as it stands on the screen. made: rooms named here that hold no
// saved table yet (a room is the name its tables share: with none it is only
// here until one is saved in it).
data class FloorEdit(
    val room: String,
    val tables: List<FloorPlan.Table> = emptyList(),
    val removed: List<String> = emptyList(),
    val dirty: Boolean = false,
    val selected: String? = null,
    val made: List<String> = emptyList(),
    val saving: Boolean = false,
)

class FloorEditing(
    private val scope: CoroutineScope,
    private val service: ServiceRepository,
    private val approvals: Approvals,
    private val floor: () -> FloorUi,
) {
    val state = MutableStateFlow<FloorEdit?>(null)

    private fun saved(room: String) = floor().tables.filter { it.table.area == room }
        .map { it.table }.map { FloorPlan.Table(it.id, it.name, it.seats, it.shape, it.x, it.y, it.w, it.h) }
    private fun busy(): Set<String> = floor().tables.filter { it.order != null }.map { it.table.id }.toSet()
    // the store's table names in the other rooms, in small letters
    private fun elsewhere(room: String) = floor().tables.filter { it.table.area != room }.map { it.table.name.trim().lowercase() }.toSet()

    fun rooms(e: FloorEdit): List<String> = (floor().zones + e.made + e.room).distinct()

    fun open(room: String?) {
        val r = room ?: floor().zones.firstOrNull() ?: "Main"
        state.value = FloorEdit(r, saved(r), made = if (r in floor().zones) emptyList() else listOf(r))
    }
    fun close() { state.value = null }

    // Another room's plan, as it was last saved. The caller has asked about changes not saved.
    fun show(room: String) { state.update { it?.copy(room = room, tables = saved(room), removed = emptyList(), dirty = false, selected = null) } }
    fun select(id: String?) { state.update { it?.copy(selected = id) } }

    fun change(id: String, how: (FloorPlan.Table) -> FloorPlan.Table) {
        state.update { e ->
            if (e == null) return@update null
            val next = e.tables.map { if (it.id == id) how(it) else it }
            if (next == e.tables) e else e.copy(tables = next, dirty = true)
        }
    }

    fun add(count: Int, seats: Int, shape: String, first: String) {
        state.update { e ->
            if (e == null) return@update null
            val taken = elsewhere(e.room) + e.tables.map { it.name.trim().lowercase() }
            val made = FloorPlan.add(e.tables, taken, count, seats, shape, first, Uuid7::next)
            e.copy(tables = e.tables + made, dirty = true, selected = made.singleOrNull()?.id)
        }
    }

    // The number the next table added here would take.
    fun nextNumber(e: FloorEdit): String = FloorPlan.nextNumber(elsewhere(e.room) + e.tables.map { it.name.trim().lowercase() })

    // A table with an order open on it stays: the order would be left without a table.
    fun hasOrder(id: String): Boolean = id in busy()

    fun remove(id: String) {
        val e = state.value ?: return
        val t = e.tables.firstOrNull { it.id == id } ?: return
        if (hasOrder(id)) { Toaster.say("${tableLabel(t.name)} has an open order. Pay it, or move it to another table, first."); return }
        val was = floor().tables.any { it.table.id == id }
        state.value = e.copy(tables = e.tables - t, removed = if (was) e.removed + id else e.removed, dirty = true, selected = null)
    }

    // A room named here. It holds nothing until a table is saved in it.
    fun addRoom(name: String): Boolean {
        val e = state.value ?: return false
        val called = name.trim().take(30)
        if (called.isEmpty()) { Toaster.say("Give the room a name."); return false }
        if (rooms(e).any { it.equals(called, ignoreCase = true) }) { Toaster.say("There is already a room of that name."); return false }
        state.value = FloorEdit(called, made = e.made + called)
        return true
    }

    fun save(approver: StaffMember? = null) {
        val e = state.value ?: return
        if (e.saving || !e.dirty) return
        val problem = FloorPlan.problem(e.tables, elsewhere(e.room), floor().tables.count { it.table.area != e.room })
        if (problem != null) { Toaster.say(problem); return }
        state.value = e.copy(saving = true)
        scope.launch {
            val out = service.saveFloor(e.room, e.tables, e.removed, approver)
            val need = out.exceptionOrNull() as? NeedsApproval
            state.update { now ->
                when {
                    now == null -> null
                    // what was dragged meanwhile is still to be saved
                    out.isSuccess -> now.copy(saving = false, removed = now.removed - e.removed.toSet(), dirty = now.tables != e.tables, made = now.made - e.room)
                    else -> now.copy(saving = false)
                }
            }
            when {
                out.isSuccess -> Toaster.say("Plan saved")
                need != null -> approvals.ask(need.permission, need.what) { save(it) }
                else -> Toaster.say(out.exceptionOrNull()?.message)
            }
        }
    }

    // Every table of the room takes the new name. A room with nothing saved in it is only renamed here.
    fun rename(to: String, approver: StaffMember? = null) {
        val e = state.value ?: return
        val called = to.trim().take(30)
        if (called.isEmpty()) { Toaster.say("Give the room a name."); return }
        if (called == e.room) return
        if (rooms(e).any { it != e.room && it.equals(called, ignoreCase = true) }) { Toaster.say("There is already a room of that name."); return }
        if (e.room !in floor().zones) { state.value = e.copy(room = called, made = e.made - e.room + called); return }
        scope.launch {
            val out = service.renameRoom(e.room, called, approver)
            val need = out.exceptionOrNull() as? NeedsApproval
            when {
                out.isSuccess -> state.update { it?.copy(room = called) }
                need != null -> approvals.ask(need.permission, need.what) { rename(to, it) }
                else -> Toaster.say(out.exceptionOrNull()?.message)
            }
        }
    }

    // The tables of the room with an order open on them: the room stays while there is one.
    fun openIn(e: FloorEdit): List<String> = floor().tables.filter { it.table.area == e.room && it.order != null }.map { it.table.name }

    fun removeRoom(approver: StaffMember? = null) {
        val e = state.value ?: return
        val left = { rooms(e).filter { it != e.room } }
        // a room with nothing saved in it is only here: it is let go
        if (e.room !in floor().zones) {
            val next = left().firstOrNull() ?: "Main"
            state.value = FloorEdit(next, saved(next), made = e.made - e.room)
            return
        }
        if (openIn(e).isNotEmpty()) { Toaster.say("${e.room} has tables with an open order. Pay them, or move them, first."); return }
        scope.launch {
            val out = service.removeRoom(e.room, approver)
            val need = out.exceptionOrNull() as? NeedsApproval
            when {
                out.isSuccess -> {
                    val next = left().firstOrNull() ?: "Main"
                    state.value = FloorEdit(next, saved(next), made = (e.made - e.room).let { m -> if (next in floor().zones || next in m) m else m + next })
                    Toaster.say("${e.room} removed")
                }
                need != null -> approvals.ask(need.permission, need.what) { removeRoom(it) }
                else -> Toaster.say(out.exceptionOrNull()?.message)
            }
        }
    }
}

// The editor: the room's plan on the left, what is picked on the right.
@Composable
fun FloorEditor(plan: FloorEditing, e: FloorEdit) {
    var adding by remember { mutableStateOf(false) }
    var naming by remember { mutableStateOf<String?>(null) } // "new" or "rename"
    var removing by remember { mutableStateOf(false) }
    // what was asked for while the plan had changes not saved: done once they are let go
    var leaving by remember { mutableStateOf<(() -> Unit)?>(null) }
    val careful = { then: () -> Unit -> if (e.dirty) leaving = then else then() }
    val picked = e.tables.firstOrNull { it.id == e.selected }
    val rooms = plan.rooms(e)

    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxHeight().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                IconKey(VI.Back, tint = V.Text, width = 2.2f) { careful { plan.close() } }
                Row(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
                    Seg(rooms.map { r -> SegOption(r, r == e.room) { if (r != e.room) careful { plan.show(r) } } })
                }
                VBtn("Room", height = 46.dp, radius = 12.dp, size = 14.sp, icon = VI.Plus, pad = 12.dp) { careful { naming = "new" } }
                VBtn("Add table", height = 46.dp, radius = 12.dp, size = 14.sp, icon = VI.Plus, pad = 12.dp) { adding = true }
                VBtn(
                    if (e.saving) "Saving…" else if (e.dirty) "Save plan" else "Saved",
                    bg = if (e.dirty) V.Blue else V.Key, fg = if (e.dirty) Color.White else V.Text3,
                    height = 46.dp, radius = 12.dp, size = 14.sp, weight = 800, enabled = e.dirty && !e.saving, pad = 14.dp,
                ) { plan.save() }
            }
            // The whole 100 by 60 plan, at one size for as long as it is open: a
            // table dragged to the edge does not make the others shrink.
            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                val margin = 26.dp
                val unit = minOf((maxWidth - margin * 2) / FloorPlan.W, (maxHeight - margin * 2) / FloorPlan.H)
                val pw = unit * FloorPlan.W
                val ph = unit * FloorPlan.H
                val ox = (maxWidth - pw) / 2
                val oy = (maxHeight - ph) / 2
                val line = V.Stroke
                Box(Modifier.fillMaxSize().quietTap { plan.select(null) }) {
                    Box(
                        Modifier.offset(ox, oy).size(pw, ph).clip(RoundedCornerShape(14.dp)).background(V.Well).border(1.dp, V.Stroke, RoundedCornerShape(14.dp))
                            .drawBehind {
                                // a line every five units: where a table snaps is every one
                                val step = size.width / FloorPlan.W * 5f
                                var x = step
                                while (x < size.width - 1f) { drawRect(line.copy(alpha = 0.5f), Offset(x, 0f), Size(1f, size.height)); x += step }
                                var y = step
                                while (y < size.height - 1f) { drawRect(line.copy(alpha = 0.5f), Offset(0f, y), Size(size.width, 1f)); y += step }
                            },
                    )
                    if (e.tables.isEmpty()) {
                        T("No tables in ${e.room} yet. Tap Add table, then drag them into place.", 15.sp, 600, V.Text2, Modifier.align(Alignment.Center).padding(40.dp), lines = 3, align = TextAlign.Center)
                    }
                    e.tables.forEach { t ->
                        key(t.id) {
                            PlanTable(t, unit, ox, oy, t.id == e.selected, plan.hasOrder(t.id), onPick = { plan.select(t.id) }) { x, y -> plan.change(t.id) { FloorPlan.moved(it, x, y) } }
                        }
                    }
                    // the corner of the picked table: drag it to make the table bigger or smaller
                    picked?.let { t -> key("corner-" + t.id) { Corner(t, unit, ox, oy) { w, h -> plan.change(t.id) { FloorPlan.sized(it, w, h) } } } }
                }
            }
        }
        Column(Modifier.width(320.dp).fillMaxHeight().background(V.Panel).drawBehind { drawRect(V.Stroke, size = Size(1.dp.toPx(), size.height)) }) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(e.room, 20.sp, 800, spacing = (-0.3).sp)
                    val covers = e.tables.sumOf { it.seats }
                    T("${e.tables.size} ${if (e.tables.size == 1) "table" else "tables"} · $covers covers", 13.sp, 600, V.Text2)
                }
                if (picked == null) {
                    T("Drag a table to place it. Drag its corner to make it bigger or smaller. Tap a table to change its number, covers or shape.", 14.sp, 500, V.Text2, lines = 6, height = 20.sp)
                    T("Nothing changes for the till until Save plan.", 13.sp, 500, V.Text3, lines = 2)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        VBtn("Rename room", Modifier.weight(1f), height = 48.dp, radius = 12.dp, size = 14.sp, pad = 8.dp) { careful { naming = "rename" } }
                        VBtn("Remove room", Modifier.weight(1f), V.RedWash, V.RedText, 48.dp, radius = 12.dp, size = 14.sp, pad = 8.dp) { careful { removing = true } }
                    }
                } else {
                    // Each name close to its control, so that Remove table is in sight on a low screen.
                    if (plan.hasOrder(picked.id)) T("This table has an open order.", 13.sp, 700, V.AmberText)
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Caps("Table number")
                        Field(picked.name, { v -> plan.change(picked.id) { it.copy(name = v.take(30)) } }, "1", Modifier.fillMaxWidth())
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Caps("Covers")
                        Stepper(picked.seats.toString(), key = 44.dp, width = 64.dp, onDown = { plan.change(picked.id) { it.copy(seats = (it.seats - 1).coerceAtLeast(1)) } }, onUp = { plan.change(picked.id) { it.copy(seats = (it.seats + 1).coerceAtMost(99)) } })
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Caps("Shape")
                        Seg(
                            listOf(
                                SegOption("Square", picked.shape != "round") { plan.change(picked.id) { it.copy(shape = "square") } },
                                SegOption("Round", picked.shape == "round") { plan.change(picked.id) { it.copy(shape = "round") } },
                            ),
                            Modifier.fillMaxWidth(), V.Well, 40.dp, 12.dp, fill = true, size = 14.sp,
                        )
                    }
                    // for a finger that finds the corner small
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Caps("Size")
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Stepper(picked.w.toString(), "WIDE", key = 40.dp, width = 40.dp, onDown = { plan.change(picked.id) { FloorPlan.sized(it, it.w - 1, it.h) } }, onUp = { plan.change(picked.id) { FloorPlan.sized(it, it.w + 1, it.h) } })
                            Stepper(picked.h.toString(), "DEEP", key = 40.dp, width = 40.dp, onDown = { plan.change(picked.id) { FloorPlan.sized(it, it.w, it.h - 1) } }, onUp = { plan.change(picked.id) { FloorPlan.sized(it, it.w, it.h + 1) } })
                        }
                    }
                    VBtn("Remove table", Modifier.fillMaxWidth(), V.RedWash, V.RedText, 48.dp, radius = 12.dp, size = 14.sp) { plan.remove(picked.id) }
                }
            }
        }
    }

    if (adding) AddTables(plan.nextNumber(e), onClose = { adding = false }) { count, seats, shape, first -> adding = false; plan.add(count, seats, shape, first) }
    naming?.let { what ->
        RoomName(
            if (what == "new") "A new room" else "Rename ${e.room}",
            if (what == "new") "Main, Terrace, Upstairs. Its tables are added next." else "Every table of the room goes with it.",
            if (what == "new") "" else e.room, if (what == "new") "Add the room" else "Rename", onClose = { naming = null },
        ) { name ->
            if (what == "new") { if (plan.addRoom(name)) naming = null } else { naming = null; plan.rename(name) }
        }
    }
    if (removing) {
        val n = e.tables.size
        Ask(
            "Remove ${e.room}?", if (n == 0) "The room has no tables." else "Its $n ${if (n == 1) "table goes" else "tables go"} with it. This cannot be undone.",
            "Keep it", "Remove the room", onClose = { removing = false },
        ) { removing = false; plan.removeRoom() }
    }
    leaving?.let { then ->
        Ask(
            "${e.room} has changes that are not saved", "Save the plan first, or let the changes go.",
            "Keep editing", "Let them go", onClose = { leaving = null },
        ) { leaving = null; plan.show(e.room); then() }
    }
}

// One table on the plan: dragged, it moves by whole units of the plan.
@Composable
private fun PlanTable(t: FloorPlan.Table, unit: Dp, ox: Dp, oy: Dp, picked: Boolean, busy: Boolean, onPick: () -> Unit, onMove: (Int, Int) -> Unit) {
    val px = with(LocalDensity.current) { unit.toPx() }
    val now by rememberUpdatedState(t)
    val move by rememberUpdatedState(onMove)
    val pick by rememberUpdatedState(onPick)
    val shape = if (t.shape == "round") RoundedCornerShape(50) else RoundedCornerShape(10.dp)
    Box(
        Modifier.offset(ox + unit * t.x, oy + unit * t.y).size(unit * t.w, unit * t.h)
            .pointerInput(t.id, px) {
                var fromX = 0; var fromY = 0; var dx = 0f; var dy = 0f
                detectDragGestures(onDragStart = { pick(); fromX = now.x; fromY = now.y; dx = 0f; dy = 0f }) { change, by ->
                    change.consume()
                    dx += by.x; dy += by.y
                    move(fromX + (dx / px).roundToInt(), fromY + (dy / px).roundToInt())
                }
            }
            .quietTap(onPick).clip(shape).background(V.TableFree).border(if (picked) 2.dp else 1.dp, if (picked) V.Blue else V.TableFreeLine, shape),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            T(t.name.ifBlank { "?" }, 15.sp, 800)
            if (unit * t.h >= 52.dp) T("${t.seats} ${if (t.seats == 1) "seat" else "seats"}", 11.sp, 600, V.Text2)
        }
        // an order is open on it: at the top in the middle, where a round table does not cut it off
        if (busy) Box(Modifier.align(Alignment.TopCenter).padding(top = 7.dp).size(9.dp).clip(CircleShape).background(V.Amber))
    }
}

// The picked table's corner. What is seen is small; what takes the finger is not.
@Composable
private fun Corner(t: FloorPlan.Table, unit: Dp, ox: Dp, oy: Dp, onSize: (Int, Int) -> Unit) {
    val px = with(LocalDensity.current) { unit.toPx() }
    val now by rememberUpdatedState(t)
    val size by rememberUpdatedState(onSize)
    Box(
        Modifier.offset(ox + unit * (t.x + t.w) - 24.dp, oy + unit * (t.y + t.h) - 24.dp).size(48.dp)
            .pointerInput(t.id, px) {
                var fromW = 0; var fromH = 0; var dx = 0f; var dy = 0f
                detectDragGestures(onDragStart = { fromW = now.w; fromH = now.h; dx = 0f; dy = 0f }) { change, by ->
                    change.consume()
                    dx += by.x; dy += by.y
                    size(fromW + (dx / px).roundToInt(), fromH + (dy / px).roundToInt())
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(V.Blue).border(2.dp, V.Panel, CircleShape))
    }
}

// "Add table": how many, how many covers each, what shape, and the number the first one takes.
@Composable
private fun AddTables(first: String, onClose: () -> Unit, onDone: (count: Int, seats: Int, shape: String, first: String) -> Unit) {
    var count by remember { mutableIntStateOf(1) }
    var seats by remember { mutableIntStateOf(4) }
    var shape by remember { mutableStateOf("square") }
    var number by remember { mutableStateOf(first) }
    Sheet(onDismiss = onClose, width = 520.dp, top = true) {
        SheetHead("Add table", "They stand on the first free spots of the plan. Drag them into place after.", onClose)
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("How many")
                Stepper(count.toString(), key = 48.dp, width = 64.dp, onDown = { count = (count - 1).coerceAtLeast(1) }, onUp = { count = (count + 1).coerceAtMost(50) })
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Covers at each")
                Stepper(seats.toString(), key = 48.dp, width = 64.dp, onDown = { seats = (seats - 1).coerceAtLeast(1) }, onUp = { seats = (seats + 1).coerceAtMost(99) })
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Caps("Shape")
            Seg(listOf(SegOption("Square", shape == "square") { shape = "square" }, SegOption("Round", shape == "round") { shape = "round" }), Modifier.fillMaxWidth(), V.Well, 44.dp, 12.dp, fill = true)
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Caps(if (count > 1) "Number of the first" else "Table number")
            Field(number, { number = it.take(30) }, "1", Modifier.fillMaxWidth())
            T(if (count > 1) "$count tables, numbered from this one upwards. Numbers already used are skipped." else "The number shown on the plan and on the bill.", 13.sp, 500, V.Text3, lines = 2)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Cancel", Modifier.weight(1f), height = 58.dp, onClick = onClose)
            VBtn(if (count > 1) "Add $count tables" else "Add the table", Modifier.weight(1.4f), V.Blue, Color.White, 58.dp, weight = 800) { onDone(count, seats, shape, number.ifBlank { first }) }
        }
    }
}

@Composable
private fun RoomName(title: String, sub: String, was: String, go: String, onClose: () -> Unit, onDone: (String) -> Unit) {
    var name by remember { mutableStateOf(was) }
    Sheet(onDismiss = onClose, width = 480.dp, top = true) {
        SheetHead(title, sub, onClose)
        Field(name, { name = it.take(30) }, "Room name", Modifier.fillMaxWidth()) { onDone(name) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Cancel", Modifier.weight(1f), height = 58.dp, onClick = onClose)
            VBtn(go, Modifier.weight(1.4f), V.Blue, Color.White, 58.dp, weight = 800, enabled = name.isNotBlank()) { onDone(name) }
        }
    }
}

@Composable
private fun Ask(title: String, text: String, no: String, yes: String, onClose: () -> Unit, onYes: () -> Unit) {
    Sheet(onDismiss = onClose, width = 500.dp) {
        SheetHead(title, text, onClose)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn(no, Modifier.weight(1f), height = 58.dp, onClick = onClose)
            VBtn(yes, Modifier.weight(1f), V.Red, Color.White, 58.dp, weight = 800, onClick = onYes)
        }
    }
}

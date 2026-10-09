package com.restopos.feature.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Uuid7
import com.restopos.core.data.SetupFacts
import com.restopos.core.data.TableLayout
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VI
import com.restopos.feature.auth.Problem
import com.restopos.feature.auth.QuietLink
import com.restopos.feature.auth.SetupField

// A restaurant's tables: a line a room, its name, how many tables and the
// seats at each. The tablet numbers them on from the store's last table and
// lays each room out in rows (TableLayout); the plan is drawn afterwards in
// the back office.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun TablesStep(vm: SetupViewModel, facts: SetupFacts, next: () -> Unit) {
    val tables by vm.tables.collectAsState()
    val lines by vm.lines.collectAsState()
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    val rooms = vm.rooms(tables)
    // the first line says Main until the store has a room of that name
    LaunchedEffect(rooms.any { it.first.equals("Main", ignoreCase = true) }) {
        if (rooms.any { it.first.equals("Main", ignoreCase = true) }) {
            vm.lines.value = vm.lines.value.map { if (it.name == "Main" && it.count.isBlank()) it.copy(name = "") else it }
        }
    }
    fun change(key: String, to: (RoomLine) -> RoomLine) { vm.clear(); vm.lines.value = vm.lines.value.map { if (it.key == key) to(it) else it } }

    // nothing typed: a line that only holds the name it started with
    val typed = lines.any { it.count.isNotBlank() || it.seats.isNotBlank() || (it.name.isNotBlank() && it.name != "Main") } || lines.size > 1
    val read = TableLayout.read(lines.map { Triple(it.name, it.count, it.seats) }, rooms.map { it.first })
    // what they will be called, once the lines read
    val numbered = read.getOrNull()?.let { r ->
        TableLayout.plan(r, tables.map { it.name }).mapIndexed { i, room ->
            r[i].name + ": " + if (room.size == 1) room.first().name else "${room.first().name} to ${room.last().name}"
        }.joinToString("  ·  ")
    }

    StepBody(
        title = "How many tables?",
        sub = "A line for each room. The tablet numbers the tables and lays each room out in rows.",
        foot = {
            if (!typed && rooms.isNotEmpty()) StepFoot("Continue", ready = true, busy = false, onMain = next)
            else StepFoot(
                read.exceptionOrNull()?.message ?: "Save and continue", ready = read.isSuccess, busy = busy,
                quiet = SKIP, onQuiet = next,
            ) { vm.addRooms(next) }
        },
    ) {
        problem?.let { Problem(it) }
        if (rooms.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                rooms.forEach { (name, n) ->
                    T(
                        "$name  ·  $n ${if (n == 1) "table" else "tables"}", 14.sp, 700, V.Dim,
                        Modifier.clip(RoundedCornerShape(10.dp)).background(V.Well).padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                }
            }
            T("Add another room below, or go on.", 14.sp, 500, V.Text2)
        }
        lines.forEachIndexed { i, line ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Bottom) {
                SetupField("Room", line.name, { v -> change(line.key) { it.copy(name = v) } }, "Main, Terrace, Upstairs", Modifier.weight(1.6f), enabled = !busy, ime = ImeAction.Next)
                SetupField("Tables", line.count, { v -> change(line.key) { it.copy(count = v.filter(Char::isDigit).take(3)) } }, "12", Modifier.weight(0.8f), enabled = !busy, keyboard = KeyboardType.Number, ime = ImeAction.Next)
                SetupField("Seats at each", line.seats, { v -> change(line.key) { it.copy(seats = v.filter(Char::isDigit).take(2)) } }, "4", Modifier.weight(0.8f), enabled = !busy, keyboard = KeyboardType.Number, ime = ImeAction.Done)
                // the first line stays: there is always a room to type
                if (i > 0) IconKey(VI.Close, size = 54.dp) { vm.clear(); vm.lines.value = vm.lines.value.filterNot { it.key == line.key } }
            }
        }
        QuietLink("Add a room", enabled = !busy) { vm.lines.value = vm.lines.value + RoomLine(Uuid7.next()) }
        if (numbered != null) T("They will be numbered  $numbered", 14.sp, 600, V.BlueText, lines = 3, height = 20.sp)
        T("They can be moved, renamed and given other shapes in the back office, under Tables.", 13.sp, 500, V.Text3, lines = 2)
    }
}

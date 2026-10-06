package com.restopos.feature.staff

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.restopos.core.data.StaffMember
import com.restopos.core.ui.Pos
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

// Clock in on the left, clock out on the right. Each needs that person's PIN.
// Clocking in carries straight on: to the cash count that opens the shift, or
// to the register when the day is already open.
@Composable
fun ClockScreen(vm: StaffViewModel = hiltViewModel(), onBack: () -> Unit, onRegister: () -> Unit, onCashCount: () -> Unit) {
    val staff by vm.staff.collectAsState()
    val message by vm.message.collectAsState()
    var query by remember { mutableStateOf("") }
    var pinFor by remember { mutableStateOf<Pair<StaffMember, String>?>(null) }
    // someone who may open the day has just clocked in, and the day is not open
    var openFor by remember { mutableStateOf<StaffMember?>(null) }
    message?.let { m -> LaunchedEffect(m) { delay(3500); vm.messageShown() } }

    val all = staff.orEmpty()
    val out = all.filter { it.clockedInAt == null && it.employee.name.contains(query.trim(), ignoreCase = true) }
    val clockedIn = all.filter { it.clockedInAt != null }.sortedBy { it.clockedInAt }
    val time = remember { DateFormat.getTimeInstance(DateFormat.SHORT) }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize()) {
            StaffTopBar("Clock in/out", onBack)
            Row(Modifier.fillMaxSize().padding(horizontal = 48.dp, vertical = 28.dp), horizontalArrangement = Arrangement.spacedBy(64.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("Clock in", color = Pos.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Text("Select your name to clock in and start", Modifier.padding(top = 10.dp, bottom = 14.dp), color = Pos.Text, fontSize = 14.sp)
                    Row(
                        Modifier.fillMaxWidth().height(44.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Key).padding(horizontal = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Filled.Search, contentDescription = null, tint = Pos.NavOn)
                        BasicTextField(
                            value = query, onValueChange = { query = it }, singleLine = true,
                            modifier = Modifier.weight(1f).padding(start = 12.dp),
                            textStyle = TextStyle(color = Pos.Text, fontSize = 15.sp), cursorBrush = SolidColor(Pos.Text),
                            decorationBox = { inner -> if (query.isEmpty()) Text("Search", color = Pos.Text3, fontSize = 15.sp); inner() },
                        )
                    }
                    Text("Not clocked in", Modifier.padding(top = 22.dp, bottom = 10.dp), color = Pos.Text3, fontSize = 13.sp)
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(out, key = { it.employee.id }) { m ->
                            StaffRow(m, note = if (m.hasPin) null else "No PIN yet. Set one in the back office, under Staff.", enabled = m.hasPin) {
                                pinFor = m to "in"
                            }
                        }
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text("Clock out", color = Pos.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                    Text("Select a name to clock out", Modifier.padding(top = 10.dp, bottom = 14.dp), color = Pos.Text, fontSize = 14.sp)
                    if (clockedIn.isEmpty()) Text("No one is clocked in.", color = Pos.Text3, fontSize = 13.sp)
                    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(clockedIn, key = { it.employee.id }) { m ->
                            StaffRow(m, note = "Since ${time.format(Date(m.clockedInAt ?: 0))}", enabled = true) { pinFor = m to "out" }
                        }
                    }
                }
            }
        }
        message?.let { m ->
            Text(
                m,
                Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp))
                    .background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    pinFor?.let { (member, kind) ->
        PinPad(
            member,
            check = { vm.checkPin(member, it) },
            onOk = { pinFor = null; if (kind == "in") vm.clockIn(member, onRegister) { openFor = member } else vm.clock(member, kind) },
            onDismiss = { pinFor = null },
        )
    }

    // Clocking in does not open the day: that is asked for, by name.
    openFor?.let { member ->
        AlertDialog(
            onDismissRequest = { openFor = null },
            title = { Text("${member.employee.name} is clocked in") },
            text = { Text("The day is not open on this till yet. Opening it counts the cash in the drawer; the till sells from then on.") },
            confirmButton = { Button(onClick = { openFor = null; vm.signIn(member, onCashCount) }) { Text("Open the day") } },
            dismissButton = { OutlinedButton(onClick = { openFor = null }) { Text("Not now") } },
        )
    }
}

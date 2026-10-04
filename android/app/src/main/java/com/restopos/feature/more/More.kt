package com.restopos.feature.more

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.CashOps
import com.restopos.core.data.OrderOps
import com.restopos.core.data.StaffSession
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.Printing
import com.restopos.core.print.ShiftDoc
import com.restopos.core.print.ZDoc
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Pos
import com.restopos.feature.staff.AmountPad
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import javax.inject.Inject

// The More menu: the cash drawer, cash in and out, the shift and the day
// closing, refunds, and locking the till. Also the choice of order type when
// a new order starts, and the printers' test print for Settings.
@HiltViewModel
class MoreViewModel @Inject constructor(
    private val cash: CashOps,
    private val orders: OrderOps,
    private val staff: StaffSession,
    private val db: TillDatabase,
    private val session: SessionStore,
    printing: Printing,
) : ViewModel() {
    // what a printer said when it could not print something in the background
    val problems: SharedFlow<String> = printing.problems

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun messageShown() { _message.value = null }

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    private val _shift = MutableStateFlow<Pair<ShiftEntity, ShiftDoc>?>(null)
    val shift: StateFlow<Pair<ShiftEntity, ShiftDoc>?> = _shift

    private val _day = MutableStateFlow<ZDoc?>(null)
    val day: StateFlow<ZDoc?> = _day

    private val _types = MutableStateFlow<List<DiningOptionEntity>>(emptyList())
    val types: StateFlow<List<DiningOptionEntity>> = _types

    private val _printers = MutableStateFlow<List<PrinterEntity>>(emptyList())
    val printers: StateFlow<List<PrinterEntity>> = _printers

    fun can(permission: String) = staff.can(permission)

    fun load() = viewModelScope.launch {
        _types.value = db.catalog().diningOptions()
        _printers.value = session.storeId()?.let { db.ops().printers(it) } ?: emptyList()
        _shift.value = cash.lastShift()?.let { it to cash.shiftDoc(it) }
        _day.value = runCatching { cash.dayDoc() }.getOrNull()
    }

    private fun run(block: suspend () -> String?) = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        _message.value = runCatching { block() }.getOrElse { it.message ?: "That did not work" }
        _busy.value = false
        load()
    }

    fun openDrawer() = run { cash.openDrawer().fold({ null }, { it.message }) }

    fun cashMove(type: String, amount: Long, reason: String, done: () -> Unit) = run {
        cash.move(type, amount, reason).fold(
            { note -> done(); note ?: (if (type == "in") "Cash in recorded." else "Cash out recorded.") },
            { it.message },
        )
    }

    fun printShift() = run {
        val s = _shift.value?.first ?: return@run "No shift has been opened on this till yet"
        cash.printShift(s).fold({ "Shift report sent to the printer." }, { it.message })
    }

    fun closeDay(done: () -> Unit) = run {
        cash.closeDay().fold(
            { (z, problem) -> done(); problem ?: "Day closing no. ${z.number} is done and printed." },
            { it.message },
        )
    }

    fun testPrint(id: String) = run { orders.test(id).fold({ "Test print sent." }, { it.message }) }
}

private val stamp: DateFormat get() = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)

@Composable
private fun Tile(label: String, hint: String, modifier: Modifier, enabled: Boolean = true, color: Color = Pos.Key, onClick: () -> Unit) {
    Column(
        modifier.height(84.dp).clip(RoundedCornerShape(6.dp)).background(color).clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(label, color = if (enabled) Pos.Text else Pos.Text3, fontSize = 16.sp, fontWeight = FontWeight.Medium)
        Text(hint, color = Pos.Text3, fontSize = 12.sp, maxLines = 2)
    }
}

@Composable
private fun Figure(label: String, value: String, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(label, Modifier.weight(1f), color = if (bold) Pos.Text else Pos.Text2, fontSize = 14.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal)
        Text(value, color = Pos.Text, fontSize = 14.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium)
    }
}

// The dialogs behind the side menu's cash and closing entries: "in" and
// "out" (cash in, cash out), "shift" and "day". Null shows nothing.
@Composable
fun MoreSheets(vm: MoreViewModel, show: String?, onDismiss: () -> Unit, onCloseShift: () -> Unit) {
    val shift by vm.shift.collectAsState()
    val day by vm.day.collectAsState()
    val busy by vm.busy.collectAsState()
    LaunchedEffect(show) { if (show != null) vm.load() }
    val cashType = show?.takeIf { it == "in" || it == "out" }
    val showShift = show == "shift"
    val showDay = show == "day"

    cashType?.let { type ->
        CashDialog(type, busy, onDismiss = onDismiss) { amount, reason -> vm.cashMove(type, amount, reason) { onDismiss() } }
    }
    if (showShift) {
        val s = shift
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("Shift") },
            text = {
                if (s == null) Text("No shift has been opened on this till yet.")
                else if (!vm.can("shift.view_report")) Text("The shift's figures are for someone allowed to see reports. You can still count the drawer and close the shift.")
                else Column(Modifier.verticalScroll(rememberScrollState())) {
                    val (row, d) = s
                    Text(
                        "${d.openedBy ?: "This till"}, since ${stamp.format(Date(d.openedAt))}" + (d.closedAt?.let { ", closed ${stamp.format(Date(it))}" } ?: ""),
                        Modifier.padding(bottom = 8.dp), color = Pos.Text2, fontSize = 13.sp,
                    )
                    Figure("Receipts", d.sales.toString())
                    Figure("Sales", Money.format(d.gross))
                    if (d.refunds > 0) Figure("Refunds (${d.refunds})", Money.format(-d.refunded))
                    d.payments.forEach { Figure("${it.name} (${it.count})", Money.format(it.amount)) }
                    Spacer(Modifier.height(8.dp))
                    Figure("Opening float", Money.format(d.float))
                    Figure("Cash taken", Money.format(d.cashTaken))
                    Figure("Cash in", Money.format(d.cashIn))
                    Figure("Cash out", Money.format(-d.cashOut))
                    Figure("Expected in the drawer", Money.format(d.expected), bold = true)
                    d.counted?.let {
                        Figure("Counted", Money.format(it))
                        Figure("Difference", Money.format(it - d.expected), bold = true)
                    }
                    if (row.closed_at != null) Text("This shift is closed. The next one opens when someone signs in.", Modifier.padding(top = 8.dp), color = Pos.Text3, fontSize = 12.sp)
                }
            },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { vm.printShift() }, enabled = s != null && !busy && vm.can("shift.view_report")) { Text("Print report") }
                    if (s != null && s.first.closed_at == null) {
                        Button(onClick = { onDismiss(); onCloseShift() }, enabled = vm.can("shift.open_close")) { Text("Close shift") }
                    }
                }
            },
            dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Close") } },
        )
    }
    if (showDay) {
        val z = day
        val open = shift?.first?.closed_at == null && shift != null
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text("Day closing") },
            text = {
                if (z == null) Text("Nothing to close yet.")
                else Column(Modifier.verticalScroll(rememberScrollState())) {
                    Text(
                        "Since ${z.from?.let { stamp.format(Date(it)) } ?: "the first sale"}. This will be closing no. ${z.number}.",
                        Modifier.padding(bottom = 8.dp), color = Pos.Text2, fontSize = 13.sp,
                    )
                    if (vm.can("shift.view_report")) {
                        Figure("Receipts", z.sales.toString())
                        Figure("Sales", Money.format(z.gross))
                        Figure("Refunds (${z.refunds})", Money.format(-z.refunded))
                        Figure("Total", Money.format(z.gross - z.refunded), bold = true)
                        z.payments.forEach { Figure("${it.name} (${it.count})", Money.format(it.amount)) }
                        Figure("Cash in", Money.format(z.cashIn))
                        Figure("Cash out", Money.format(-z.cashOut))
                    }
                    Text(
                        if (open) "Close the shift first: the drawer has to be counted before the day is closed."
                        else "Closing the day fixes these figures, prints the report and starts a new day. It cannot be undone.",
                        Modifier.padding(top = 10.dp), color = if (open) Pos.Warn else Pos.Text3, fontSize = 13.sp,
                    )
                }
            },
            confirmButton = {
                Button(onClick = { vm.closeDay { onDismiss() } }, enabled = z != null && !open && !busy && vm.can("shift.open_close")) { Text("Close the day and print") }
            },
            dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Close") } },
        )
    }
}

// Cash in or cash out: the amount and what it is for. Saving records it and
// prints the slip that goes in the drawer.
@Composable
private fun CashDialog(type: String, busy: Boolean, onDismiss: () -> Unit, onSave: (Long, String) -> Unit) {
    var typed by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (type == "in") "Cash in" else "Cash out") },
        text = {
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(Modifier.weight(1f)) {
                    Text("Amount", color = Pos.Text2, fontSize = 13.sp)
                    Text("Rs ${typed.ifEmpty { "0" }}", Modifier.fillMaxWidth().padding(vertical = 6.dp), color = Pos.Text, fontSize = 28.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End)
                    OutlinedTextField(reason, { reason = it.take(80); problem = null }, Modifier.fillMaxWidth(), label = { Text("Reason") }, singleLine = true)
                    problem?.let { Text(it, Modifier.padding(top = 8.dp), color = Pos.Pink, fontSize = 13.sp) }
                    Text("A slip prints with the time, your name, the reason and the amount. It shows on the shift and day closing reports.", Modifier.padding(top = 10.dp), color = Pos.Text3, fontSize = 12.sp)
                }
                AmountPad(typed, 44.dp, Modifier.width(210.dp)) { typed = it; problem = null }
            }
        },
        confirmButton = {
            Button(enabled = !busy, onClick = {
                val cents = Money.parseRs(typed)
                when {
                    cents == null || cents <= 0 -> problem = "Type the amount"
                    reason.isBlank() -> problem = "Say what it is for"
                    else -> onSave(cents, reason)
                }
            }) { Text("Save") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// Asked when a new order starts: Dine in, Take away, or whatever order types
// the back office has.
@Composable
fun OrderTypeDialog(types: List<DiningOptionEntity>, onDismiss: () -> Unit, onPick: (DiningOptionEntity) -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New order") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                types.chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { t ->
                            Tile(t.name, if (t.needs_table) "Pick a table next." else "Straight to the order.", Modifier.weight(1f), color = Pos.TabOn) { onPick(t) }
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// For Settings: the printers this till knows, each with a test print.
@Composable
fun PrinterList(vm: MoreViewModel) {
    val printers by vm.printers.collectAsState()
    val busy by vm.busy.collectAsState()
    LaunchedEffect(Unit) { vm.load() }
    if (printers.isEmpty()) {
        Text("No printer is set up. Add them in the back office, under Printers; they arrive here with the next sync.", color = Pos.Text, fontSize = 14.sp)
    }
    printers.forEach { p ->
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(p.name + if (p.is_receipt) "  (receipts)" else "", color = Pos.Text, fontSize = 15.sp)
                Text("${if (p.kind == "usb") "USB" else p.address ?: "no address"} · ${p.paper_mm} mm", color = Pos.Text3, fontSize = 12.sp)
            }
            OutlinedButton(onClick = { vm.testPrint(p.id) }, enabled = !busy) { Text("Test print") }
        }
    }
}

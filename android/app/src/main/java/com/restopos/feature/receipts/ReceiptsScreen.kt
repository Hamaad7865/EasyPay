package com.restopos.feature.receipts

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.DocBuilder
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.OrderOps
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffSession
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.database.ReceiptPaymentEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.ReceiptDoc
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Hairline
import com.restopos.core.ui.HeadCell
import com.restopos.core.ui.Pos
import com.restopos.core.ui.Tag
import com.restopos.core.ui.card
import androidx.compose.ui.text.style.TextAlign
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import javax.inject.Inject

// A receipt opened from the list: what it printed, how it was paid, and
// whether it was refunded.
data class ReceiptDetail(
    val receipt: ReceiptEntity,
    val doc: ReceiptDoc?,
    val payments: List<ReceiptPaymentEntity>,
    val refunded: Boolean,
)

@HiltViewModel
class ReceiptsViewModel @Inject constructor(
    private val tickets: TicketRepository,
    private val session: SessionStore,
    private val orders: OrderOps,
    private val docs: DocBuilder,
    private val db: TillDatabase,
    private val staff: StaffSession,
    private val approvals: Approvals,
) : ViewModel() {
    private val _rows = MutableStateFlow<List<ReceiptEntity>>(emptyList())
    val rows: StateFlow<List<ReceiptEntity>> = _rows

    private val _open = MutableStateFlow<ReceiptDetail?>(null)
    val open: StateFlow<ReceiptDetail?> = _open

    private val _types = MutableStateFlow<List<PaymentTypeEntity>>(emptyList())
    val types: StateFlow<List<PaymentTypeEntity>> = _types

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun messageShown() { _message.value = null }

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    init {
        viewModelScope.launch {
            val store = session.storeId() ?: return@launch
            tickets.receipts(store).collect { _rows.value = it }
        }
        viewModelScope.launch { _types.value = db.ops().allPaymentTypes().filter { it.is_active }.sortedBy { it.sort_order } }
    }

    fun can(permission: String) = staff.can(permission)

    fun show(r: ReceiptEntity?) = viewModelScope.launch {
        _open.value = r?.let {
            val row = db.ops().receipt(it.id) ?: it
            ReceiptDetail(row, docs.decode(row.doc), db.receipts().payments(row.id), row.type == "sale" && db.ops().refundedOf(row.id) > 0)
        }
    }

    fun showId(id: String) = viewModelScope.launch { db.ops().receipt(id)?.let { show(it) } }

    // Runs something that may need someone else's go-ahead. If it does, asks
    // for it and runs the same thing again with whoever approved.
    private fun run(done: String, by: StaffMember? = null, block: suspend (StaffMember?) -> Result<*>): Job = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        val out = block(by)
        _busy.value = false
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) approvals.ask(need.permission, need.what) { approver -> run(done, approver, block) }
        else _message.value = out.fold({ done }, { it.message ?: "That did not work" })
        _open.value?.let { show(it.receipt) }
    }

    fun reprint(id: String) = run("Sent to the printer.") { by -> orders.reprint(id, by) }
    fun refund(id: String, reason: String, type: String) = run("Refunded. The refund is in the list.") { by -> orders.refund(id, reason, type, by) }
    fun correct(id: String, from: String, to: String) = run("Payment type corrected.") { by -> orders.correctPayment(id, from, to, by) }
}

// Receipts issued on this tablet. Tap one to see it, print it again, refund
// it, or correct how it was paid.
@Composable
fun ReceiptsScreen(vm: ReceiptsViewModel = hiltViewModel()) {
    val rows by vm.rows.collectAsState()
    val open by vm.open.collectAsState()
    val types by vm.types.collectAsState()
    val message by vm.message.collectAsState()
    val busy by vm.busy.collectAsState()
    val time = remember { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT) }
    message?.let { m -> LaunchedEffect(m) { delay(4000); vm.messageShown() } }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize().padding(start = 14.dp, end = 14.dp, top = 2.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f, fill = false).fillMaxWidth().card()) {
                Row(Modifier.fillMaxWidth().background(Pos.PanelDeep).padding(horizontal = 12.dp)) {
                    HeadCell("Number", 1.6f)
                    HeadCell("Type", 0.8f)
                    HeadCell("Time", 1.3f)
                    HeadCell("Total", 1f, end = true)
                    HeadCell("", 0.4f)
                }
                Hairline()
                if (rows.isEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(vertical = 44.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("No receipts yet", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        Text("A receipt shows here as soon as an order is paid.", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp)
                    }
                }
                LazyColumn {
                    items(rows, key = { it.id }) { r ->
                        Row(
                            Modifier.fillMaxWidth().clickable { vm.show(r) }.padding(horizontal = 12.dp).height(56.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(r.number, Modifier.weight(1.6f).padding(horizontal = 8.dp), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Box(Modifier.weight(0.8f).padding(horizontal = 8.dp)) {
                                Tag(if (r.type == "refund") "Refund" else "Sale", if (r.type == "refund") Pos.Pink else Pos.Ok)
                            }
                            Text(time.format(Date(r.device_time)), Modifier.weight(1.3f).padding(horizontal = 8.dp), color = Pos.Text, fontSize = 15.sp)
                            Text(
                                (if (r.type == "refund") "-" else "") + Money.format(r.total), Modifier.weight(1f).padding(horizontal = 8.dp),
                                color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End,
                            )
                            Text("›", Modifier.weight(0.4f).padding(horizontal = 8.dp), color = Pos.Text3, fontSize = 20.sp, textAlign = TextAlign.End)
                        }
                        Hairline(Modifier.padding(horizontal = 20.dp))
                    }
                }
            }
            Text("Receipts issued on this tablet, newest first. Tap one to print it again, refund it or correct how it was paid.", Modifier.padding(horizontal = 6.dp), color = Pos.Text3, fontSize = 12.sp)
        }
        message?.let {
            Text(
                it, Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp)).background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    open?.let { d -> Detail(d, types, busy, vm, time) }
}

// A receipt's details over whatever screen asked for them (Settings, Payments).
@Composable
fun ReceiptDialog(vm: ReceiptsViewModel) {
    val open by vm.open.collectAsState()
    val types by vm.types.collectAsState()
    val busy by vm.busy.collectAsState()
    val time = remember { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT) }
    open?.let { d -> Detail(d, types, busy, vm, time) }
}

@Composable
private fun Detail(d: ReceiptDetail, types: List<PaymentTypeEntity>, busy: Boolean, vm: ReceiptsViewModel, time: DateFormat) {
    val r = d.receipt
    val names = types.associateBy { it.id }
    var refunding by remember { mutableStateOf(false) }
    var correcting by remember { mutableStateOf<String?>(null) } // the payment type being changed
    AlertDialog(
        onDismissRequest = { vm.show(null) },
        title = { Text((if (r.type == "refund") "Refund " else "Receipt ") + r.number) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    time.format(Date(r.device_time)) + (d.doc?.order?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: "") + (d.doc?.cashier?.let { " · $it" } ?: ""),
                    Modifier.padding(bottom = 10.dp), color = Pos.Text2, fontSize = 13.sp,
                )
                d.doc?.lines?.forEach { l ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                        Text("${l.qty / 1000} ${l.name}" + if (l.mods.isEmpty()) "" else "  + " + l.mods.joinToString(", "), Modifier.weight(1f), color = Pos.Text, fontSize = 14.sp)
                        Text(Money.format(l.amount), color = Pos.Text, fontSize = 14.sp)
                    }
                }
                d.doc?.discounts?.forEach {
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                        Text("Discount: ${it.name}", Modifier.weight(1f), color = Pos.Text2, fontSize = 14.sp)
                        Text("-" + Money.format(it.amount), color = Pos.Text2, fontSize = 14.sp)
                    }
                }
                Row(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 8.dp)) {
                    Text("Total", Modifier.weight(1f), color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    Text(Money.format(r.total), color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
                d.payments.groupBy { it.payment_type_id }.forEach { (type, list) ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Paid by ${names[type]?.name ?: "another type"}", Modifier.weight(1f), color = Pos.Text2, fontSize = 14.sp)
                        Text(Money.format(list.sumOf { it.amount }), color = Pos.Text2, fontSize = 14.sp)
                        if (r.type == "sale") {
                            Text("Change", Modifier.clickable { correcting = type }.padding(start = 12.dp, top = 6.dp, bottom = 6.dp), color = Pos.Link, fontSize = 14.sp)
                        }
                    }
                }
                if (d.refunded) Text("This receipt was refunded.", Modifier.padding(top = 8.dp), color = Pos.Warn, fontSize = 13.sp)
                if (r.needs_review) Text("Flagged for a check in the back office.", Modifier.padding(top = 8.dp), color = Pos.Pink, fontSize = 13.sp)
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (r.type == "sale" && !d.refunded) {
                    OutlinedButton(onClick = { refunding = true }, enabled = !busy) { Text("Refund", color = Pos.Pink) }
                }
                Button(onClick = { vm.reprint(r.id) }, enabled = !busy) { Text("Print again") }
            }
        },
        dismissButton = { OutlinedButton(onClick = { vm.show(null) }) { Text("Close") } },
    )

    if (refunding) {
        var reason by remember { mutableStateOf("") }
        var type by remember { mutableStateOf(d.payments.firstOrNull()?.payment_type_id ?: types.firstOrNull()?.id) }
        AlertDialog(
            onDismissRequest = { refunding = false },
            title = { Text("Refund ${Money.format(r.total)}") },
            text = {
                Column {
                    Text("The whole receipt is refunded. Pick how the money goes back.", Modifier.padding(bottom = 10.dp), color = Pos.Text2, fontSize = 13.sp)
                    TypeGrid(types, type) { type = it }
                    OutlinedTextField(reason, { reason = it.take(120) }, Modifier.fillMaxWidth().padding(top = 10.dp), label = { Text("Reason") }, singleLine = true)
                }
            },
            confirmButton = {
                Button(enabled = !busy && reason.isNotBlank() && type != null, onClick = { refunding = false; vm.refund(r.id, reason, type!!) }) { Text("Refund") }
            },
            dismissButton = { OutlinedButton(onClick = { refunding = false }) { Text("Cancel") } },
        )
    }
    correcting?.let { from ->
        AlertDialog(
            onDismissRequest = { correcting = null },
            title = { Text("How was it really paid?") },
            text = {
                Column {
                    Text("It was rung up as ${names[from]?.name ?: "another type"}. The amount does not change; who corrected it and when is kept.", Modifier.padding(bottom = 10.dp), color = Pos.Text2, fontSize = 13.sp)
                    TypeGrid(types.filter { it.id != from }, null) { to -> correcting = null; vm.correct(r.id, from, to) }
                }
            },
            confirmButton = {},
            dismissButton = { OutlinedButton(onClick = { correcting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun TypeGrid(types: List<PaymentTypeEntity>, selected: String?, onPick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        types.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                row.forEach { t ->
                    Box(
                        Modifier.weight(1f).height(44.dp).clip(RoundedCornerShape(4.dp)).background(if (t.id == selected) Pos.TabOn else Pos.Key).clickable { onPick(t.id) },
                        contentAlignment = Alignment.Center,
                    ) { Text(t.name, color = Color.White, fontSize = 13.sp, maxLines = 1) }
                }
                repeat(3 - row.size) { Box(Modifier.weight(1f)) }
            }
        }
    }
}

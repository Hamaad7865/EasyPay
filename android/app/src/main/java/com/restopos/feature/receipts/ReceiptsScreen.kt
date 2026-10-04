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
import com.restopos.core.data.DocBuilder
import com.restopos.core.data.OrderOps
import com.restopos.core.data.StaffSession
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.database.ReceiptPaymentEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.ReceiptDoc
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Pos
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
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

    private fun run(done: String, block: suspend () -> Result<*>) = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        _message.value = block().fold({ done }, { it.message ?: "That did not work" })
        _busy.value = false
        _open.value?.let { show(it.receipt) }
    }

    fun reprint(id: String) = run("Sent to the printer.") { orders.reprint(id) }
    fun refund(id: String, reason: String, type: String) = run("Refunded. The refund is in the list.") { orders.refund(id, reason, type) }
    fun correct(id: String, from: String, to: String) = run("Payment type corrected.") { orders.correctPayment(id, from, to) }
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
        Column(Modifier.fillMaxSize().padding(start = 6.dp, end = 6.dp, bottom = 6.dp)) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(6.dp)).background(Pos.Panel)) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp)) {
                    listOf("Number" to 1.6f, "Type" to 0.8f, "Time" to 1.3f, "Total" to 1f).forEach { (h, w) ->
                        Text(h, Modifier.weight(w), color = Pos.Text2, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    }
                }
                if (rows.isEmpty()) Text("No receipts yet.", Modifier.padding(horizontal = 20.dp).padding(bottom = 20.dp), color = Pos.Text3, fontSize = 15.sp)
                LazyColumn {
                    items(rows, key = { it.id }) { r ->
                        Row(
                            Modifier.fillMaxWidth().clickable { vm.show(r) }.padding(horizontal = 20.dp).height(56.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(r.number, Modifier.weight(1.6f), color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                            Box(Modifier.weight(0.8f)) {
                                Text(
                                    if (r.type == "refund") "Refund" else "Sale",
                                    Modifier.clip(RoundedCornerShape(3.dp)).background(if (r.type == "refund") Pos.Danger else Pos.Key).padding(horizontal = 8.dp, vertical = 3.dp),
                                    color = Pos.Text, fontSize = 13.sp,
                                )
                            }
                            Text(time.format(Date(r.device_time)), Modifier.weight(1.3f), color = Pos.Text, fontSize = 15.sp)
                            Text((if (r.type == "refund") "-" else "") + Money.format(r.total), Modifier.weight(1f), color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
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
                        if (r.type == "sale" && vm.can("payment.correct")) {
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
                    OutlinedButton(onClick = { refunding = true }, enabled = !busy && vm.can("sale.refund")) { Text("Refund", color = Pos.Pink) }
                }
                Button(onClick = { vm.reprint(r.id) }, enabled = !busy && vm.can("receipts.reprint")) { Text("Print again") }
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

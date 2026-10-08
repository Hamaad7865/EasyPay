package com.restopos.feature.receipts

import kotlinx.coroutines.flow.flatMapLatest
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.data.Approvals
import com.restopos.core.data.DocBuilder
import com.restopos.core.data.Exchanges
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
import com.restopos.core.ui.ScanKey
import com.restopos.core.ui.ScanPill
import com.restopos.core.ui.Tag
import com.restopos.core.ui.card
import androidx.compose.ui.text.style.TextAlign
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
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
    val refunded: Long, // how much of it has been given back
    // what can still be given back, line by line; null when it can only be refunded whole
    val lines: List<com.restopos.core.data.RefundLine>?,
    // the paper itself, line by line, as it prints today (it says so when the sale was refunded since)
    val look: List<String> = emptyList(),
) {
    val canRefund: Boolean get() = receipt.type == "sale" && (lines?.any { it.left > 0 } ?: (refunded == 0L))
}

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@HiltViewModel
class ReceiptsViewModel @Inject constructor(
    private val tickets: TicketRepository,
    private val session: SessionStore,
    private val orders: OrderOps,
    private val docs: DocBuilder,
    private val db: TillDatabase,
    private val staff: StaffSession,
    private val approvals: Approvals,
    private val exchanges: Exchanges,
) : ViewModel() {
    private val _rows = MutableStateFlow<List<ReceiptEntity>>(emptyList())
    val rows: StateFlow<List<ReceiptEntity>> = _rows

    private val _open = MutableStateFlow<ReceiptDetail?>(null)
    val open: StateFlow<ReceiptDetail?> = _open

    private val _types = MutableStateFlow<List<PaymentTypeEntity>>(emptyList())
    val types: StateFlow<List<PaymentTypeEntity>> = _types

    // every payment type a receipt may name, by id: also one switched off since, and a shop's exchange type
    private val _names = MutableStateFlow<Map<String, PaymentTypeEntity>>(emptyMap())
    val names: StateFlow<Map<String, PaymentTypeEntity>> = _names

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun messageShown() { _message.value = null }

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    // what is typed to find a receipt: its number, or part of it
    val query = MutableStateFlow("")

    // a shop: a return asks whether the goods go back on the shelf
    private val _retail = MutableStateFlow(false)
    val retail: StateFlow<Boolean> = _retail

    init {
        viewModelScope.launch {
            val store = session.storeId() ?: return@launch
            val device = session.deviceId()
            // A shop's till lists the shop's receipts of the last 30 days, from
            // every till: a sale is found and refunded wherever it was rung up.
            // A restaurant's tablet lists its own, as before.
            kotlinx.coroutines.flow.combine(_retail, query) { shop, q -> (if (shop) null else device) to q.trim() }
                .flatMapLatest { (only, q) -> db.receipts().find(store, only, q) }
                .collect { _rows.value = it }
        }
        // the ways money goes back, or a payment is corrected to: a shop's exchange type is neither
        viewModelScope.launch {
            val all = db.ops().allPaymentTypes()
            _names.value = all.associateBy { it.id }
            _types.value = all.filter { it.is_active && it.kind != "exchange" }.sortedBy { it.sort_order }
        }
        viewModelScope.launch { db.ops().settingsFlow().collect { _retail.value = com.restopos.core.data.PosSettings.parse(it).retail } }
    }

    fun can(permission: String) = staff.can(permission)

    fun show(r: ReceiptEntity?) = viewModelScope.launch {
        _open.value = r?.let {
            val row = db.ops().receipt(it.id) ?: it
            val doc = docs.decode(row.doc) ?: orders.docOf(row)
            ReceiptDetail(
                row, doc, db.receipts().payments(row.id),
                if (row.type == "sale") db.ops().refundedOf(row.id) else 0,
                if (row.type == "sale") orders.refundable(row.id) else null,
                runCatching { docs.look(orders.marked(row, doc, reprint = false)) }.getOrDefault(emptyList()),
            )
        }
    }

    fun showId(id: String) = viewModelScope.launch { db.ops().receipt(id)?.let { show(it) } }

    // scan mode: the tablet's switch, the same one as on the sell screen
    val scanMode: StateFlow<Boolean> = session.scanMode.stateIn(viewModelScope, kotlinx.coroutines.flow.SharingStarted.Eagerly, false)
    fun setScanMode(on: Boolean) = viewModelScope.launch { session.setScanMode(on); if (on) query.value = "" }

    // A receipt's barcode was scanned: the receipt opens. Any till of the shop
    // may have issued it.
    fun scanned(code: String) = viewModelScope.launch {
        val store = session.storeId() ?: return@launch
        val r = db.receipts().byNumber(store, code.trim())
        if (r == null) {
            _message.value = "No receipt has the number $code. One older than 30 days is in the back office."
            Scanner.say(false, "No receipt · $code")
        } else {
            query.value = ""
            Scanner.say(true, "Found · ${r.number}")
            show(r)
        }
    }

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
    // picks: order line id to quantity (thousandths); null gives back everything that is left
    // restock: the goods go back on the shelf (off: they are faulty, and are written off as damaged)
    fun refund(id: String, reason: String, type: String, picks: Map<String, Int>? = null, restock: Boolean = true) =
        run(if (restock) "Refunded. The refund is in the list." else "Refunded. The goods were not put back into stock: they are written off as damaged.") { by -> orders.refund(id, reason, type, by, picks, restock) }
    suspend fun quote(id: String, picks: Map<String, Int>): Long = orders.refundQuote(id, picks)

    // An exchange: what comes back is kept (nothing is refunded yet), and the
    // cashier goes on to the Sell screen to ring up what the customer takes.
    private val _exchanging = MutableStateFlow(false)
    val exchanging: StateFlow<Boolean> = _exchanging
    fun exchangeShown() { _exchanging.value = false }
    fun exchange(id: String, reason: String, picks: Map<String, Int>?, restock: Boolean) =
        run("Exchange started. Ring up what the customer takes instead.") { by ->
            exchanges.start(id, reason, by, picks, restock).onSuccess { _open.value = null; _exchanging.value = true }
        }
    fun correct(id: String, from: String, to: String) = run("Payment type corrected.") { by -> orders.correctPayment(id, from, to, by) }
}

// Receipts issued on this tablet. Tap one to see it, print it again, refund
// it, or correct how it was paid.
// onExchange: where an exchange started here goes on (the Sell screen); none, and no exchange is offered.
@Composable
fun ReceiptsScreen(vm: ReceiptsViewModel = hiltViewModel(), onExchange: (() -> Unit)? = null) {
    val exchanging by vm.exchanging.collectAsState()
    LaunchedEffect(exchanging) { if (exchanging) { vm.exchangeShown(); onExchange?.invoke() } }
    val rows by vm.rows.collectAsState()
    val open by vm.open.collectAsState()
    val types by vm.types.collectAsState()
    val message by vm.message.collectAsState()
    val busy by vm.busy.collectAsState()
    val time = remember { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT) }
    message?.let { m -> LaunchedEffect(m) { delay(4000); vm.messageShown() } }

    val q by vm.query.collectAsState()
    val shop by vm.retail.collectAsState()
    val scan by vm.scanMode.collectAsState()
    // while this screen is open in a shop, a scanned receipt opens
    LaunchedEffect(shop) { if (shop) Scanner.codes.collect { vm.scanned(it) } }
    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize().padding(start = 14.dp, end = 14.dp, top = 2.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                // a shop: scan mode, as on the sell screen. Lit, a receipt's barcode opens the receipt and nothing is typed.
                if (shop) ScanKey(scan) { vm.setScanMode(it) }
                if (shop && scan) ScanPill(Modifier.weight(1f), idle = "Scan a receipt's barcode")
                else OutlinedTextField(
                    q, { vm.query.value = it.take(40) }, Modifier.weight(1f), singleLine = true,
                    placeholder = { Text("Find a receipt by its number, for example " + (rows.firstOrNull()?.number ?: "S1-T1-000123")) },
                )
            }
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
                        Text(if (q.isBlank()) "No receipts yet" else "No receipt has “${q.trim()}” in its number", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        Text(if (q.isBlank()) "A receipt shows here as soon as ${if (shop) "a sale" else "an order"} is paid." else "A receipt older than 30 days is in the back office, under Receipts.", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp)
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
            Text(if (shop) "This shop's receipts of the last 30 days, from every till, newest first. Tap one to print it again, refund it or correct how it was paid." else "Receipts issued on this tablet, newest first. Tap one to print it again, refund it or correct how it was paid.", Modifier.padding(horizontal = 6.dp), color = Pos.Text3, fontSize = 12.sp)
        }
        message?.let {
            Text(
                it, Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp)).background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    open?.let { d -> Detail(d, types, busy, vm, time, exchange = onExchange != null) }
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
private fun Detail(d: ReceiptDetail, types: List<PaymentTypeEntity>, busy: Boolean, vm: ReceiptsViewModel, time: DateFormat, exchange: Boolean = false) {
    val r = d.receipt
    val retail by vm.retail.collectAsState()
    val names by vm.names.collectAsState()
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
                if (d.look.isNotEmpty()) {
                    // the receipt itself, as it prints: a narrow column of even letters on white, in the middle of the box
                    Box(
                        Modifier.fillMaxWidth().padding(bottom = 10.dp).clip(RoundedCornerShape(8.dp)).background(Color.White).horizontalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 12.dp),
                        contentAlignment = Alignment.TopCenter,
                    ) {
                        Text(d.look.joinToString("\n"), color = Color(0xFF16181D), fontFamily = FontFamily.Monospace, fontSize = 12.sp, lineHeight = 16.sp, softWrap = false)
                    }
                } else {
                    d.doc?.lines?.forEach { l ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                            Text("${com.restopos.core.print.Docs.qty(l.qty)} ${l.name}" + if (l.mods.isEmpty()) "" else "  + " + l.mods.joinToString(", "), Modifier.weight(1f), color = Pos.Text, fontSize = 14.sp)
                            Text(Money.format(l.amount), color = Pos.Text, fontSize = 14.sp)
                        }
                        // a line charged something other than its listed price says what it was
                        if (l.was != null && l.was != l.amount) {
                            Text(listOfNotNull("was ${Money.format(l.was)}", l.priceNote?.takeIf { it.isNotBlank() }).joinToString(", "), Modifier.padding(start = 14.dp, bottom = 2.dp), color = Pos.Text3, fontSize = 12.sp)
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
                }
                d.payments.groupBy { it.payment_type_id }.forEach { (type, list) ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        // what an exchange settled is said as what it was: goods that came back, or went to a new sale
                        val by = names[type]
                        Text(
                            if (by?.kind == "exchange") (if (r.type == "sale") "Paid with returned goods" else "Went to the new sale") else "Paid by ${by?.name ?: "another type"}",
                            Modifier.weight(1f), color = Pos.Text2, fontSize = 14.sp,
                        )
                        Text(Money.format(list.sumOf { it.amount }), color = Pos.Text2, fontSize = 14.sp)
                        // what an exchange settled with returned goods was never money: there is nothing to correct
                        if (r.type == "sale" && names[type]?.kind != "exchange") {
                            Text("Change", Modifier.clickable { correcting = type }.padding(start = 12.dp, top = 6.dp, bottom = 6.dp), color = Pos.Link, fontSize = 14.sp)
                        }
                    }
                }
                if (d.refunded > 0 || (r.type == "sale" && !d.canRefund)) {
                    Text(
                        if (d.canRefund) "${Money.format(d.refunded)} of this receipt was refunded." else "This receipt was refunded.",
                        Modifier.padding(top = 8.dp), color = Pos.Warn, fontSize = 13.sp,
                    )
                }
                if (r.needs_review) Text("Flagged for a check in the back office.", Modifier.padding(top = 8.dp), color = Pos.Pink, fontSize = 13.sp)
            }
        },
        confirmButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (d.canRefund) {
                    OutlinedButton(onClick = { refunding = true }, enabled = !busy) { Text("Refund", color = Pos.Pink) }
                }
                Button(onClick = { vm.reprint(r.id) }, enabled = !busy) { Text("Print again") }
            }
        },
        dismissButton = { OutlinedButton(onClick = { vm.show(null) }) { Text("Close") } },
    )

    if (refunding) {
        var reason by remember { mutableStateOf("") }
        // back the way it was paid, when that is a way money can go back
        var type by remember { mutableStateOf(d.payments.map { it.payment_type_id }.firstOrNull { id -> types.any { it.id == id } } ?: types.firstOrNull()?.id) }
        // what comes back of each line: everything that is left, until the cashier takes some off
        val lines = d.lines?.filter { it.left > 0 }
        var picks by remember { mutableStateOf<Map<String, Int>>(lines?.associate { it.id to it.left } ?: emptyMap()) }
        // a shop: whether what comes back goes on the shelf again
        var restock by remember { mutableStateOf(true) }
        val everything = lines == null || lines.all { picks[it.id] == it.left }
        var amount by remember { mutableStateOf(r.total - d.refunded) }
        LaunchedEffect(picks) { if (lines != null) amount = vm.quote(r.id, picks) }
        AlertDialog(
            onDismissRequest = { refunding = false },
            title = { Text("Refund ${Money.format(amount)}") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    if (lines == null) {
                        Text("The whole receipt is refunded. Pick how the money goes back.", Modifier.padding(bottom = 10.dp), color = Pos.Text2, fontSize = 13.sp)
                    } else {
                        Text("What comes back. Take off what the ${if (retail) "customer" else "guest"} keeps.", Modifier.padding(bottom = 6.dp), color = Pos.Text2, fontSize = 13.sp)
                        lines.forEach { l ->
                            val q = picks[l.id] ?: 0
                            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(l.name, Modifier.weight(1f), color = if (q > 0) Pos.Text else Pos.Text3, fontSize = 14.sp, maxLines = 1)
                                if (l.whole) {
                                    OutlinedButton(onClick = { picks = picks + (l.id to (q - 1000).coerceAtLeast(0)) }, enabled = q > 0) { Text("−") }
                                    Text("${q / 1000} of ${l.left / 1000}", color = Pos.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                                    OutlinedButton(onClick = { picks = picks + (l.id to (q + 1000).coerceAtMost(l.left)) }, enabled = q < l.left) { Text("+") }
                                } else {
                                    // sold by weight: all of it or none of it
                                    OutlinedButton(onClick = { picks = picks + (l.id to (if (q > 0) 0 else l.left)) }) { Text(if (q > 0) "Comes back" else "Kept") }
                                }
                            }
                        }
                    }
                    if (retail) {
                        // above the money and the reason: the keyboard that opens for the reason would hide it
                        Row(Modifier.fillMaxWidth().padding(top = 10.dp).clickable { restock = !restock }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text("Put back into stock", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                                Text(
                                    if (restock) "What comes back goes on the shelf again." else "Faulty: it is not put back. It is written off as damaged, so the loss shows on the stock reports.",
                                    color = if (restock) Pos.Text2 else Pos.Warn, fontSize = 13.sp,
                                )
                            }
                            com.restopos.core.ui.Toggle(restock)
                        }
                    }
                    if (lines != null) Text("Pick how the money goes back.", Modifier.padding(top = 10.dp, bottom = 8.dp), color = Pos.Text2, fontSize = 13.sp)
                    TypeGrid(types, type) { type = it }
                    OutlinedTextField(reason, { reason = it.take(120) }, Modifier.fillMaxWidth().padding(top = 10.dp), label = { Text("Reason") }, singleLine = true)
                    if (retail && exchange) {
                        Text("Exchange: what comes back pays for what the customer takes instead. You ring that up next, and only the difference changes hands.", Modifier.padding(top = 10.dp), color = Pos.Text3, fontSize = 12.sp)
                    }
                }
            },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (retail && exchange) {
                        OutlinedButton(
                            enabled = !busy && (lines == null || picks.values.any { it > 0 }),
                            onClick = { refunding = false; vm.exchange(r.id, reason, if (lines == null) null else picks.filterValues { it > 0 }, restock) },
                        ) { Text("Exchange") }
                    }
                    Button(
                        enabled = !busy && reason.isNotBlank() && type != null && (lines == null || picks.values.any { it > 0 }),
                        onClick = { refunding = false; vm.refund(r.id, reason, type!!, if (everything) null else picks.filterValues { it > 0 }, restock) },
                    ) { Text("Refund") }
                }
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
                    ) { Text(t.name, color = if (t.id == selected) Color.White else Pos.Text, fontSize = 13.sp, maxLines = 1) }
                }
                repeat(3 - row.size) { Box(Modifier.weight(1f)) }
            }
        }
    }
}

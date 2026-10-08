package com.restopos.feature.pay

import com.restopos.core.data.PosSettings
import androidx.compose.foundation.layout.widthIn
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Calc
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.Exchanges
import com.restopos.core.data.LineInfo
import com.restopos.core.data.OrderOps
import com.restopos.core.data.PayInput
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.L
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
import com.restopos.core.ui.VIcon
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import javax.inject.Inject

// What is written down of a bill being split equally, between two guests.
@Serializable
data class KeptShare(val type: String, val paymentTypeId: String, val amount: Long, val tendered: Long? = null, val change: Long = 0, val reference: String? = null)
@Serializable
data class KeptSplit(val ticket: String, val n: Int, val shares: List<KeptShare>)

data class PayLine(val info: LineInfo, val picked: Boolean)
data class PaidRow(val label: String, val amount: Long)

// The sale that has just been paid in full, for the card that follows.
data class PayDone(
    val receiptId: String, val total: Long, val change: Long, val method: String,
    val kind: String, val table: String?, val phone: String?, val email: String?,
    // an exchange: what the shop gives back when the goods that came back were worth more, and how
    val exchange: Boolean = false, val back: Long = 0, val backBy: String? = null,
)

data class PayUi(
    val loaded: Boolean = false,
    val gone: Boolean = false, // nothing to pay here: the order was paid or cancelled elsewhere
    val title: String = "",
    val kind: String = "counter",
    val split: String = "full", // full | equal | items (one check of a split check)
    val check: Int? = null, // the check of a split check being paid
    val checkPaid: Boolean = false, // that check is paid and others remain: back to the checks
    val n: Int = 2, // how many guests share the bill equally
    val part: Int = 1,
    val lines: List<PayLine> = emptyList(),
    val total: Long = 0, // the whole order, parts already paid included
    val paid: List<PaidRow> = emptyList(), // earlier receipts, and shares taken for this one
    val remaining: Long = 0,
    val amount: Long = 0, // what this payment is for
    val tax: Long = 0,
    val methods: List<PaymentTypeEntity> = emptyList(),
    val method: PaymentTypeEntity? = null,
    val tend: String = "", // cash received, as typed, in whole rupees
    val reference: String = "",
    val pending: Long = 0, // taken in shares and not recorded yet
    // An exchange: goods of this receipt come back and pay for the sale as far
    // as they go. Then amount is what the customer still pays, and back what
    // the shop gives back when they were worth more.
    val exchangeOf: String? = null,
    val credit: Long = 0,
    val back: Long = 0,
    val busy: Boolean = false,
    val done: PayDone? = null,
) {
    val cash: Boolean get() = method?.kind == "cash"
    val tendered: Long get() = (tend.toLongOrNull() ?: 0) * 100
    val short: Boolean get() = cash && tend.isNotEmpty() && tendered < amount
    val change: Long get() = if (cash && tendered > amount) tendered - amount else 0
}

// Payment. A bill is paid three ways. In full: one payment for everything
// that is left. Split equally: the amount due is taken in equal shares, each
// with its own payment type; the shares are kept here until they add up, and
// then go out as ONE receipt with all its payments (a receipt always settles
// its lines in full), with a printed copy for each guest. Split check: the
// order is divided into checks on its own screen, and each check is paid here
// on a receipt of its own while the rest stays on the order.
@HiltViewModel
class PayViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val tickets: TicketRepository,
    private val orderOps: OrderOps,
    private val service: ServiceRepository,
    private val exchanges: Exchanges,
) : ViewModel() {
    private val _ui = MutableStateFlow(PayUi())
    val ui: StateFlow<PayUi> = _ui

    private class Share(val type: String, val input: PayInput)
    private var shares: List<Share> = emptyList()
    private var discount: DiscountPick? = null
    private var servicePct = 0
    private var calc: Map<String, Calc.Line> = emptyMap()
    private var earlier: List<PaidRow> = emptyList()
    private var earlierTotal = 0L
    private var ticketId: String? = null // the order being paid

    private val json = Json { ignoreUnknownKeys = true }

    // Leaving the screen clears what is on it, not what was written down: a
    // cashier who goes to another table between two guests finds the shares
    // again on coming back to this bill. They are only thrown away when they
    // are given back (the cashier is asked first) or recorded.
    fun reset() {
        shares = emptyList()
        _ui.value = PayUi()
    }

    fun open() = viewModelScope.launch {
        shares = emptyList()
        // the check of a split check this screen was opened for; read once
        val check = session.payCheck()
        session.setPayCheck(null)
        _ui.value = PayUi(check = check)
        val kept = if (check == null) kept() else null
        if (kept != null) shares = kept.shares.map { Share(it.type, PayInput(it.paymentTypeId, it.amount, it.tendered, it.change, it.reference)) }
        load(if (check != null) "items" else if (kept != null) "equal" else "full")
        if (kept != null) {
            val s = _ui.value
            if (s.gone || shares.sumOf { it.input.amount } >= s.pending + s.remaining) {
                // the bill is no longer bigger than what was taken: start again, and say so
                shares = emptyList()
                keep(kept.ticket, 0)
                show(s.copy(split = "full"))
                Toaster.say("${Money.format(kept.shares.sumOf { it.amount })} was taken on this bill before the till stopped. The bill has changed since: check it with the guests.")
            } else {
                show(s.copy(split = "equal", n = maxOf(kept.n, shares.size + 1)))
                Toaster.say("${Money.format(s.pending)} already taken on this bill in ${shares.size} ${if (shares.size == 1) "payment" else "payments"} · ${Money.format(_ui.value.remaining)} remaining")
            }
        }
    }

    // What is written down, one entry per order: two bills can be half paid at
    // the same time (two tables each splitting), and neither loses its shares.
    private val keptSerializer = MapSerializer(String.serializer(), KeptSplit.serializer())
    private suspend fun allKept(): Map<String, KeptSplit> =
        session.splitShares()?.let { runCatching { json.decodeFromString(keptSerializer, it) }.getOrNull() } ?: emptyMap()
    private suspend fun saveKept(all: Map<String, KeptSplit>) = session.setSplitShares(if (all.isEmpty()) null else json.encodeToString(keptSerializer, all))

    // The shares written down for the order on the register, if any. Those of
    // an order that has been closed since are thrown away.
    private suspend fun kept(): KeptSplit? {
        val all = allKept()
        val live = all.filter { (id, k) -> k.shares.isNotEmpty() && db.tickets().openTicket(id) != null }
        if (live.size != all.size) saveKept(live)
        return live[tickets.activeTicket()?.id]
    }

    // Writes down the shares taken so far on this order, or forgets them when there are none.
    private fun keep(ticketId: String?, n: Int) = viewModelScope.launch {
        val id = ticketId ?: return@launch
        val now = shares.map { KeptShare(it.type, it.input.paymentTypeId, it.input.amount, it.input.tendered, it.input.change, it.input.reference) }
        saveKept(if (now.isEmpty()) allKept() - id else allKept() + (id to KeptSplit(id, n, now)))
    }

    private fun totalsFor(ids: Collection<String>): Calc.Totals {
        val d = discount
        return Calc.totalsRounded(
            calc.filterKeys { ids.contains(it) }.values.toList(),
            listOfNotNull(d?.let { Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value) }), servicePct,
        )
    }

    private suspend fun load(split: String? = null) {
        val t = tickets.activeTicket()
        ticketId = t?.id
        if (t == null) { _ui.value = _ui.value.copy(loaded = true, gone = true); return }
        val all = service.describe(db.tickets().lines(t.id).first())
        val unpaid = all.filter { !it.line.paid }
        val taxes = HashMap<String, MutableList<Calc.TaxRate>>()
        unpaid.map { it.line.id }.chunked(800).forEach { ids -> db.service().taxesOf(ids).forEach { taxes.getOrPut(it.line_id) { ArrayList() }.add(Calc.TaxRate(it.rate_bp, it.type)) } }
        calc = unpaid.associate { it.line.id to Calc.Line(it.amount, taxes[it.line.id].orEmpty()) }
        discount = tickets.pendingDiscount()
        servicePct = service.servicePct(t)
        val types = db.ops().allPaymentTypes().associateBy { it.id }
        val before = db.service().paymentsForTicket(t.id)
        earlier = before.map { PaidRow(types[it.payment_type_id]?.name ?: "Paid", it.amount) }
        earlierTotal = db.receipts().paidForTicket(t.id)
        val table = t.table_id?.let { db.tables().table(it) }
        val type = t.dining_option_id?.let { db.ops().dining(it) }
        val kind = type?.kind ?: if (table != null) "dine" else "counter"
        val methods = db.catalog().paymentTypes().first()
        val cur = _ui.value
        // An exchange is settled on the whole sale, in one go. A sale that
        // already has payments taken on it cannot carry one.
        if (shares.isNotEmpty() && exchanges.of(t.id) != null) {
            exchanges.cancel(t.id)
            Toaster.say("Payments were already taken on this sale, so the exchange was dropped. Nothing was refunded: start it again from the receipt.")
        }
        val ex = if (cur.check == null) exchanges.of(t.id) else null
        // One check of a split check: an amount off the bill comes off the
        // first check that has something on it, which is where the split
        // screen and the printed checks show it. Paying another check first
        // does not take it.
        if (cur.check != null && discount?.type == "amount" && cur.check != unpaid.minOfOrNull { it.line.check_no }) discount = null
        val title = (if (table != null) "${tableLabel(table.name)} · ${t.covers ?: 1} ${L.covers}"
        else listOfNotNull(if (kind == "counter") (if (PosSettings.parse(db.ops().settings()).retail) "Sale" else L.quick) else type?.name, t.order_no, t.name).joinToString(" ")) + (cur.check?.let { " · Check $it" } ?: "")
        show(cur.copy(
            loaded = true, gone = unpaid.isEmpty(), title = title, kind = kind,
            split = if (ex != null) "full" else split ?: cur.split, n = if (cur.loaded) cur.n else maxOf(2, t.covers ?: 2),
            exchangeOf = ex?.number, credit = ex?.credit ?: 0,
            // one check of a split check: its lines, and only they
            lines = all.filter { cur.check == null || (it.line.check_no == cur.check && !it.line.paid) }.map { PayLine(it, cur.check != null) },
            methods = methods, method = cur.method?.let { m -> methods.firstOrNull { it.id == m.id } } ?: methods.firstOrNull(),
            tend = "", reference = "", busy = false,
        ))
    }

    // works out what this payment is for, from how the bill is being split
    private fun show(s: PayUi) {
        val unpaid = s.lines.filter { !it.info.line.paid }.map { it.info.line.id }
        val all = totalsFor(unpaid)
        val taken = shares.sumOf { it.input.amount }
        val remaining = (all.total - taken).coerceAtLeast(0)
        val amount = when (s.split) {
            "equal" -> Money.share(remaining, (s.n - shares.size).coerceAtLeast(1))
            "items" -> totalsFor(s.lines.filter { it.picked && !it.info.line.paid }.map { it.info.line.id }).total
            else -> remaining
        }
        val exchange = s.exchangeOf != null
        _ui.value = s.copy(
            total = earlierTotal + all.total, remaining = remaining, tax = all.tax,
            amount = if (exchange) (remaining - s.credit).coerceAtLeast(0) else amount,
            back = if (exchange) (s.credit - remaining).coerceAtLeast(0) else 0,
            paid = earlier + shares.map { PaidRow(it.type, it.input.amount) },
            pending = taken, part = (shares.size + 1).coerceAtMost(s.n),
        )
    }

    fun split(mode: String) {
        val s = _ui.value
        if (s.check != null || s.exchangeOf != null) return
        show(s.copy(split = mode, tend = ""))
    }

    // Split check is its own screen; it cannot be opened with shares in hand.
    fun maySplit(): Boolean {
        if (shares.isNotEmpty()) { Toaster.say("Part of this bill is already taken. Finish it first, or give it back to start again."); return false }
        return true
    }

    fun guests(by: Int) { val s = _ui.value; show(s.copy(n = (s.n + by).coerceIn(maxOf(2, shares.size + 1), 20), tend = "")) }

    fun method(m: PaymentTypeEntity) { _ui.value = _ui.value.copy(method = m, tend = "", reference = "") }
    fun reference(v: String) { _ui.value = _ui.value.copy(reference = v.take(64)) }

    fun key(k: String) {
        val t = _ui.value.tend
        val next = (if (k == "del") t.dropLast(1) else (t + k).take(7)).trimStart('0')
        _ui.value = _ui.value.copy(tend = next)
    }

    // a note that covers it: the exact amount, or the next round one up
    fun tender(cents: Long) { _ui.value = _ui.value.copy(tend = ((cents + 99) / 100).toString()) }

    // The shares taken so far are given back and the bill starts again.
    fun giveBack() { shares = emptyList(); keep(ticketId, 0); show(_ui.value.copy(tend = "")) }

    fun charge() {
        val s = _ui.value
        if (s.busy || s.done != null) return
        val unpaid = s.lines.filter { !it.info.line.paid }
        if (unpaid.isEmpty()) return
        val covered = if (s.split == "items") unpaid.filter { it.picked } else unpaid
        if (covered.isEmpty()) { Toaster.say("There is nothing on this check"); return }
        if (s.exchangeOf != null) { exchange(s, unpaid.map { it.info.line.id }); return }
        val amount = s.amount
        // a bill that comes to nothing (fully discounted) is closed with no payment
        if (amount <= 0 && shares.isEmpty()) { record(s, covered.map { it.info.line.id }, emptyList()); return }
        val m = s.method ?: run { Toaster.say("Pick how it is paid"); return }
        val input = if (m.kind == "cash") {
            val got = if (s.tend.isEmpty()) amount else s.tendered
            if (got < amount) { Toaster.say("Tendered amount is below ${Money.format(amount)}"); return }
            PayInput(m.id, amount, got, got - amount, null)
        } else {
            PayInput(m.id, amount, amount, 0, s.reference.ifBlank { null })
        }
        if (s.split == "items") { record(s, covered.map { it.info.line.id }, listOf(Share(m.name, input))); return }
        val all = shares + Share(m.name, input)
        if (amount < s.remaining) {
            // more to come: keep the share (written down, so a tablet that
            // stops here still knows of it), ask for the next
            shares = all
            keep(ticketId, s.n)
            Toaster.say("${Money.format(amount)} paid · ${Money.format(s.remaining - amount)} remaining" + if (input.change > 0) " · change ${Money.format(input.change)}" else "")
            show(s.copy(tend = "", reference = ""))
            return
        }
        record(s, covered.map { it.info.line.id }, all)
    }

    // An exchange: the goods that come back pay for the sale as far as they go.
    // The payment type picked is for the difference, whichever way it goes.
    private fun exchange(s: PayUi, covered: List<String>) {
        val m = s.method
        if ((s.amount > 0 || s.back > 0) && m == null) { Toaster.say(if (s.back > 0) "Pick how the difference is given back" else "Pick how it is paid"); return }
        val difference = if (s.amount > 0 && m != null) {
            if (m.kind == "cash") {
                val got = if (s.tend.isEmpty()) s.amount else s.tendered
                if (got < s.amount) { Toaster.say("Tendered amount is below ${Money.format(s.amount)}"); return }
                PayInput(m.id, s.amount, got, got - s.amount, null)
            } else {
                PayInput(m.id, s.amount, s.amount, 0, s.reference.ifBlank { null })
            }
        } else null
        viewModelScope.launch {
            _ui.value = s.copy(busy = true)
            val t = tickets.activeTicket()
            exchanges.complete(s.remaining, difference, m?.id?.takeIf { s.back > 0 }, listOfNotNull(discount), servicePct, covered).fold(
                onSuccess = { (refund, sale) ->
                    orderOps.afterExchange(refund, sale)
                    session.setPendingDiscount(null)
                    val customer = t?.customer_id?.let { db.customers().customer(it) }
                    _ui.value = _ui.value.copy(busy = false, done = PayDone(
                        sale.id, sale.total, difference?.change ?: 0,
                        listOfNotNull("returned goods", m?.name?.takeIf { s.amount > 0 }).joinToString(" and "),
                        s.kind, null, t?.phone ?: customer?.phone, customer?.email,
                        exchange = true, back = s.back, backBy = m?.name?.takeIf { s.back > 0 },
                    ))
                },
                onFailure = { _ui.value = s.copy(busy = false); Toaster.say(it.message) },
            )
        }
    }

    private fun record(s: PayUi, covered: List<String>, with: List<Share>) = viewModelScope.launch {
        _ui.value = s.copy(busy = true)
        val t = tickets.activeTicket()
        val payments = with.map { it.input }.filter { it.amount > 0 }
        val change = with.sumOf { it.input.change }
        tickets.pay(payments, listOfNotNull(discount), servicePct, covered).fold(
            onSuccess = { receipt ->
                shares = emptyList()
                keep(ticketId, 0)
                orderOps.afterPay(receipt, perGuest = s.split == "equal" && with.size >= 2)
                if (tickets.activeTicket() == null) {
                    session.setPendingDiscount(null)
                    // a takeaway paid when it is handed over has been collected
                    if (t?.stage == "ready") tickets.setStage(t.id, "done")
                    val customer = t?.customer_id?.let { db.customers().customer(it) }
                    _ui.value = _ui.value.copy(busy = false, done = PayDone(
                        receipt.id, earlierTotal + receipt.total, change,
                        if (with.size > 1) "${with.size} payments" else with.firstOrNull()?.type ?: "No charge",
                        s.kind, t?.table_id?.let { db.tables().table(it)?.name }, t?.phone ?: customer?.phone, customer?.email,
                    ))
                } else {
                    // an amount discount is given once, not on every guest's receipt
                    if (discount?.type == "amount") session.setPendingDiscount(null)
                    if (s.check != null) { _ui.value = _ui.value.copy(busy = false, checkPaid = true); return@fold }
                    load()
                    Toaster.say("${Money.format(receipt.total)} paid · ${Money.format(_ui.value.remaining)} remaining" + if (change > 0) " · change ${Money.format(change)}" else "")
                }
            },
            onFailure = { _ui.value = s.copy(busy = false); Toaster.say(it.message) },
        )
    }

    fun printCopy(receiptId: String) = viewModelScope.launch {
        orderOps.printCopy(receiptId).fold({ Toaster.say("Receipt sent to printer") }, { Toaster.say(it.message) })
    }

    suspend fun receiptText(receiptId: String): String? = orderOps.receiptText(receiptId)
}

// Hands the receipt to the tablet's own mail or message app. Nothing is sent
// from here: the cashier sees it leave in that app.
private fun share(context: Context, text: String, subject: String, to: String?, whatsapp: Boolean): String? {
    val intents = ArrayList<Intent>()
    if (whatsapp) {
        val digits = to?.filter { it.isDigit() }.orEmpty()
        if (digits.length >= 7) intents += Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/$digits?text=" + Uri.encode(text))).setPackage("com.whatsapp")
        intents += Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text).setPackage("com.whatsapp")
    } else {
        intents += Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + (to ?: ""))).putExtra(Intent.EXTRA_SUBJECT, subject).putExtra(Intent.EXTRA_TEXT, text)
    }
    for (i in intents) {
        if (runCatching { context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess) return null
    }
    return if (whatsapp) "WhatsApp is not on this tablet" else "There is no e-mail app on this tablet"
}

private fun sub(kind: String): String = when (kind) {
    "cash" -> "Notes & coins"; "card" -> "Visa · Mastercard"; "wallet" -> "Mobile wallet"; "qr" -> "Scan to pay"; else -> "Recorded by hand"
}

private fun how(m: PaymentTypeEntity, amount: Long): String = when (m.kind) {
    "card" -> "Take ${Money.format(amount)} on the card terminal. When it is approved, press Charge to record it."
    "wallet" -> "Ask the customer to send ${Money.format(amount)} with ${m.name}. When it has arrived, press Charge to record it."
    "qr" -> "The customer scans the ${m.name} code and pays ${Money.format(amount)}. When it has arrived, press Charge to record it."
    else -> "Record ${Money.format(amount)} paid by ${m.name} once it has been received."
}

@Composable
fun PayScreen(vm: PayViewModel, onBack: () -> Unit, onSplit: () -> Unit, onFinish: (kind: String) -> Unit) {
    val ui by vm.ui.collectAsState()
    var leaving by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.open() }
    DisposableEffect(Unit) { onDispose { vm.reset() } }
    // one check of a split check is paid and others are not: back to the checks
    LaunchedEffect(ui.checkPaid) { if (ui.checkPaid) onSplit() }
    // someone else paid or cancelled this order: there is nothing to do here
    LaunchedEffect(ui.gone, ui.done) { if (ui.loaded && ui.gone && ui.done == null) onBack() }
    val back = { if (ui.pending > 0) leaving = true else if (ui.check != null) onSplit() else onBack() }
    BackHandler(enabled = ui.done == null) { back() }

    Box(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxSize()) {
            Column(Modifier.width(390.dp).fillMaxHeight().background(V.Panel).drawBehind { drawRect(V.Stroke, Offset(size.width - 1.dp.toPx(), 0f), Size(1.dp.toPx(), size.height)) }) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        IconKey(VI.Back, tint = V.Text, width = 2.2f, onClick = back)
                        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                            T("PAYMENT", 12.sp, 700, V.Text2, spacing = 1.sp)
                            T(ui.title, 19.sp, 800)
                        }
                    }
                    if (ui.check == null && ui.exchangeOf == null) {
                        Seg(
                            listOf(
                                SegOption("Full bill", ui.split == "full") { vm.split("full") },
                                SegOption("Split equally", ui.split == "equal") { vm.split("equal") },
                                SegOption("Split check", false) { if (vm.maySplit()) onSplit() },
                            ),
                            Modifier.fillMaxWidth(), V.Well, 44.dp, 12.dp, fill = true, size = 14.sp,
                        )
                    }
                    if (ui.split == "equal") {
                        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Well).padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            Stepper(ui.n.toString(), key = 44.dp, well = Color.Transparent, width = 40.dp, big = 20.sp, onDown = { vm.guests(-1) }, onUp = { vm.guests(1) })
                            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                                T("${Money.format(Money.share(ui.remaining + ui.pending, ui.n))} each", 15.sp, 800)
                                T("Part ${ui.part} of ${ui.n}", 13.sp, 700, V.BlueText)
                            }
                        }
                    }
                    if (ui.check != null) T("This check only. The rest of the order stays open.", 14.sp, 700, V.BlueText)
                    ui.exchangeOf?.let { T("Exchange. What comes back from $it pays for this sale as far as it goes.", 14.sp, 700, V.BlueText, lines = 3) }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
                LazyColumn(Modifier.weight(1f).fillMaxWidth().padding(vertical = 4.dp)) {
                    items(ui.lines, key = { it.info.line.id }) { l ->
                        val paid = l.info.line.paid
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 11.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            T(com.restopos.core.print.Docs.qty(l.info.line.qty), 15.sp, 800, if (paid) V.Off else V.Text, Modifier.widthIn(min = 26.dp), strike = paid)
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                T(l.info.line.name_snapshot, 15.sp, 600, if (paid) V.Off else V.Text, lines = 2, strike = paid)
                                if (l.info.detail.isNotEmpty()) T(l.info.detail, 13.sp, 500, V.Text2, lines = 2)
                            }
                            T(Money.format(l.info.amount), 15.sp, 700, if (paid) V.Off else V.Text, strike = paid)
                        }
                    }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
                Column(Modifier.fillMaxWidth().background(V.PanelFoot).padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                    Row { T(L.total, 15.sp, 600, V.Dim); Gap(); T(Money.format(ui.total), 15.sp, 800, V.Dim) }
                    ui.paid.forEach { p -> Row { T("Paid · ${p.label}", 14.sp, 700, V.GreenText); Gap(); T("− ${Money.format(p.amount)}", 14.sp, 700, V.GreenText) } }
                    ui.exchangeOf?.let { Row { T("Returned · $it", 14.sp, 700, V.GreenText); Gap(); T("− ${Money.format(ui.credit)}", 14.sp, 700, V.GreenText) } }
                    Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.Bottom) {
                        T(if (ui.exchangeOf == null) "Remaining" else if (ui.back > 0) "To give back" else "To pay", 16.sp, 700)
                        Gap()
                        T(Money.format(if (ui.exchangeOf == null) ui.remaining else if (ui.back > 0) ui.back else ui.amount), 26.sp, 800, spacing = (-0.5).sp)
                    }
                    Row { T(L.t("of which tax", "dont taxes", "ladan tax"), 13.sp, 600, V.Text3); Gap(); T(Money.format(ui.tax), 13.sp, 600, V.Text3) }
                }
            }
            Column(Modifier.weight(1f).fillMaxHeight().padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    T(if (ui.back > 0) "AMOUNT TO GIVE BACK" else "AMOUNT TO CHARGE", 13.sp, 700, V.Text2, spacing = 1.sp)
                    T(Money.format(if (ui.back > 0) ui.back else ui.amount), 56.sp, 800, spacing = (-2).sp)
                }
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    ui.methods.chunked(5).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            row.forEach { m ->
                                val on = ui.method?.id == m.id
                                Column(
                                    Modifier.weight(1f).height(if (ui.methods.size > 5) 66.dp else 80.dp).clip(RoundedCornerShape(12.dp)).background(if (on) V.On else V.Key2)
                                        .clickable { vm.method(m) }.padding(horizontal = 14.dp),
                                    verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically),
                                ) {
                                    T(m.name, 17.sp, 800, if (on) V.OnText else V.Text)
                                    T(sub(m.kind), 12.sp, 600, if (on) V.OnSub else V.Text2)
                                }
                            }
                            repeat(5 - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
                // an exchange with nothing for the customer to pay has nothing to count in
                val settled = ui.exchangeOf != null && ui.amount == 0L
                if (ui.cash && !settled) {
                    Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                        Column(Modifier.weight(1.1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("00", "0", "del")).forEach { row ->
                                Row(Modifier.weight(1f).heightIn(min = 44.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    row.forEach { k ->
                                        Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(12.dp)).background(V.Key2).clickable { vm.key(k) }, contentAlignment = Alignment.Center) {
                                            T(if (k == "del") "⌫" else k, 26.sp, 700)
                                        }
                                    }
                                }
                            }
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Panel).border(1.dp, V.Stroke, RoundedCornerShape(12.dp)).padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                T("Tendered", 13.sp, 700, V.Text2)
                                T(if (ui.tend.isEmpty()) Money.format(0) else Money.format(ui.tendered), 30.sp, 800)
                            }
                            val a = ui.amount
                            val quick = listOf(a, (a + 9_999) / 10_000 * 10_000, (a + 49_999) / 50_000 * 50_000, (a + 99_999) / 100_000 * 100_000, (a + 199_999) / 200_000 * 200_000)
                                .filter { it > 0 }.distinct().take(4)
                            quick.chunked(2).forEachIndexed { r, row ->
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    row.forEachIndexed { i, v ->
                                        VBtn(if (r == 0 && i == 0) "Exact" else Money.format(v), Modifier.weight(1f), V.BlueWash, V.BlueSoft, 54.dp, size = 16.sp, weight = 800) { vm.tender(v) }
                                    }
                                    if (row.size == 1) Spacer(Modifier.weight(1f))
                                }
                            }
                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.GreenWash).padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.Bottom) {
                                T("Change", 15.sp, 700, V.Dim)
                                Gap()
                                T(if (ui.short) "Short ${Money.format(ui.amount - ui.tendered)}" else Money.format(ui.change), 28.sp, 800, if (ui.short) V.RedText else V.GreenText)
                            }
                        }
                    }
                } else {
                    Column(
                        Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(V.Panel)
                            .drawBehind {
                                drawRoundRect(V.Stroke2, cornerRadius = CornerRadius(16.dp.toPx(), 16.dp.toPx()), style = Stroke(1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(8.dp.toPx(), 6.dp.toPx()))))
                            }.verticalScroll(rememberScrollState()).padding(32.dp),
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
                    ) {
                        VIcon(if (ui.method?.kind == "card") VI.Cash else VI.Qr, 44.dp, V.Cyan, 1.6f)
                        val say = when {
                            settled && ui.back > 0 -> "The goods that come back are worth ${Money.format(ui.back)} more than this sale. Give that back by ${ui.method?.name ?: "the payment type you pick"}, then press Give back to record the exchange."
                            settled -> "The goods that come back cover this sale exactly. Nothing changes hands: press Exchange to record it."
                            else -> ui.method?.let { how(it, ui.amount) }
                        }
                        say?.let { T(it, 17.sp, 700, V.Soft, Modifier.width(440.dp), lines = 4, align = TextAlign.Center, height = 25.sp) }
                        if (!settled) Field(ui.reference, vm::reference, "Reference or last 4 digits (optional)", Modifier.width(360.dp))
                    }
                }
                val ok = !ui.busy && !ui.short && (ui.amount > 0 || (ui.split != "items" && ui.remaining == 0L && ui.lines.any { !it.info.line.paid }) || (settled && ui.remaining > 0))
                VBtn(
                    when {
                        settled && ui.back > 0 -> "Give back ${Money.format(ui.back)}"
                        settled && ui.remaining > 0 -> "Exchange · nothing to pay"
                        ui.amount > 0 -> "${L.charge} ${Money.format(ui.amount)}"
                        ui.lines.any { !it.info.line.paid } -> "Close · nothing to pay"
                        else -> "Nothing left to pay"
                    },
                    Modifier.fillMaxWidth(), if (ok) V.Green else V.GreenOff, if (ok) V.GreenInk else V.GreenOffText, 74.dp, 14.dp, 20.sp, 800,
                ) { vm.charge() }
            }
        }
        ui.done?.let { d -> Done(d, vm) { onFinish(d.kind) } }
    }

    if (leaving) {
        Sheet(onDismiss = { leaving = false }, width = 520.dp) {
            SheetHead("${Money.format(ui.pending)} is already taken", "Leaving now means giving it back: a bill split equally is only recorded once every share is in.") { leaving = false }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Stay and finish", Modifier.weight(1f), V.Blue, Color.White, 60.dp, weight = 800) { leaving = false }
                VBtn("Give it back and leave", Modifier.weight(1f), V.RedWash, V.RedText, 60.dp) { leaving = false; vm.giveBack(); onBack() }
            }
        }
    }
}

// Paid in full: the change to give, how the guest wants the receipt, and on
// to the next thing.
@Composable
private fun Done(d: PayDone, vm: PayViewModel, onFinish: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    BackHandler { onFinish() }
    Box(Modifier.fillMaxSize().background(V.Header.copy(alpha = 0.92f)).clickable(enabled = false) {}, contentAlignment = Alignment.Center) {
        Column(
            Modifier.width(520.dp).clip(RoundedCornerShape(22.dp)).background(V.Panel).border(1.dp, V.Stroke, RoundedCornerShape(22.dp))
                .padding(start = 32.dp, end = 32.dp, top = 36.dp, bottom = 28.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Box(Modifier.size(76.dp).clip(CircleShape).background(V.Green), contentAlignment = Alignment.Center) { VIcon(VI.Check, 40.dp, V.GreenInk, 2.8f) }
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                T(if (d.exchange) "Exchange complete" else "Payment complete", 26.sp, 800, spacing = (-0.5).sp)
                T("${Money.format(d.total)} · ${d.method}", 15.sp, 600, V.Text2)
            }
            if (d.change > 0 || d.back > 0) {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.GreenWash).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(if (d.back > 0) "Give back" + (d.backBy?.let { " by $it" } ?: "") else "Give change", 14.sp, 700, V.Dim)
                    T(Money.format(if (d.back > 0) d.back else d.change), 44.sp, 800, V.GreenText, spacing = (-1.5).sp)
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VBtn("Print", Modifier.weight(1f)) { vm.printCopy(d.receiptId) }
                VBtn("Email", Modifier.weight(1f)) {
                    scope.launch { vm.receiptText(d.receiptId)?.let { text -> share(context, text, "Your receipt", d.email, whatsapp = false)?.let { Toaster.say(it) } } }
                }
                VBtn("WhatsApp", Modifier.weight(1f)) {
                    scope.launch { vm.receiptText(d.receiptId)?.let { text -> share(context, text, "Your receipt", d.phone, whatsapp = true)?.let { Toaster.say(it) } } }
                }
            }
            VBtn(
                when { d.kind == "counter" || d.kind == "tab" -> "Next sale"; d.table != null -> "Done · free ${d.table}"; else -> "Done" },
                Modifier.fillMaxWidth(), V.Blue, Color.White, 64.dp, 14.dp, 17.sp, 800, onClick = onFinish,
            )
        }
    }
}

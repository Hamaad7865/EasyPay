package com.restopos.feature.retail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.DepositMoney
import com.restopos.core.data.DepositRules
import com.restopos.core.data.Deposits
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.PosSettings
import com.restopos.core.data.StaffMember
import com.restopos.core.database.CustomerEntity
import com.restopos.core.database.DepositEntity
import com.restopos.core.database.DepositLineEntity
import com.restopos.core.database.DepositPaymentEntity
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.database.free
import com.restopos.core.database.left
import com.restopos.core.print.DocAmount
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.press
import com.restopos.feature.customers.CustomerPicker
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import javax.inject.Inject

private val DAY = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.US)
private fun day(ymd: String) = runCatching { LocalDate.parse(ymd).format(DAY) }.getOrDefault(ymd)

// A deposit on the list: with its customer's name and phone, and how late it is.
data class DepositRow(val d: DepositEntity, val customer: String?, val phone: String?, val over: Long, val toPay: Long = 0)

// The deposit opened on the right: its lines and its payments, each payment with its method's name.
data class DepositOpen(val d: DepositEntity, val customer: CustomerEntity?, val lines: List<DepositLineEntity>, val payments: List<Pair<DepositPaymentEntity, String>>, val toPay: Long = 0)

// Behind the Deposits screen and the Deposit key of Sell (server 0113). Every
// change goes through core/data/Deposits, which writes the tablet's rows and
// the outbox op together; a right the person at the till lacks is asked of a
// manager (Approvals), and the action goes on with their PIN.
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@HiltViewModel
class DepositsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val deposits: Deposits,
    private val approvals: Approvals,
) : ViewModel() {
    val query = MutableStateFlow("")
    val showAll = MutableStateFlow(false)
    val selected = MutableStateFlow<String?>(null)
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy
    val settings = MutableStateFlow(PosSettings())

    val methods: StateFlow<List<PaymentTypeEntity>> = db.catalog().paymentTypes().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val rows: StateFlow<List<DepositRow>> = combine(deposits.all(), db.customers().everyone(), query, showAll) { all, people, q, every ->
        val byId = people.associateBy { it.id }
        val text = q.trim().lowercase()
        all.map { DepositRow(it, it.customer_id?.let { c -> byId[c]?.name }, it.customer_id?.let { c -> byId[c]?.phone }, if (it.status == "open") DepositRules.daysOver(it.collect_by) else 0, deposits.toPay(it)) }
            .filter { r -> every || text.isNotEmpty() || r.d.status == "open" || r.d.owed > 0 || (r.d.status == "collected" && r.d.free > 0) }
            .filter { r -> text.isEmpty() || r.d.number.lowercase().contains(text) || r.customer?.lowercase()?.contains(text) == true || r.phone?.filter { c -> c.isDigit() }?.contains(text.filter { c -> c.isDigit() }.ifEmpty { "\u0000" }) == true }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val open: StateFlow<DepositOpen?> = selected.flatMapLatest { id ->
        if (id == null) flowOf(null)
        else combine(deposits.watch(id), deposits.lines(id), deposits.payments(id)) { d, ls, ps -> Triple(d, ls, ps) }.mapLatest { (d, ls, ps) ->
            d?.let { dep ->
                val names = db.ops().allPaymentTypes().associateBy { it.id }
                DepositOpen(dep, dep.customer_id?.let { db.customers().customer(it) }, ls, ps.map { it to (names[it.payment_type_id]?.name ?: "Paid") }, deposits.toPay(dep))
            }
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    init { viewModelScope.launch { settings.value = deposits.settings() } }
    fun refreshSettings() = viewModelScope.launch { settings.value = deposits.settings() }

    // a slip scanned, or a number typed whole: the deposit opens
    fun openNumber(number: String) = viewModelScope.launch {
        val d = deposits.find(number)
        if (d == null) Toaster.say("This till does not know deposit ${number.trim()}. Let it sync and try again.") else selected.value = d.id
    }

    // what a cashier does, with a manager's PIN asked when their role lacks the right
    private fun run(done: (DepositEntity?) -> String?, by: StaffMember? = null, block: suspend (StaffMember?) -> Result<DepositEntity?>): kotlinx.coroutines.Job = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        val out = block(by)
        _busy.value = false
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) approvals.ask(need.permission, need.what) { approver -> run(done, approver, block) }
        else out.fold({ done(it)?.let(Toaster::say) }, { Toaster.say(it.message ?: "That did not work") })
    }

    private fun visit(m: DepositMoney, name: String): List<DocAmount> =
        listOfNotNull(DocAmount("Paid now, $name", m.amount), m.tendered?.let { DocAmount("Tendered", it) }, m.change.takeIf { it > 0 }?.let { DocAmount("Change", it) })

    // the sale on Sell becomes a deposit
    fun take(customerId: String?, collectBy: String, m: DepositMoney?, then: () -> Unit) = run({ d ->
        then()
        d?.let { "Deposit ${it.number} taken · " + if ((m?.amount ?: 0) > 0) "${Money.format(m!!.amount)} paid, ${Money.format((it.total - it.paid).coerceAtLeast(0))} to pay" else "nothing paid yet" }
    }) { _ ->
        deposits.take(customerId, collectBy, m).onSuccess { d ->
            val cash = m != null && m.amount > 0 && deposits.isCash(m.paymentTypeId)
            deposits.printSlip(d.id, "DEPOSIT", m?.takeIf { it.amount > 0 }?.let { visit(it, deposits.paymentName(it.paymentTypeId)) }.orEmpty(), openDrawer = cash).onFailure { Toaster.say("Taken, but the slip did not print: ${it.message}") }
        }
    }

    fun pay(d: DepositEntity, m: DepositMoney, then: () -> Unit) = run({ x -> then(); x?.let { "${Money.format(m.amount)} paid on ${it.number}" } }) { _ ->
        deposits.pay(d.id, m).onSuccess { x ->
            deposits.printSlip(x.id, "DEPOSIT PAYMENT", visit(m, deposits.paymentName(m.paymentTypeId)), openDrawer = deposits.isCash(m.paymentTypeId)).onFailure { Toaster.say("Paid, but the slip did not print: ${it.message}") }
        }
    }

    // the lines picked go on a new sale; Sell opens with them and Pay takes the deposit first
    fun collect(d: DepositEntity, picks: Map<String, Int>, then: () -> Unit) = run({ then(); "On the sale. Pay takes the deposit first." }) { _ ->
        deposits.collect(d.id, picks).map { null }
    }

    fun cancel(d: DepositEntity, outcome: String, reason: String, back: List<DepositMoney>, then: () -> Unit) = run({ x ->
        then()
        x?.let {
            when (outcome) {
                "refund" -> "Deposit ${it.number} cancelled · ${Money.format(it.given_back)} given back"
                "credit" -> "Deposit ${it.number} cancelled · ${Money.format(it.noted)} on a credit note"
                else -> "Deposit ${it.number} cancelled · ${Money.format(it.kept)} kept by the shop"
            } + if (it.status == "collected") "" else ". What was not collected is back on the shelf."
        }
    }) { by ->
        deposits.cancel(d.id, outcome, reason, back, by).onSuccess { x ->
            val cash = back.any { deposits.isCash(it.paymentTypeId) && it.amount > 0 }
            deposits.printSlip(x.id, "DEPOSIT CANCELLED", back.filter { it.amount > 0 }.map { DocAmount("Given back, ${deposits.paymentName(it.paymentTypeId)}", it.amount) }, openDrawer = cash)
                .onFailure { Toaster.say("Cancelled, but the slip did not print: ${it.message}") }
            if (x.credit_note_id != null) deposits.printNote(x.id).onFailure { Toaster.say("The credit note did not print: ${it.message}. Print it again from the deposit.") }
        }
    }

    fun giveBack(d: DepositEntity, back: List<DepositMoney>, then: () -> Unit) = run({ x -> then(); x?.let { "${Money.format(it.given_back)} given back on ${it.number}" } }) { by ->
        deposits.giveBack(d.id, back, by).onSuccess { x ->
            deposits.printSlip(x.id, "DEPOSIT CANCELLED", back.map { DocAmount("Given back, ${deposits.paymentName(it.paymentTypeId)}", it.amount) }, openDrawer = back.any { deposits.isCash(it.paymentTypeId) })
        }
    }

    fun reprint(d: DepositEntity) = viewModelScope.launch {
        deposits.printSlip(d.id, if (d.status == "open") "DEPOSIT" else if (d.cancel_outcome != null) "DEPOSIT CANCELLED" else "DEPOSIT").fold({ Toaster.say("Printed") }, { Toaster.say(it.message) })
        if (d.credit_note_id != null) deposits.printNote(d.id).onFailure { Toaster.say(it.message) }
    }

    // How the money of a cancel goes back by default: the ways it came in, newest first.
    fun backPlan(o: DepositOpen, amount: Long): List<DepositMoney> {
        // the ways it came in, as the deposit's own payments say: not the methods offered on this
        // screen, which may not have loaded yet when the sheet opens
        val came = o.payments.filter { it.first.kind == "in" }.map { it.first.payment_type_id to it.first.amount }
        return DepositRules.backSplit(amount, came).map { DepositMoney(it.first, it.second) }
    }
}

// ---------------------------------------------------------------- the screen

@Composable
fun DepositsScreen(vm: DepositsViewModel, onCollect: () -> Unit, onBack: () -> Unit) {
    val rows by vm.rows.collectAsState()
    val open by vm.open.collectAsState()
    val q by vm.query.collectAsState()
    val all by vm.showAll.collectAsState()
    LaunchedEffect(Unit) { vm.refreshSettings() }
    LaunchedEffect(Unit) { com.restopos.core.common.Scanner.codes.collect { vm.openNumber(it) } }

    Row(Modifier.fillMaxSize().padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                IconKey(VI.Back, tint = V.Text, onClick = onBack)
                ScreenHead("Goods held for customers who paid part. Scan a slip to open it.", "Deposits", Modifier.weight(1f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Field(q, { vm.query.value = it.take(40) }, "Number, name or phone", Modifier.weight(1f), height = 50.dp, bg = V.Panel, onDone = { if (q.isNotBlank()) vm.openNumber(q) })
                VBtn(if (all) "Open only" else "Show all", height = 50.dp, pad = 14.dp) { vm.showAll.value = !all }
            }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (rows.isEmpty()) item {
                    T(if (q.isBlank()) "No open deposits. A deposit is taken on Sell: ring up the goods, then Deposit." else "No deposit matches “${q.trim()}”.", 15.sp, 500, V.Text2, Modifier.padding(24.dp), lines = 3)
                }
                items(rows, key = { it.d.id }) { r -> ListRow(r, r.d.id == open?.d?.id) { vm.selected.value = r.d.id } }
            }
        }
        Box(Modifier.width(500.dp).fillMaxHeight().clip(RoundedCornerShape(20.dp)).background(V.Panel)) {
            val o = open
            if (o == null) T("Pick a deposit on the left", 16.sp, 600, V.Text2, Modifier.align(Alignment.Center))
            else Detail(o, vm, onCollect)
        }
    }
}

@Composable
private fun ListRow(r: DepositRow, on: Boolean, onClick: () -> Unit) {
    val d = r.d
    val state = DepositRules.stateWords(d.status, d.owed, r.over)
    val tone = when { d.status == "open" && r.over > 0 -> V.RedText; d.status == "open" -> V.BlueText; d.owed > 0 -> V.AmberText; else -> V.Text3 }
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (on) V.RowOn else V.Panel).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(listOfNotNull(r.customer, r.phone).joinToString(" · ").ifEmpty { "No customer" }, 15.sp, 700)
            T("${d.number} · collect by ${day(d.collect_by)}", 12.5.sp, 600, V.Text2)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(if (d.status == "open") "${Money.format(r.toPay)} to pay" else Money.format(d.total), 15.sp, 800)
            T(state, 12.sp, 800, tone)
        }
    }
}

@Composable
private fun Detail(o: DepositOpen, vm: DepositsViewModel, onCollect: () -> Unit) {
    val d = o.d
    val busy by vm.busy.collectAsState()
    val s by vm.settings.collectAsState()
    var sheet by remember(d.id) { mutableStateOf<String?>(null) } // pay | collect | cancel | back | settle
    val toPay = o.toPay
    val over = if (d.status == "open") DepositRules.daysOver(d.collect_by) else 0
    // what the deposit is scrolls; what can be done to it stays at the foot, in reach on a 10-inch
    Column(Modifier.fillMaxSize()) {
    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                T(d.number, 22.sp, 800)
                T(listOfNotNull(o.customer?.name, o.customer?.phone).joinToString(" · ").ifEmpty { "No customer" }, 15.sp, 600, V.Text2)
            }
            Box(Modifier.clip(RoundedCornerShape(14.dp)).background(if (over > 0) V.RedWash else V.Key).padding(horizontal = 12.dp, vertical = 6.dp)) {
                T(DepositRules.stateWords(d.status, d.owed, over), 13.sp, 800, if (over > 0) V.RedText else V.Text)
            }
        }
        T("Collect by ${day(d.collect_by)}" + (d.cancel_reason?.let { " · $it" } ?: ""), 14.sp, 600, if (over > 0) V.RedText else V.Text2, lines = 2)
        Caps("Goods")
        o.lines.forEach { l ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f)) {
                    T(l.name, 15.sp, 700, lines = 2)
                    T("${l.qty / 1000} at ${Money.format(l.unit_price)}" + (l.price_label?.let { " · $it" } ?: "") +
                        if (l.qty_collected > 0) " · ${l.qty_collected / 1000} collected" else "", 12.5.sp, 600, V.Text2, lines = 2)
                }
                T(Money.format(com.restopos.core.data.Calc.lineAmount(l.unit_price, l.qty)), 15.sp, 700)
            }
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
        Money2("Total", d.total)
        Money2("Paid", d.paid)
        if (d.given_back > 0) Money2("Given back", -d.given_back)
        if (d.used > 0) Money2("Used on collection", d.used)
        if (d.noted > 0) Money2("Put on a credit note", d.noted)
        if (d.kept > 0) Money2("Kept by the shop", d.kept)
        if (d.owed > 0) Money2("To give back", d.owed, V.AmberText)
        if (d.status == "open") Money2("To pay", toPay, V.Text, big = true)
        if (d.status == "collected" && d.free > 0) Money2("Paid and not used", d.free, V.AmberText, big = true)
        if (o.payments.isNotEmpty()) {
            Caps("Payments")
            o.payments.forEach { (p, name) ->
                Row(Modifier.fillMaxWidth()) {
                    T((if (p.kind == "back") "Given back, " else "") + name + " · " + java.text.SimpleDateFormat("d MMM HH:mm", Locale.US).format(java.util.Date(p.device_time)), 13.sp, 600, V.Text2, Modifier.weight(1f))
                    T(Money.format(p.amount), 13.sp, 700)
                }
            }
        }
    }
    Column(Modifier.fillMaxWidth().background(V.PanelFoot).padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (d.status == "open") {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VBtn("Add payment", Modifier.weight(1f), height = 50.dp, enabled = !busy && toPay > 0) { sheet = "pay" }
                VBtn("Collect", Modifier.weight(1f), V.Green, V.GreenInk, 50.dp, weight = 800, enabled = !busy) { sheet = "collect" }
                VBtn("Cancel", Modifier.weight(1f), V.RedWash, V.RedText, 50.dp, enabled = !busy) { sheet = "cancel" }
            }
        }
        if (d.status == "collected" && d.free > 0 && d.cancel_outcome == null) VBtn("Settle what is left: ${Money.format(d.free)}", Modifier.fillMaxWidth(), V.AmberWash, V.AmberText, weight = 800, enabled = !busy) { sheet = "cancel" }
        if (d.owed > 0) VBtn("Give back ${Money.format(d.owed)}", Modifier.fillMaxWidth(), V.AmberWash, V.AmberText, weight = 800, enabled = !busy) { sheet = "back" }
        VBtn("Print the slip again", Modifier.fillMaxWidth(), height = 46.dp, icon = VI.Print) { vm.reprint(d) }
    }
    }

    when (sheet) {
        "pay" -> MoneySheet("Payment on ${d.number}", "${Money.format(toPay)} to pay", toPay, toPay, vm, allowZero = false, onDismiss = { sheet = null }) { m -> m?.let { vm.pay(d, it) { sheet = null } } }
        "collect" -> CollectSheet(o, onDismiss = { sheet = null }) { picks -> vm.collect(d, picks) { sheet = null; onCollect() } }
        "cancel" -> CancelSheet(o, s, vm, onDismiss = { sheet = null })
        "back" -> BackSheet("Give back on ${d.number}", d.owed, vm.backPlan(o, d.owed), vm, o, onDismiss = { sheet = null }) { back -> vm.giveBack(d, back) { sheet = null } }
    }
}

@Composable
private fun Money2(label: String, cents: Long, color: Color = V.Text2, big: Boolean = false) {
    Row(Modifier.fillMaxWidth()) {
        T(label, if (big) 17.sp else 14.sp, if (big) 800 else 600, color, Modifier.weight(1f))
        T(Money.format(cents), if (big) 17.sp else 14.sp, if (big) 800 else 700, color)
    }
}

// ---------------------------------------------------------------- the sheets

// Money taken: how much (from nothing to `most`) and how. Cash asks what was
// handed over and says the change.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun MoneySheet(
    title: String, sub: String, most: Long, start: Long, vm: DepositsViewModel, allowZero: Boolean,
    onDismiss: () -> Unit, extra: (@Composable () -> Unit)? = null, cta: String = "Take payment", onDone: (DepositMoney?) -> Unit,
) {
    val methods by vm.methods.collectAsState()
    val busy by vm.busy.collectAsState()
    var amount by remember { mutableStateOf(Money.plain(start).replace(",", "")) }
    var method by remember(methods) { mutableStateOf(methods.firstOrNull()) }
    var tendered by remember { mutableStateOf("") }
    val cents = if (amount.isBlank()) 0L else Money.parseRs(amount)
    val cash = method?.kind == "cash"
    val got = if (cash && tendered.isNotBlank()) Money.parseRs(tendered) else null
    val problem = when {
        cents == null -> "Type an amount"
        cents == 0L && !allowZero -> "Type how much"
        cents > most -> "That is more than the ${Money.format(most)} left to pay"
        cents > 0 && method == null -> "Pick how it is paid"
        cash && got != null && got < cents -> "Tendered is below ${Money.format(cents)}"
        else -> null
    }
    Sheet(onDismiss = onDismiss, width = 600.dp, top = true, gap = 14.dp) {
        SheetHead(title, sub, onDismiss)
        extra?.invoke()
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            T("Rs", 18.sp, 700, V.Text2)
            Field(amount, { amount = it.filter { c -> c.isDigit() || c == '.' }.take(10) }, "0", Modifier.weight(1f), height = 56.dp, number = true, size = 20.sp)
            if (allowZero) VBtn("Nothing now", height = 56.dp, pad = 14.dp) { amount = "0" }
            VBtn("All ${Money.format(most)}", height = 56.dp, pad = 14.dp) { amount = Money.plain(most).replace(",", "") }
        }
        if ((cents ?: 0) > 0) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                methods.forEach { m -> VBtn(m.name, bg = if (m.id == method?.id) V.On else V.Key, fg = if (m.id == method?.id) V.OnText else V.Text, height = 50.dp) { method = m; tendered = "" } }
            }
            if (cash) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                T("Handed over", 15.sp, 600, V.Text2)
                Field(tendered, { tendered = it.filter { c -> c.isDigit() || c == '.' }.take(10) }, "the exact amount", Modifier.weight(1f), height = 50.dp, number = true)
                if (got != null && cents != null && got > cents) T("Change ${Money.format(got - cents)}", 15.sp, 800, V.GreenText)
            }
        }
        problem?.let { T(it, 13.sp, 600, V.RedText) }
        VBtn(cta, Modifier.fillMaxWidth(), V.Green, V.GreenInk, 58.dp, weight = 800, enabled = problem == null && !busy) {
            val c = cents ?: 0
            onDone(if (c == 0L) null else DepositMoney(method!!.id, c, if (cash) (got ?: c) else null, if (cash) (got ?: c) - c else 0))
        }
    }
}

// What the customer takes today: every line ticked with all that is left, each to be lowered.
@Composable
private fun CollectSheet(o: DepositOpen, onDismiss: () -> Unit, onDone: (Map<String, Int>) -> Unit) {
    val picks = remember(o.d.id) { mutableStateMapOf<String, Int>().apply { o.lines.forEach { put(it.id, it.left) } } }
    Sheet(onDismiss = onDismiss, width = 600.dp, gap = 12.dp) {
        SheetHead("Collect from ${o.d.number}", "What the customer takes today. It goes on a sale at the price the deposit kept; Pay takes the deposit first.", onDismiss)
        o.lines.filter { it.left > 0 }.forEach { l ->
            val n = picks[l.id] ?: 0
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Well).padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f)) {
                    T(l.name, 15.sp, 700, lines = 2)
                    T("${l.left / 1000} left at ${Money.format(l.unit_price)}", 12.5.sp, 600, V.Text2)
                }
                StepKey("−") { picks[l.id] = (n - 1000).coerceAtLeast(0) }
                T("${n / 1000}", 18.sp, 800, modifier = Modifier.width(36.dp), align = androidx.compose.ui.text.style.TextAlign.Center)
                StepKey("+") { picks[l.id] = (n + 1000).coerceAtMost(l.left) }
            }
        }
        val any = picks.values.any { it > 0 }
        VBtn("Put on the sale", Modifier.fillMaxWidth(), V.Green, V.GreenInk, 58.dp, weight = 800, enabled = any) { onDone(picks.toMap()) }
    }
}

// Cancelling: the reason, and what the shop's setting does with the money
// that is free. Under refund the money goes back the ways it came, which the
// cashier can make all cash.
@Composable
private fun CancelSheet(o: DepositOpen, s: PosSettings, vm: DepositsViewModel, onDismiss: () -> Unit) {
    val d = o.d
    val free = d.free.coerceAtLeast(0)
    val busy by vm.busy.collectAsState()
    var reason by remember { mutableStateOf(if (d.status == "collected") "Collected; paid more than the goods" else "") }
    val outcome = s.depositCancel
    val closing = d.status == "collected"
    var back by remember(d.id) { mutableStateOf(vm.backPlan(o, free)) }
    val methods by vm.methods.collectAsState()
    val cashType = methods.firstOrNull { it.kind == "cash" }
    Sheet(onDismiss = onDismiss, width = 600.dp, top = true, gap = 14.dp) {
        SheetHead(
            if (closing) "Settle ${d.number}" else "Cancel ${d.number}?",
            (if (closing) "" else "What was not collected goes back on the shelf. ") + when {
                free <= 0 -> "Nothing paid is left on it: no money moves."
                outcome == "refund" -> "The shop gives back ${Money.format(free)}."
                outcome == "keep" -> "The shop keeps ${Money.format(free)}, as its setting says."
                else -> "${Money.format(free)} goes on a credit note for the customer, valid ${if (s.noteMonths == 0) "with no end" else "${s.noteMonths} months"}."
            }, onDismiss,
        )
        Field(reason, { reason = it.take(120) }, "Why (changed mind, found it cheaper…)", Modifier.fillMaxWidth(), height = 52.dp)
        if (outcome == "refund" && free > 0) {
            Caps("Given back")
            back.forEach { b -> Row(Modifier.fillMaxWidth()) { T(o.payments.firstOrNull { it.first.payment_type_id == b.paymentTypeId }?.second ?: methods.firstOrNull { it.id == b.paymentTypeId }?.name ?: "Paid", 15.sp, 600, V.Text2, Modifier.weight(1f)); T(Money.format(b.amount), 15.sp, 800) } }
            if (back.sumOf { it.amount } != free) T("The ways it came in are not all on this till. Give it all back in cash.", 13.sp, 600, V.AmberText, lines = 2)
            if (cashType != null) VBtn("All in cash", height = 46.dp) { back = listOf(DepositMoney(cashType.id, free)) }
        }
        val ok = reason.isNotBlank() && (outcome != "refund" || free == 0L || back.sumOf { it.amount } == free)
        VBtn(
            if (closing) "Settle" else if (free <= 0) "Cancel the deposit" else when (outcome) { "refund" -> "Cancel and give back ${Money.format(free)}"; "keep" -> "Cancel, the shop keeps ${Money.format(free)}"; else -> "Cancel, credit note for ${Money.format(free)}" },
            Modifier.fillMaxWidth(), V.Red, Color.White, 58.dp, weight = 800, enabled = ok && !busy,
        ) { vm.cancel(d, outcome, reason, if (outcome == "refund") back else emptyList()) { onDismiss() } }
    }
}

// Money a cancelled deposit owes, handed over now: the ways it came in, or all in cash.
@Composable
private fun BackSheet(title: String, owed: Long, plan: List<DepositMoney>, vm: DepositsViewModel, o: DepositOpen, onDismiss: () -> Unit, onDone: (List<DepositMoney>) -> Unit) {
    val methods by vm.methods.collectAsState()
    val busy by vm.busy.collectAsState()
    var back by remember { mutableStateOf(plan) }
    val cashType = methods.firstOrNull { it.kind == "cash" }
    Sheet(onDismiss = onDismiss, width = 560.dp, gap = 14.dp) {
        SheetHead(title, "${Money.format(owed)} is owed to the customer.", onDismiss)
        back.forEach { b -> Row(Modifier.fillMaxWidth()) { T(o.payments.firstOrNull { it.first.payment_type_id == b.paymentTypeId }?.second ?: methods.firstOrNull { it.id == b.paymentTypeId }?.name ?: "Paid", 15.sp, 600, V.Text2, Modifier.weight(1f)); T(Money.format(b.amount), 15.sp, 800) } }
        if (cashType != null) VBtn("All in cash", height = 46.dp) { back = listOf(DepositMoney(cashType.id, owed)) }
        VBtn("Give back ${Money.format(owed)}", Modifier.fillMaxWidth(), V.Amber, Color.White, 58.dp, weight = 800, enabled = back.sumOf { it.amount } == owed && !busy) { onDone(back) }
    }
}

// The Deposit key of Sell: who it is for, until when, and what is paid now.
@Composable
fun TakeDepositSheet(total: Long, customerId: String?, customerName: String?, vm: DepositsViewModel, onCustomer: () -> Unit, onDismiss: () -> Unit, onTaken: () -> Unit) {
    val s by vm.settings.collectAsState()
    LaunchedEffect(Unit) { vm.refreshSettings() }
    var days by remember(s.depositDays) { mutableStateOf(s.depositDays) }
    val by = DepositRules.collectBy(days)
    MoneySheet(
        "Take a deposit", "The goods are held off the shelf at today's prices. Total ${Money.format(total)}.", total, 0, vm, allowZero = true, onDismiss = onDismiss,
        extra = {
            Row(
                Modifier.fillMaxWidth().height(52.dp).clip(RoundedCornerShape(12.dp))
                    .then(if (customerName != null) Modifier.background(V.Key) else Modifier.border(1.dp, V.Stroke2, RoundedCornerShape(12.dp)))
                    .clickable(onClick = onCustomer).padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                com.restopos.core.ui.VIcon(VI.Person, 18.dp, if (customerName != null) V.Text else V.BlueText)
                T(customerName ?: if (s.depositCustomer) "Add the customer (needed)" else "Add the customer", 15.sp, 700, if (customerName != null) V.Text else V.BlueText, Modifier.weight(1f))
                com.restopos.core.ui.VIcon(VI.Chevron, 16.dp, V.Text3)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                T("Collect by", 15.sp, 600, V.Text2, Modifier.weight(1f))
                StepKey("−") { days = (days - 1).coerceAtLeast(1) }
                T(day(by), 16.sp, 800, modifier = Modifier.width(130.dp), align = androidx.compose.ui.text.style.TextAlign.Center)
                StepKey("+") { days = (days + 1).coerceAtMost(365) }
            }
            T(DepositRules.slipSentence(s.depositCancel, s.depositOverdue, s.depositGrace), 13.sp, 600, V.Text3, lines = 2)
        },
        cta = "Take deposit",
    ) { m -> vm.take(customerId, by, m) { onTaken() } }
}

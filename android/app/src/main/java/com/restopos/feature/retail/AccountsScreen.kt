package com.restopos.feature.retail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.AccountMoney
import com.restopos.core.data.AccountRules
import com.restopos.core.data.Accounts
import com.restopos.core.data.PosSettings
import com.restopos.core.database.AccountBillEntity
import com.restopos.core.database.AccountOwing
import com.restopos.core.database.CustomerEntity
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.database.owed
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
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// The customer opened on the right: who they are, and their bills that still owe, oldest first.
data class AccountOpen(val customer: CustomerEntity?, val customerId: String, val bills: List<AccountBillEntity>) {
    val owed: Long get() = bills.sumOf { it.owed }
}

// Behind the Accounts screen (server 0114): who owes the shop, and money
// taken on the bills the cashier ticks. Every change goes through
// core/data/Accounts, which writes the tablet's rows and the outbox op together.
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@HiltViewModel
class AccountsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val accounts: Accounts,
) : ViewModel() {
    val query = MutableStateFlow("")
    val selected = MutableStateFlow<String?>(null)
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy
    val settings = MutableStateFlow(PosSettings())

    // the ways money is taken on an account: never the built-in kinds
    val methods: StateFlow<List<PaymentTypeEntity>> = db.catalog().paymentTypes().map { all -> all.filter { it.kind !in Accounts.FIXED } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val rows: StateFlow<List<AccountOwing>> = combine(accounts.owing(), query) { all, q ->
        val text = q.trim().lowercase()
        val digits = text.filter { it.isDigit() }
        all.filter { r -> text.isEmpty() || r.name?.lowercase()?.contains(text) == true || (digits.length >= 3 && r.phone?.filter { it.isDigit() }?.contains(digits) == true) }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val open: StateFlow<AccountOpen?> = selected.flatMapLatest { id ->
        if (id == null) flowOf(null) else accounts.open(id).map { bills -> AccountOpen(accounts.customer(id), id, bills) }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    init { viewModelScope.launch { settings.value = accounts.settings() } }

    fun pay(o: AccountOpen, ticked: Collection<String>, m: AccountMoney, then: () -> Unit) = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        val out = accounts.pay(o.customerId, ticked, m)
        _busy.value = false
        out.fold({ p ->
            then()
            Toaster.say("${Money.format(p.amount)} paid on ${o.customer?.name ?: "the account"} · ${p.number}")
            val cash = db.ops().paymentType(p.payment_type_id)?.kind == "cash"
            accounts.printPayment(p.id, openDrawer = cash).onFailure { Toaster.say("Paid, but the slip did not print: ${it.message}") }
        }, { Toaster.say(it.message ?: "That did not work") })
    }

    fun statement(o: AccountOpen) = viewModelScope.launch {
        accounts.printStatement(o.customerId).fold({ Toaster.say("Statement sent to the printer") }, { Toaster.say(it.message) })
    }
}

// ---------------------------------------------------------------- the screen

@Composable
fun AccountsScreen(vm: AccountsViewModel, onBack: () -> Unit) {
    val rows by vm.rows.collectAsState()
    val open by vm.open.collectAsState()
    val q by vm.query.collectAsState()
    val s by vm.settings.collectAsState()

    Row(Modifier.fillMaxSize().padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                IconKey(VI.Back, tint = V.Text, onClick = onBack)
                ScreenHead("Customers who took goods on account, and what they owe.", "Accounts", Modifier.weight(1f))
            }
            Field(q, { vm.query.value = it.take(40) }, "Name or phone", Modifier.fillMaxWidth(), height = 50.dp, bg = V.Panel)
            if (rows.isNotEmpty()) T("${rows.size} ${if (rows.size == 1) "customer owes" else "customers owe"} ${Money.format(rows.sumOf { it.owed })}", 13.sp, 700, V.Text2)
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (rows.isEmpty()) item {
                    T(if (q.isBlank()) "Nobody owes the shop. A sale goes on a customer's account with On account on Pay." else "Nobody owing matches “${q.trim()}”.", 15.sp, 500, V.Text2, Modifier.padding(24.dp), lines = 3)
                }
                items(rows, key = { it.customer_id }) { r -> OwingRow(r, r.customer_id == open?.customerId, s.accountDays) { vm.selected.value = r.customer_id } }
            }
        }
        Box(Modifier.width(500.dp).fillMaxHeight().clip(RoundedCornerShape(20.dp)).background(V.Panel)) {
            val o = open
            if (o == null) T("Pick a customer on the left", 16.sp, 600, V.Text2, Modifier.align(Alignment.Center))
            else Detail(o, vm, s.accountDays)
        }
    }
}

@Composable
private fun OwingRow(r: AccountOwing, on: Boolean, days: Int, onClick: () -> Unit) {
    val late = r.oldest?.let { AccountRules.overdue(it, days) } == true
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (on) V.RowOn else V.Panel).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(listOfNotNull(r.name, r.phone).joinToString(" · ").ifEmpty { "A customer" }, 15.sp, 700)
            T("${r.bills} ${if (r.bills == 1) "bill" else "bills"}" + (r.oldest?.let { " · oldest ${Accounts.dayWords(it)}" } ?: ""), 12.5.sp, 600, V.Text2)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(Money.format(r.owed), 15.sp, 800)
            if (late) T("Overdue", 12.sp, 800, V.RedText)
        }
    }
}

@Composable
private fun Detail(o: AccountOpen, vm: AccountsViewModel, days: Int) {
    val busy by vm.busy.collectAsState()
    // the bills ticked: all of them, until the cashier takes some off
    val ticked = remember(o.customerId, o.bills.map { it.id }) { mutableStateListOf<String>().apply { addAll(o.bills.map { it.id }) } }
    var paying by remember(o.customerId) { mutableStateOf(false) }
    val tickedTotal = o.bills.filter { it.id in ticked }.sumOf { it.owed }
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            T(o.customer?.name ?: "A customer", 22.sp, 800)
            o.customer?.phone?.let { T(it, 15.sp, 600, V.Text2) }
            Row(Modifier.fillMaxWidth()) { T("Owes", 17.sp, 800, V.Text, Modifier.weight(1f)); T(Money.format(o.owed), 17.sp, 800) }
            val aged = AccountRules.aged(o.bills.map { AccountRules.Owing(it.id, it.day, it.owed) })
            if (aged.count { it > 0 } > 1 || aged.drop(1).any { it > 0 }) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    AccountRules.BUCKETS.forEachIndexed { i, b ->
                        Column(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).background(V.Well).padding(8.dp)) {
                            T(b, 11.sp, 700, V.Text2)
                            T(Money.format(aged[i]), 13.sp, 800, if (i > 0 && aged[i] > 0) V.RedText else V.Text)
                        }
                    }
                }
            }
            Caps("Bills · tick what is paid")
            if (o.bills.isEmpty()) T("Nothing is owed.", 15.sp, 500, V.Text2)
            o.bills.forEach { b ->
                val on = b.id in ticked
                val late = AccountRules.overdue(b.day, days)
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (on) V.RowOn else V.Well).clickable { if (on) ticked.remove(b.id) else ticked.add(b.id) }.padding(12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Box(Modifier.size(22.dp).clip(RoundedCornerShape(6.dp)).background(if (on) V.Blue else V.Key), contentAlignment = Alignment.Center) {
                        if (on) T("✓", 14.sp, 800, androidx.compose.ui.graphics.Color.White)
                    }
                    Column(Modifier.weight(1f)) {
                        T(b.number, 15.sp, 700)
                        T(Accounts.dayWords(b.day) + " · " + Money.format(b.amount) + (if (b.paid + b.returned > 0) " · ${Money.format(b.paid + b.returned)} off" else "") + (if (late) " · overdue" else ""), 12.5.sp, 600, if (late) V.RedText else V.Text2)
                    }
                    T(Money.format(b.owed), 15.sp, 800)
                }
            }
        }
        Column(Modifier.fillMaxWidth().background(V.PanelFoot).padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            VBtn(if (tickedTotal > 0) "Take payment · ${Money.format(tickedTotal)} ticked" else "Tick the bills being paid", Modifier.fillMaxWidth(), V.Green, V.GreenInk, 54.dp, weight = 800, enabled = !busy && tickedTotal > 0) { paying = true }
            VBtn("Print a statement", Modifier.fillMaxWidth(), height = 46.dp, icon = VI.Print) { vm.statement(o) }
        }
    }
    if (paying) PaySheet(o, ticked.toList(), tickedTotal, vm, onDismiss = { paying = false })
}

// The money: how much (up to what the bills ticked owe) and how. It goes on
// the ticked bills oldest first. Cash asks what was handed over and says the change.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PaySheet(o: AccountOpen, ticked: List<String>, most: Long, vm: AccountsViewModel, onDismiss: () -> Unit) {
    val methods by vm.methods.collectAsState()
    val busy by vm.busy.collectAsState()
    var amount by remember { mutableStateOf(Money.plain(most).replace(",", "")) }
    var method by remember(methods) { mutableStateOf(methods.firstOrNull()) }
    var tendered by remember { mutableStateOf("") }
    var reference by remember { mutableStateOf("") }
    val cents = if (amount.isBlank()) 0L else Money.parseRs(amount)
    val cash = method?.kind == "cash"
    val got = if (cash && tendered.isNotBlank()) Money.parseRs(tendered) else null
    val problem = when {
        cents == null -> "Type an amount"
        else -> AccountRules.payError(cents, most)
    } ?: when {
        method == null -> "Pick how it is paid"
        cash && got != null && got < cents!! -> "Tendered is below ${Money.format(cents)}"
        else -> null
    }
    val split = if (cents != null && cents > 0) AccountRules.split(cents, o.bills.filter { it.id in ticked }.map { AccountRules.Owing(it.id, it.day, it.owed) }) else emptyList()
    val numbers = o.bills.associate { it.id to it.number }
    Sheet(onDismiss = onDismiss, width = 600.dp, top = true, gap = 14.dp) {
        SheetHead("Payment from ${o.customer?.name ?: "the customer"}", "${Money.format(most)} on the bills ticked. Less is a part payment: it goes on the oldest first.", onDismiss)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            T("Rs", 18.sp, 700, V.Text2)
            Field(amount, { amount = it.filter { c -> c.isDigit() || c == '.' }.take(10) }, "0", Modifier.weight(1f), height = 56.dp, number = true, size = 20.sp)
            VBtn("All ${Money.format(most)}", height = 56.dp, pad = 14.dp) { amount = Money.plain(most).replace(",", "") }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            methods.forEach { m -> VBtn(m.name, bg = if (m.id == method?.id) V.On else V.Key, fg = if (m.id == method?.id) V.OnText else V.Text, height = 50.dp) { method = m; tendered = "" } }
        }
        if (cash) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            T("Handed over", 15.sp, 600, V.Text2)
            Field(tendered, { tendered = it.filter { c -> c.isDigit() || c == '.' }.take(10) }, "the exact amount", Modifier.weight(1f), height = 50.dp, number = true)
            if (got != null && cents != null && got > cents) T("Change ${Money.format(got - cents)}", 15.sp, 800, V.GreenText)
        } else if (method != null) {
            Field(reference, { reference = it.take(60) }, "Reference (cheque or transfer number), if any", Modifier.fillMaxWidth(), height = 50.dp)
        }
        if (split.isNotEmpty()) T("Goes on " + split.joinToString(", ") { (id, a) -> "${numbers[id]} ${Money.format(a)}" }, 13.sp, 600, V.Text2, lines = 3)
        problem?.let { T(it, 13.sp, 600, V.RedText) }
        VBtn("Take payment", Modifier.fillMaxWidth(), V.Green, V.GreenInk, 58.dp, weight = 800, enabled = problem == null && !busy) {
            val c = cents ?: return@VBtn
            val m = method ?: return@VBtn
            vm.pay(o, ticked, AccountMoney(m.id, c, if (cash) (got ?: c) else null, if (cash) (got ?: c) - c else 0, reference.trim().ifEmpty { null }.takeIf { !cash }), onDismiss)
        }
    }
}

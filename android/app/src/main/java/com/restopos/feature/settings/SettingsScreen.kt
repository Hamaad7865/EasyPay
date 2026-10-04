package com.restopos.feature.settings

import android.content.Context
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.app.BuildConfig
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.CashOps
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffSession
import com.restopos.core.database.DayCloseEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.PaymentRow
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.DocAmount
import com.restopos.core.print.Notice
import com.restopos.core.print.PrintJob
import com.restopos.core.print.Printing
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.SyncScheduler
import com.restopos.core.sync.pushNow
import com.restopos.core.ui.HeadCell
import com.restopos.core.ui.Hairline
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import com.restopos.core.ui.Tag
import com.restopos.feature.more.MoreSheets
import com.restopos.feature.more.MoreViewModel
import com.restopos.feature.receipts.ReceiptDialog
import com.restopos.feature.receipts.ReceiptsViewModel
import com.restopos.feature.start.network
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.text.DateFormat
import java.util.Date
import javax.inject.Inject

data class TillFacts(val business: String? = null, val store: String? = null, val device: String? = null)

// A closed shift and a day closing in the list of past reports, with the
// names of who opened and closed them.
class PastShift(val shift: ShiftEntity, val openedBy: String?, val closedBy: String?)
class PastDay(val row: DayCloseEntity, val closedBy: String?)

// What Settings shows beyond the cash drawer and the closings (those are the
// side menu's, in MoreViewModel): this till and its sync, the day's payments,
// past reports, the printers and what was sent to them, and how this tablet
// is set up.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val cash: CashOps,
    private val printing: Printing,
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val approvals: Approvals,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    private fun <T> Flow<T>.held(initial: T): StateFlow<T> = stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), initial)

    val user: StateFlow<StaffMember?> = staff.current
    fun can(permission: String) = staff.can(permission)

    // Does it at once when the person signed in may; otherwise asks for
    // someone who may, and does it with their go-ahead.
    fun guard(permission: String, what: String, then: () -> Unit) {
        if (staff.can(permission)) then() else approvals.ask(permission, what) { then() }
    }

    val needsSignIn = session.needsSignIn.held(false)
    val pending = db.outbox().pendingCountFlow().held(0L)
    val rejected = db.outbox().deadCountFlow().held(0L)
    val lastPull = session.lastPull.held(null)
    val leftHanded = session.leftHanded.held(false)
    val keepAwake = session.keepAwake.held(true)
    val lightMode = session.lightMode.held(false)
    val jobs: StateFlow<List<PrintJob>> = printing.jobs
    val notices: StateFlow<List<Notice>> = printing.notices

    val shift: StateFlow<ShiftEntity?> = flow { emit(session.deviceId()) }
        .flatMapLatest { d -> if (d == null) emptyFlow() else db.staff().openShiftFlow(d) }
        .held(null)

    // this till and the moment its day started (the last day closing)
    private val day = MutableStateFlow<Pair<String, Long>?>(null)
    val payments: StateFlow<List<PaymentRow>> = day
        .flatMapLatest { d -> if (d == null) flowOf(emptyList<PaymentRow>()) else db.ops().paymentsSince(d.first, d.second) }
        .held(emptyList())

    private val _facts = MutableStateFlow(TillFacts())
    val facts: StateFlow<TillFacts> = _facts

    private val _types = MutableStateFlow<Map<String, String>>(emptyMap())
    val types: StateFlow<Map<String, String>> = _types

    private val _staffSales = MutableStateFlow<List<DocAmount>>(emptyList())
    val staffSales: StateFlow<List<DocAmount>> = _staffSales

    private val _pastShifts = MutableStateFlow<List<PastShift>>(emptyList())
    val pastShifts: StateFlow<List<PastShift>> = _pastShifts

    private val _pastDays = MutableStateFlow<List<PastDay>>(emptyList())
    val pastDays: StateFlow<List<PastDay>> = _pastDays

    // null until read, so "no printer" is not said before it is known
    private val _printers = MutableStateFlow<List<PrinterEntity>?>(null)
    val printers: StateFlow<List<PrinterEntity>?> = _printers

    // per printer, the categories whose items print on it
    private val _routes = MutableStateFlow<Map<String, List<String>>>(emptyMap())
    val routes: StateFlow<Map<String, List<String>>> = _routes

    private val _orderTypes = MutableStateFlow<List<DiningOptionEntity>>(emptyList())
    val orderTypes: StateFlow<List<DiningOptionEntity>> = _orderTypes

    // per printer, whether it answered the last time it was asked
    private val _answers = MutableStateFlow<Map<String, Boolean>>(emptyMap())
    val answers: StateFlow<Map<String, Boolean>> = _answers

    private val _checking = MutableStateFlow(false)
    val checking: StateFlow<Boolean> = _checking

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun messageShown() { _message.value = null }
    fun say(text: String) { _message.value = text }

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    private fun ids(text: String): List<String> =
        runCatching { Json.parseToJsonElement(text).jsonArray.map { it.jsonPrimitive.content } }.getOrDefault(emptyList())

    fun load() = viewModelScope.launch {
        val store = session.storeId()?.let { db.catalog().store(it) }
        val device = session.deviceId()?.let { db.catalog().device(it) }
        _facts.value = TillFacts(session.businessName(), store?.name, device?.let { if (it.name == it.code) it.code else "${it.name} (${it.code})" })
        session.deviceId()?.let { day.value = it to (db.ops().lastDayClose(it)?.closed_at ?: 0) }
        _types.value = db.ops().allPaymentTypes().associate { it.id to it.name }
        _staffSales.value = runCatching { cash.staffSales() }.getOrDefault(emptyList())
        _pastShifts.value = cash.closedShifts().map { PastShift(it, cash.employeeName(it.opened_by), cash.employeeName(it.closed_by)) }
        _pastDays.value = cash.dayCloses().map { PastDay(it, cash.employeeName(it.closed_by)) }
        val printers = printing.printers()
        val categories = db.catalog().categories().first()
        _routes.value = printers.associate { p -> p.id to categories.filter { c -> ids(c.printer_ids).contains(p.id) }.map { it.name } }
        _printers.value = printers
        _orderTypes.value = db.catalog().diningOptions()
    }

    // Asks every printer whether it answers, all at once.
    fun check() = viewModelScope.launch {
        if (_checking.value) return@launch
        _checking.value = true
        _answers.value = printing.printers().map { p -> async { p.id to printing.answers(p) } }.awaitAll().toMap()
        _checking.value = false
    }

    private fun run(block: suspend () -> String?) = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        _message.value = runCatching { block() }.getOrElse { it.message ?: "That did not work" }
        _busy.value = false
        load()
    }

    fun retry(id: Long) = run { printing.retry(id).fold({ "Sent to the printer." }, { it.message }) }
    fun clearJobs() = printing.clearJobs()
    fun clearNotices() = printing.clearNotices()

    fun printShift(s: ShiftEntity) = run { cash.printShift(s).fold({ "Sales period report sent to the printer." }, { it.message }) }
    fun printDay(row: DayCloseEntity) = run { cash.printZOf(row).fold({ "Day closing no. ${row.number} sent to the printer." }, { it.message }) }

    // Sends what is waiting and fetches what changed in the back office.
    fun sync() = run {
        if (session.needsSignIn.first()) return@run "This tablet has to be signed in again before it can sync."
        pushNow(context)
        SyncScheduler.pullNow(context)
        "Checking the back office for changes. They show here as soon as they arrive."
    }

    fun setLeftHanded(on: Boolean) = viewModelScope.launch { session.setLeftHanded(on) }
    fun setKeepAwake(on: Boolean) = viewModelScope.launch { session.setKeepAwake(on) }
    fun setLightMode(on: Boolean) = viewModelScope.launch { session.setLightMode(on) }
}

private enum class Page(val label: String) {
    Till("This till"), Notices("Notifications"), Cash("Cash drawer"), Reports("Reports"), Payments("Payments"),
    Printers("Printers"), Display("Display"), Support("Support"), Help("Help"),
}

// The menu's cards, top to bottom.
private val GROUPS = listOf(
    listOf(Page.Till, Page.Notices), listOf(Page.Cash), listOf(Page.Reports, Page.Payments),
    listOf(Page.Printers, Page.Display), listOf(Page.Support, Page.Help),
)

private fun icon(p: Page): ImageVector = when (p) {
    Page.Till -> Icons.Filled.Home
    Page.Notices -> Icons.Filled.Notifications
    Page.Cash -> PosIcons.Drawer
    Page.Reports -> PosIcons.Chart
    Page.Payments -> PosIcons.Card
    Page.Printers -> PosIcons.Print
    Page.Display -> PosIcons.Screen
    Page.Support -> PosIcons.Headset
    Page.Help -> PosIcons.Help
}

private val Shape = RoundedCornerShape(6.dp)
private val stamp: DateFormat get() = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
private val clock: DateFormat get() = DateFormat.getTimeInstance(DateFormat.SHORT)

// Something that needs someone's attention for as long as it is true.
private class Standing(val title: String, val detail: String, val button: String, val onClick: () -> Unit)

// The things done to the cash drawer.
private class CashKeys(val cashIn: () -> Unit, val cashOut: () -> Unit, val open: () -> Unit, val count: () -> Unit, val close: () -> Unit)

// Settings: a menu down the left, the chosen page on the right. Everything a
// cashier or a manager does to this till that is not taking an order: the
// cash drawer, the reports and the closings, the day's payments, the
// printers, how the tablet is set up, and help.
@Composable
fun SettingsScreen(
    more: MoreViewModel,
    lock: String,
    onLock: () -> Unit,
    onSignIn: () -> Unit,
    onRejected: () -> Unit,
    onClosePeriod: () -> Unit,
    onCountDrawer: () -> Unit,
    onSignOut: () -> Unit,
    vm: SettingsViewModel = hiltViewModel(),
    receipts: ReceiptsViewModel = hiltViewModel(),
) {
    var page by rememberSaveable { mutableStateOf(Page.Till) }
    // the cash and day closing dialogs, the same ones the side menu opens
    var sheet by remember { mutableStateOf<String?>(null) }
    val said by vm.message.collectAsState()
    val receiptSaid by receipts.message.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val rejected by vm.rejected.collectAsState()
    val shift by vm.shift.collectAsState()
    val printers by vm.printers.collectAsState()
    val jobs by vm.jobs.collectAsState()
    val notices by vm.notices.collectAsState()
    val context = LocalContext.current
    val network by produceState(initialValue = network(context)) {
        while (true) { delay(5000); value = network(context) }
    }

    LaunchedEffect(page) { vm.load(); more.load() }
    LaunchedEffect(Unit) { vm.check() }
    said?.let { m -> LaunchedEffect(m) { delay(5000); vm.messageShown() } }
    receiptSaid?.let { m -> LaunchedEffect(m) { delay(4000); receipts.messageShown() } }

    // each of these asks for someone else's PIN if the person signed in may not do it
    val keys = CashKeys(
        cashIn = { sheet = "in" },
        cashOut = { sheet = "out" },
        open = { more.openDrawer() },
        count = { if (shift == null) vm.say("No sales period is open.") else onCountDrawer() },
        close = { if (shift == null) vm.say("No sales period is open.") else onClosePeriod() },
    )
    val failed = jobs.count { it.error != null }
    val standing = buildList {
        if (needsSignIn) add(Standing("This tablet cannot sync", "Its login was signed out or switched off. Sales are saved here until someone signs in.", "Sign in", onSignIn))
        if (rejected > 0) add(Standing("$rejected changes were refused by the server", "They are kept on this tablet until someone has looked at them.", "Review", onRejected))
        if (pending > 0 && !needsSignIn) add(Standing("$pending changes are waiting to be sent", "They go as soon as there is a connection.", "Sync now") { vm.sync() })
        val list = printers
        if (list != null && list.isEmpty()) {
            add(Standing("No printer is set up", "Nothing can print: no receipts, no kitchen tickets. Printers are added in the back office.", "Printers") { page = Page.Printers })
        } else if (list != null && list.none { it.is_receipt }) {
            add(Standing("No receipt printer", "Receipts, bills and reports have nowhere to print, and the drawer cannot open.", "Printers") { page = Page.Printers })
        }
        if (failed > 0) add(Standing("$failed print ${if (failed == 1) "job" else "jobs"} failed", "See what did not print and send it again.", "Printers") { page = Page.Printers })
    }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Row(Modifier.fillMaxSize()) {
            Menu(page, lock, standing.size + notices.size, onPick = { page = it }, onLock = onLock)
            Column(Modifier.weight(1f).fillMaxHeight()) {
                Text(
                    page.label, Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 12.dp),
                    color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center,
                )
                // each page starts at its own top
                key(page) {
                    Column(
                        Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 20.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        when (page) {
                            Page.Till -> TillPage(vm, keys, network, onSignIn, onRejected) { page = it }
                            Page.Notices -> NoticesPage(vm, standing)
                            Page.Cash -> CashPage(vm, more, keys)
                            Page.Reports -> ReportsPage(vm, more, keys.close) { sheet = "day" }
                            Page.Payments -> PaymentsPage(vm) { receipts.showId(it) }
                            Page.Printers -> PrintersPage(vm, more)
                            Page.Display -> DisplayPage(vm)
                            Page.Support -> SupportPage(vm, network, onSignIn, onRejected, onSignOut)
                            Page.Help -> HelpPage()
                        }
                    }
                }
            }
        }
        (said ?: receiptSaid)?.let { m ->
            Text(
                m,
                Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(Shape).background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    MoreSheets(more, sheet, onDismiss = { sheet = null; vm.load() }, onCloseShift = onClosePeriod)
    ReceiptDialog(receipts)
}

@Composable
private fun Menu(page: Page, lock: String, waiting: Int, onPick: (Page) -> Unit, onLock: () -> Unit) {
    Column(
        Modifier.width(250.dp).fillMaxHeight().background(Pos.Panel).verticalScroll(rememberScrollState()).padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.fillMaxWidth().height(42.dp).clip(Shape).background(Pos.Key).clickable(onClick = onLock), contentAlignment = Alignment.Center) {
            Text(lock, color = Pos.Pink, fontSize = 15.sp)
        }
        GROUPS.forEach { group ->
            Column(Modifier.fillMaxWidth().clip(Shape).background(Pos.Key)) {
                group.forEach { p ->
                    val on = p == page
                    Row(
                        Modifier.fillMaxWidth().height(42.dp).background(if (on) Pos.Selected else Color.Transparent).clickable { onPick(p) }.padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(icon(p), contentDescription = null, tint = if (on) Pos.Link else Pos.Text2, modifier = Modifier.size(18.dp))
                        Text(p.label, Modifier.weight(1f).padding(start = 12.dp), color = if (on) Pos.Link else Pos.Text, fontSize = 15.sp, maxLines = 1)
                        if (p == Page.Notices && waiting > 0) {
                            Box(Modifier.size(20.dp).clip(CircleShape).background(Pos.Pink), contentAlignment = Alignment.Center) {
                                Text(if (waiting > 9) "9+" else waiting.toString(), color = Color.White, fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---- the pages ----

@Composable
private fun TillPage(vm: SettingsViewModel, keys: CashKeys, network: String, onSignIn: () -> Unit, onRejected: () -> Unit, onGo: (Page) -> Unit) {
    val user by vm.user.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val rejected by vm.rejected.collectAsState()
    val lastPull by vm.lastPull.collectAsState()
    val shift by vm.shift.collectAsState()
    val printers by vm.printers.collectAsState()
    val answers by vm.answers.collectAsState()

    Text(
        "Signed in: " + (user?.let { it.employee.name + (it.role?.let { r -> " · $r" } ?: "") } ?: "nobody (this till does not use staff PINs)"),
        Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).background(Pos.Panel).border(1.dp, Pos.Text3, RoundedCornerShape(4.dp)).padding(horizontal = 14.dp, vertical = 10.dp),
        color = Pos.Link, fontSize = 14.sp,
    )
    Heading("Quick actions")
    CashActions(keys)
    Heading("Status")
    when {
        needsSignIn -> StatusRow(PosIcons.Signal, "This device", "It cannot sync until someone signs in. Sales are saved here in the meantime.", Pos.Pink, "Sign in", onSignIn)
        pending > 0 -> StatusRow(PosIcons.Signal, "This device", "$pending changes are waiting to be sent", Pos.Warn, "Reload device") { vm.sync() }
        else -> StatusRow(
            PosIcons.Signal, "This device", "Device is up to date" + (lastPull?.let { ", checked at ${clock.format(Date(it))}" } ?: ""),
            Pos.Ok, "Reload device",
        ) { vm.sync() }
    }
    if (rejected > 0) StatusRow(Icons.Filled.Warning, "Refused changes", "$rejected changes were refused by the server and need a look", Pos.Pink, "Review", onRejected)
    StatusRow(
        PosIcons.Clock, "Sales period",
        shift?.let { "Open since ${stamp.format(Date(it.opened_at))}, opened with ${Money.format(it.opening_float)} in the drawer" }
            ?: "No sales period is open. One opens when someone clocks in and counts the drawer.",
        button = "Cash drawer",
    ) { onGo(Page.Cash) }
    val list = printers
    val silent = list.orEmpty().filter { answers[it.id] == false }
    StatusRow(
        PosIcons.Print, "Printers",
        when {
            list == null -> "Looking…"
            list.isEmpty() -> "No printer is set up"
            silent.isNotEmpty() -> silent.joinToString(", ") { it.name } + (if (silent.size == 1) " is" else " are") + " not answering"
            else -> "${list.size} set up. " + (list.firstOrNull { it.is_receipt }?.let { "Receipts print on ${it.name}." } ?: "None of them prints receipts.")
        },
        if (list != null && (list.isEmpty() || silent.isNotEmpty() || list.none { it.is_receipt })) Pos.Warn else Pos.Text2,
        "Printers",
    ) { onGo(Page.Printers) }
    StatusRow(PosIcons.Screen, "Network", network)
}

@Composable
private fun NoticesPage(vm: SettingsViewModel, standing: List<Standing>) {
    val notices by vm.notices.collectAsState()
    if (standing.isEmpty() && notices.isEmpty()) {
        Panel { Text("Nothing needs attention.", color = Pos.Text, fontSize = 15.sp) }
    }
    standing.forEach { StatusRow(Icons.Filled.Warning, it.title, it.detail, Pos.Warn, it.button, it.onClick) }
    if (notices.isNotEmpty()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Heading("Earlier, from the printers", Modifier.weight(1f))
            Small("Clear") { vm.clearNotices() }
        }
        Panel {
            notices.forEach { n ->
                Row(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
                    Text(clock.format(Date(n.time)), Modifier.width(78.dp), color = Pos.Text3, fontSize = 13.sp)
                    Text(n.text, Modifier.weight(1f), color = Pos.Text, fontSize = 14.sp)
                }
            }
        }
    }
}

@Composable
private fun CashPage(vm: SettingsViewModel, more: MoreViewModel, keys: CashKeys) {
    val last by more.shift.collectAsState()
    // only the shift that is open now: a closed one's cash is in Reports
    val open = last?.takeIf { it.first.closed_at == null }
    val reports = vm.can("shift.view_report")

    CashActions(keys)
    Note("Cash in and cash out each print a slip for the drawer. Count drawer is for a handover: it records what is in the drawer and how that compares, prints a slip to sign, and the sales period stays open. Close sales period is the same count and ends the sales period. The day is closed under Reports.")
    Heading("This sales period")
    Panel {
        if (open == null) {
            Text("No sales period is open. One opens when someone clocks in and counts the drawer.", color = Pos.Text, fontSize = 14.sp)
        } else {
            val d = open.second
            Text("${d.openedBy ?: "This till"}, since ${stamp.format(Date(d.openedAt))}", Modifier.padding(bottom = 6.dp), color = Pos.Text2, fontSize = 13.sp)
            Figure("Opening float", Money.format(d.float))
            // what the drawer should hold is kept from someone who counts it blind
            if (reports) {
                Figure("Cash taken", Money.format(d.cashTaken))
                Figure("Cash in", Money.format(d.cashIn))
                Figure("Cash out", Money.format(-d.cashOut))
                Figure("Expected in the drawer", Money.format(d.expected), bold = true)
            } else {
                Note("What the drawer should hold shows after it has been counted.")
            }
        }
    }
    val counts = open?.second?.counts.orEmpty()
    if (counts.isNotEmpty()) {
        Heading("Drawer counts this sales period")
        Panel {
            counts.forEach { c ->
                Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Counted ${Money.format(c.counted)}", color = Pos.Text, fontSize = 15.sp)
                        Text(clock.format(Date(c.time)) + (c.user?.let { " · $it" } ?: ""), color = Pos.Text3, fontSize = 13.sp)
                    }
                    val diff = c.counted - c.expected
                    if (reports) Tag(if (diff == 0L) "As expected" else if (diff < 0) "${Money.format(-diff)} short" else "${Money.format(diff)} over", if (diff == 0L) Pos.Ok else Pos.Pink)
                }
            }
        }
    }
    Heading("Cash in and out this sales period")
    Panel {
        val moves = open?.second?.moves.orEmpty()
        if (moves.isEmpty()) Note("None.")
        moves.forEach { m ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(m.reason ?: "No reason given", color = Pos.Text, fontSize = 15.sp)
                    Text(clock.format(Date(m.time)) + (m.user?.let { " · $it" } ?: ""), color = Pos.Text3, fontSize = 13.sp)
                }
                Tag(if (m.type == "in") "Cash in" else "Cash out", if (m.type == "in") Pos.Ok else Pos.Warn)
                Text(
                    Money.format(if (m.type == "in") m.amount else -m.amount), Modifier.width(120.dp),
                    color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End,
                )
            }
        }
    }
}

@Composable
private fun ReportsPage(vm: SettingsViewModel, more: MoreViewModel, onCloseShift: () -> Unit, onCloseDay: () -> Unit) {
    var shown by remember { mutableStateOf(false) }
    if (!vm.can("shift.view_report") && !shown) {
        Locked("Reports are for people allowed to see them.") { vm.guard("shift.view_report", "see the reports") { shown = true } }
        return
    }
    var tab by rememberSaveable { mutableStateOf(0) }
    val last by more.shift.collectAsState()
    val day by more.day.collectAsState()
    val busy by more.busy.collectAsState()
    val working by vm.busy.collectAsState()
    val staffSales by vm.staffSales.collectAsState()
    val pastShifts by vm.pastShifts.collectAsState()
    val pastDays by vm.pastDays.collectAsState()

    Seg(listOf("Sales period", "Day so far", "Closed"), tab) { tab = it }
    when (tab) {
        0 -> {
            val s = last
            if (s == null) {
                Panel { Text("No sales period has been opened on this till yet.", color = Pos.Text, fontSize = 14.sp) }
            } else {
                val (row, d) = s
                Panel {
                    Text(
                        "${d.openedBy ?: "This till"}, since ${stamp.format(Date(d.openedAt))}" + (d.closedAt?.let { ", closed ${stamp.format(Date(it))}" } ?: ", still open"),
                        Modifier.padding(bottom = 6.dp), color = Pos.Text2, fontSize = 13.sp,
                    )
                    Figure("Receipts", d.sales.toString())
                    Figure("Sales", Money.format(d.gross))
                    if (d.refunds > 0) Figure("Refunds (${d.refunds})", Money.format(-d.refunded))
                    if (d.discounts > 0) Figure("Discounts given", Money.format(d.discounts))
                    d.payments.forEach { Figure("${it.name} (${it.count})", Money.format(it.amount)) }
                    Hairline(Modifier.padding(vertical = 6.dp))
                    Figure("Opening float", Money.format(d.float))
                    Figure("Cash taken", Money.format(d.cashTaken))
                    Figure("Cash in", Money.format(d.cashIn))
                    Figure("Cash out", Money.format(-d.cashOut))
                    Figure("Expected in the drawer", Money.format(d.expected), bold = true)
                    d.counted?.let {
                        Figure("Counted", Money.format(it))
                        Figure("Difference", Money.format(it - d.expected), bold = true)
                    }
                    if (d.counts.isNotEmpty()) {
                        Hairline(Modifier.padding(vertical = 6.dp))
                        d.counts.forEach { c ->
                            Figure("Counted at ${clock.format(Date(c.time))}" + (c.user?.let { " by $it" } ?: ""), "${Money.format(c.counted)} (${Money.format(c.counted - c.expected)})")
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Action(if (busy) "Printing…" else "Print report") { more.printShift() }
                    if (row.closed_at == null) Action("Close sales period", primary = true, onClick = onCloseShift)
                }
            }
        }
        1 -> {
            val z = day
            if (z == null) {
                Panel { Text("Nothing to report yet.", color = Pos.Text, fontSize = 14.sp) }
            } else {
                Panel {
                    Text(
                        "Since ${z.from?.let { stamp.format(Date(it)) } ?: "the first sale"}. Closing it makes day closing no. ${z.number}.",
                        Modifier.padding(bottom = 6.dp), color = Pos.Text2, fontSize = 13.sp,
                    )
                    Figure("Receipts", z.sales.toString())
                    Figure("Sales", Money.format(z.gross))
                    Figure("Refunds (${z.refunds})", Money.format(-z.refunded))
                    if (z.discounts > 0) Figure("Discounts given", Money.format(z.discounts))
                    Figure("Tax in the sales", Money.format(z.tax))
                    Figure("Total", Money.format(z.gross - z.refunded), bold = true)
                    Hairline(Modifier.padding(vertical = 6.dp))
                    z.payments.forEach { Figure("${it.name} (${it.count})", Money.format(it.amount)) }
                    Figure("Cash in", Money.format(z.cashIn))
                    Figure("Cash out", Money.format(-z.cashOut))
                }
                if (z.categories.isNotEmpty()) {
                    Heading("By category")
                    Panel { z.categories.forEach { Figure("${it.name} (${it.count})", Money.format(it.amount)) } }
                }
                if (staffSales.isNotEmpty()) {
                    Heading("By staff")
                    Panel { staffSales.forEach { Figure("${it.name} (${it.count} ${if (it.count == 1) "receipt" else "receipts"})", Money.format(it.amount)) } }
                }
                Row(Modifier.fillMaxWidth()) { Action("Close the day and print", primary = true, onClick = onCloseDay) }
                Note("Closing the day fixes these figures, prints the report and starts a new day. The sales period has to be closed first, and every order paid.")
            }
        }
        else -> {
            Heading("Sales periods")
            Panel {
                if (pastShifts.isEmpty()) Note("No sales period has been closed on this till yet.")
                pastShifts.forEach { p ->
                    val s = p.shift
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("${stamp.format(Date(s.opened_at))} to ${s.closed_at?.let { stamp.format(Date(it)) } ?: ""}", color = Pos.Text, fontSize = 15.sp)
                            Text(
                                listOfNotNull(
                                    p.openedBy?.let { "Opened by $it" }, p.closedBy?.let { "closed by $it" },
                                    s.counted_cash?.let { "counted ${Money.format(it)}" },
                                    s.counted_cash?.let { c -> s.expected_cash?.let { e -> "difference ${Money.format(c - e)}" } },
                                ).joinToString(", "),
                                color = Pos.Text3, fontSize = 13.sp,
                            )
                        }
                        Small("Print", enabled = !working) { vm.printShift(s) }
                    }
                }
            }
            Heading("Day closings")
            Panel {
                if (pastDays.isEmpty()) Note("The day has not been closed on this till yet.")
                pastDays.forEach { p ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Day closing no. ${p.row.number}", color = Pos.Text, fontSize = 15.sp)
                            Text("Closed ${stamp.format(Date(p.row.closed_at))}" + (p.closedBy?.let { " by $it" } ?: ""), color = Pos.Text3, fontSize = 13.sp)
                        }
                        Small("Print again", enabled = !working) { vm.printDay(p.row) }
                    }
                }
            }
        }
    }
}

@Composable
private fun PaymentsPage(vm: SettingsViewModel, onOpen: (String) -> Unit) {
    var shown by remember { mutableStateOf(false) }
    if (!vm.can("receipts.view_all") && !shown) {
        Locked("The day's payments are for people allowed to see every receipt.") { vm.guard("receipts.view_all", "see the day's payments") { shown = true } }
        return
    }
    val rows by vm.payments.collectAsState()
    val types by vm.types.collectAsState()
    if (rows.isEmpty()) {
        Panel { Text("No payment has been taken on this till since the last day closing.", color = Pos.Text, fontSize = 14.sp) }
        return
    }
    fun signed(r: PaymentRow) = if (r.type == "refund") -r.amount else r.amount
    val totals = rows.groupBy { types[it.payment_type_id] ?: "Other" }.map { (name, list) -> DocAmount(name, list.sumOf { signed(it) }, list.size) }.sortedByDescending { it.amount }
    Panel {
        totals.forEach { Figure("${it.name} (${it.count})", Money.format(it.amount)) }
        Hairline(Modifier.padding(vertical = 6.dp))
        Figure("Total", Money.format(totals.sumOf { it.amount }), bold = true)
    }
    Column(Modifier.fillMaxWidth().clip(Shape).background(Pos.Panel)) {
        Row(Modifier.fillMaxWidth().background(Pos.PanelDeep).padding(horizontal = 6.dp)) {
            HeadCell("Time", 1f)
            HeadCell("Receipt", 1.7f)
            HeadCell("Paid by", 1.3f)
            HeadCell("Amount", 1f, end = true)
        }
        rows.take(200).forEach { r ->
            Row(Modifier.fillMaxWidth().clickable { onOpen(r.receipt_id) }.height(46.dp).padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(clock.format(Date(r.device_time)), Modifier.weight(1f).padding(horizontal = 8.dp), color = Pos.Text, fontSize = 14.sp, maxLines = 1)
                Text(r.number, Modifier.weight(1.7f).padding(horizontal = 8.dp), color = Pos.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                Row(Modifier.weight(1.3f).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(types[r.payment_type_id] ?: "Other", color = Pos.Text, fontSize = 14.sp, maxLines = 1)
                    if (r.type == "refund") Box(Modifier.padding(start = 8.dp)) { Tag("Refund", Pos.Pink) }
                }
                Text(
                    Money.format(signed(r)), Modifier.weight(1f).padding(horizontal = 8.dp),
                    color = Pos.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End, maxLines = 1,
                )
            }
            Hairline()
        }
    }
    Note(
        (if (rows.size > 200) "The latest 200 of ${rows.size} payments. " else "") +
            "Payments taken on this till since the last day closing. Tap one to see its receipt, print it again, refund it or correct how it was paid.",
    )
}

@Composable
private fun PrintersPage(vm: SettingsViewModel, more: MoreViewModel) {
    val printers by vm.printers.collectAsState()
    val routes by vm.routes.collectAsState()
    val answers by vm.answers.collectAsState()
    val checking by vm.checking.collectAsState()
    val orderTypes by vm.orderTypes.collectAsState()
    val jobs by vm.jobs.collectAsState()
    val busy by more.busy.collectAsState()
    val working by vm.busy.collectAsState()

    Row(verticalAlignment = Alignment.CenterVertically) {
        Note("The tablet prints straight to each printer, over the network or a USB cable.", Modifier.weight(1f))
        Small(if (checking) "Checking…" else "Check again", enabled = !checking) { vm.check() }
    }
    val list = printers
    if (list != null && list.isEmpty()) {
        Panel { Text("No printer is set up. Add them in the back office, under Printers; they arrive here with the next sync.", color = Pos.Text, fontSize = 14.sp) }
    }
    list.orEmpty().forEach { p ->
        val usb = p.kind == "usb"
        val up = answers[p.id]
        val cats = routes[p.id].orEmpty()
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(p.name, color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        when (up) {
                            null -> Tag("Checking", Pos.Text3, dot = true)
                            true -> Tag(if (usb) "Plugged in" else "Connected", Pos.Ok, dot = true)
                            else -> Tag(if (usb) "Not plugged in" else "Not answering", Pos.Pink, dot = true)
                        }
                    }
                    Text("${if (usb) "USB" else p.address ?: "no address"} · ${p.paper_mm} mm paper", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp)
                    Text(
                        listOfNotNull(
                            "Receipts, bills, reports and the cash drawer".takeIf { p.is_receipt },
                            cats.takeIf { it.isNotEmpty() }?.let { "Kitchen tickets for ${it.joinToString(", ")}" },
                        ).joinToString(". ").ifEmpty { "Nothing is sent here yet: tick it on a category in the back office" } + ".",
                        Modifier.padding(top = 2.dp), color = Pos.Text2, fontSize = 13.sp,
                    )
                }
                Small("Test print", enabled = !busy) { more.testPrint(p.id) }
            }
        }
    }
    if (orderTypes.isNotEmpty()) {
        Heading("When an order goes to the kitchen")
        Panel {
            orderTypes.forEach {
                Figure(it.name, when (it.kitchen) { "save" -> "When it is saved"; "pay" -> "When it is paid"; else -> "Never" })
            }
            Note("Set per order type in the back office, under POS settings.")
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Heading("Print jobs", Modifier.weight(1f))
        if (jobs.isNotEmpty()) Small("Clear") { vm.clearJobs() }
    }
    Panel {
        if (jobs.isEmpty()) Note("Nothing has been sent to a printer since the app was opened.")
        jobs.forEach { j ->
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Text(j.what, color = Pos.Text, fontSize = 15.sp)
                    Text("${clock.format(Date(j.time))} · ${j.printer.name}", color = Pos.Text3, fontSize = 13.sp)
                    j.error?.let { Text(it, color = Pos.Pink, fontSize = 13.sp) }
                    if (j.error != null && j.what.startsWith("Kitchen ticket")) {
                        Text("Open the order and tap Save: what did not print goes to the kitchen again.", color = Pos.Text2, fontSize = 13.sp)
                    }
                }
                when {
                    j.error == null -> Tag("Printed", Pos.Ok)
                    j.again != null -> Small("Try again", enabled = !working) { vm.retry(j.id) }
                    else -> Tag("Failed", Pos.Pink)
                }
            }
        }
    }
}

@Composable
private fun DisplayPage(vm: SettingsViewModel) {
    val leftHanded by vm.leftHanded.collectAsState()
    val keepAwake by vm.keepAwake.collectAsState()
    val lightMode by vm.lightMode.collectAsState()
    val change = "change how this till is set up"
    Toggle("Light mode", "A pale screen with dark text, for a bright room or a terrace. Off is the dark screen.", lightMode) { vm.guard("settings.device", change) { vm.setLightMode(it) } }
    Toggle("Left-handed register", "The order and the keypad move to the right, the menu to the left.", leftHanded) { vm.guard("settings.device", change) { vm.setLeftHanded(it) } }
    Toggle("Keep the screen on", "The tablet does not go to sleep while RestoPOS is open.", keepAwake) { vm.guard("settings.device", change) { vm.setKeepAwake(it) } }
    Note("These are for this tablet only.")
}

@Composable
private fun SupportPage(vm: SettingsViewModel, network: String, onSignIn: () -> Unit, onRejected: () -> Unit, onSignOut: () -> Unit) {
    val facts by vm.facts.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val rejected by vm.rejected.collectAsState()
    val lastPull by vm.lastPull.collectAsState()

    Note("What to have at hand when asking for help with this till.")
    Panel {
        Figure("Business", facts.business ?: "—")
        Figure("Store", facts.store ?: "—")
        Figure("Till", facts.device ?: "Not set up")
        Figure("Version", "RestoPOS ${BuildConfig.VERSION_NAME}")
        Figure("Tablet", "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}")
        Figure("Network", network)
        Figure("Last heard from the back office", lastPull?.let { stamp.format(Date(it)) } ?: "Not yet")
        Figure("Changes waiting to be sent", pending.toString())
        Figure("Changes the server refused", rejected.toString())
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (needsSignIn) Action("Sign in", primary = true, onClick = onSignIn) else Action("Sync now") { vm.sync() }
        Action(if (rejected > 0) "Refused changes ($rejected)" else "Refused changes", onClick = onRejected)
    }
    Heading("Sign out of this tablet")
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Note(
                "Unlinks the tablet from the restaurant and clears the menu and the receipt list from it. Sales already sent stay in the back office. " +
                    "It is refused while a sale is waiting to be sent or an order is unpaid.",
                Modifier.weight(1f).padding(end = 12.dp),
            )
            Small("Sign out", color = Pos.Pink) { vm.guard("settings.device", "sign this tablet out", onSignOut) }
        }
    }
}

private val HELP = listOf(
    "Starting the day" to "Tap Clock in/out, pick your name and enter your PIN. If no sales period is open you count the cash in the drawer first; that opens the sales period.",
    "Taking an order" to "Tap New order and choose the order type. Pick the table if it asks for one, then tap the items. Save sends what is new to the kitchen and puts the order away; it is back under Orders or on its table.",
    "Taking payment" to "Open the order and tap Pay. Pick how it is paid. For cash, type what the guest gave to see the change. The receipt prints and the order closes.",
    "Splitting the bill" to "Split check moves items onto separate checks, and each check is paid on its own. To share one bill evenly, tap Pay and choose how many guests are paying.",
    "Taking an item off" to "Tap the line on the order. Before it has gone to the kitchen it is simply removed. After that it is a void: the kitchen gets a void ticket, and it needs someone allowed to void.",
    "A refund, or the wrong payment type" to "Under Receipts, tap the receipt. Refund gives the whole receipt back. Change corrects how it was paid without changing the amount.",
    "When you are not allowed to" to "A refund, a void after the kitchen has it, opening the drawer and the like may need a manager. The till asks who approves: they tap their name and enter their own PIN, and it is done in your name with their approval on record.",
    "Handing the drawer to someone else" to "Settings, Cash drawer, Count drawer. Count the cash and enter it: the till shows how it compares, prints a slip for both of you to sign, and the sales period carries on.",
    "Cash in and cash out" to "Settings, Cash drawer. Type the amount and what it is for. A slip prints for the drawer and it shows on the sales period report.",
    "Ending the day" to "Take payment for every open order. Under Settings, Cash drawer, tap Close sales period and count the cash. Then Reports, Day so far, Close the day and print.",
    "A printer does not print" to "Settings, Printers. Check the printer says Connected and try a test print. A failed receipt or report has Try again next to it. A kitchen ticket goes again when you open the order and tap Save.",
    "No internet" to "Keep selling. Everything is saved on the tablet and sent by itself when the connection is back. Printing does not need the internet, only the local network.",
)

@Composable
private fun HelpPage() {
    HELP.forEach { (title, text) ->
        Panel {
            Text(title, Modifier.padding(bottom = 3.dp), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(text, color = Pos.Text2, fontSize = 14.sp, lineHeight = 20.sp)
        }
    }
}

// ---- the pieces the pages are built from ----

@Composable
private fun Heading(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier.padding(top = 8.dp), color = Pos.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
}

@Composable
private fun Note(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, color = Pos.Text3, fontSize = 13.sp, lineHeight = 18.sp)
}

@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().clip(Shape).background(Pos.Panel).padding(horizontal = 14.dp, vertical = 12.dp), content = content)
}

@Composable
private fun Figure(label: String, value: String, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
        Text(label, Modifier.weight(1f), color = if (bold) Pos.Text else Pos.Text2, fontSize = 14.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal)
        Text(value, color = Pos.Text, fontSize = 14.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium)
    }
}

// A wide key: one of a row of things to do.
@Composable
private fun RowScope.Action(label: String, primary: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.weight(1f).height(48.dp).clip(Shape).background(if (primary) Pos.TabOn else Pos.Key).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (primary) Color.White else Pos.Link, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1) }
}

// A small key at the end of a row.
@Composable
private fun Small(label: String, color: Color = Pos.Link, enabled: Boolean = true, onClick: () -> Unit) {
    Text(
        label, Modifier.clip(Shape).background(Pos.Key).clickable(enabled = enabled, onClick = onClick).padding(horizontal = 16.dp, vertical = 9.dp),
        color = if (enabled) color else Pos.Text3, fontSize = 14.sp, maxLines = 1,
    )
}

@Composable
private fun CashActions(keys: CashKeys) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Action("Cash in", onClick = keys.cashIn)
        Action("Cash out", onClick = keys.cashOut)
        Action("Open drawer", onClick = keys.open)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Action("Count drawer", onClick = keys.count)
        Action("Close sales period", primary = true, onClick = keys.close)
    }
}

// One line of the till's state: what it is, how it is, and what to do about it.
@Composable
private fun StatusRow(icon: ImageVector, title: String, detail: String, tone: Color = Pos.Text2, button: String? = null, onClick: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().clip(Shape).background(Pos.Panel).padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = tone, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f).padding(horizontal = 14.dp)) {
            Text(title, color = Pos.Text, fontSize = 15.sp)
            Text(detail, color = if (tone == Pos.Pink || tone == Pos.Warn) tone else Pos.Text3, fontSize = 13.sp)
        }
        if (button != null) Small(button, onClick = onClick)
    }
}

@Composable
private fun Seg(options: List<String>, selected: Int, onPick: (Int) -> Unit) {
    Row {
        Row(Modifier.clip(Shape).background(Pos.Panel).padding(3.dp)) {
            options.forEachIndexed { i, o ->
                val on = i == selected
                Text(
                    o, Modifier.clip(RoundedCornerShape(4.dp)).background(if (on) Pos.Selected else Color.Transparent).clickable { onPick(i) }.padding(horizontal = 18.dp, vertical = 8.dp),
                    color = if (on) Pos.Text else Pos.Text2, fontSize = 14.sp, fontWeight = if (on) FontWeight.Medium else FontWeight.Normal,
                )
            }
        }
    }
}

// A page someone may not open, with the way in: someone who may, and their PIN.
@Composable
private fun Locked(text: String, onAsk: () -> Unit) {
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(text, Modifier.weight(1f).padding(end = 12.dp), color = Pos.Text, fontSize = 14.sp)
            Small("Open with an approval", onClick = onAsk)
        }
    }
}

@Composable
private fun Toggle(title: String, detail: String, on: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clip(Shape).background(Pos.Panel).padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 12.dp)) {
            Text(title, color = Pos.Text, fontSize = 15.sp)
            Text(detail, color = Pos.Text3, fontSize = 13.sp)
        }
        Switch(checked = on, onCheckedChange = onChange)
    }
}

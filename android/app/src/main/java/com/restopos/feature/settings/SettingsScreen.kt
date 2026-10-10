package com.restopos.feature.settings

import android.content.Context
import android.os.Build
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
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
import com.restopos.core.data.PosSettings
import com.restopos.core.data.Routing
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
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Hairline
import com.restopos.core.ui.HeadCell
import com.restopos.core.ui.Motion
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.T
import com.restopos.core.ui.Tag
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.press
import com.restopos.core.ui.quietTap
import com.restopos.feature.more.MoreSheets
import com.restopos.feature.more.MoreViewModel
import com.restopos.feature.receipts.ReceiptDialog
import com.restopos.feature.receipts.ReceiptsViewModel
import com.restopos.feature.retail.LabelPrinterSheet
import com.restopos.feature.retail.LabelPrinterViewModel
import com.restopos.feature.retail.labelConnection
import com.restopos.feature.start.network
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import java.text.DateFormat
import java.util.Date
import javax.inject.Inject
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
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

data class TillFacts(val business: String? = null, val store: String? = null, val device: String? = null)

// A closed day's drawer and its closing in the list of past reports, with the
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
    private val screenLink: com.restopos.core.kitchen.ScreenLink,
    private val door: com.restopos.core.data.SetupDoor,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    private fun <T> Flow<T>.held(initial: T): StateFlow<T> = stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), initial)

    // The kitchen screens of this store (tablets in the kitchen that show the
    // orders: back office, Printers), each with what it shows; and how each
    // stands with this till: answering or not, and how many orders wait for it.
    class KitchenScreen(val row: PrinterEntity, val shows: String)
    private val _screens = MutableStateFlow<List<KitchenScreen>>(emptyList())
    val screens: StateFlow<List<KitchenScreen>> = _screens
    val screenStatus: StateFlow<Map<String, com.restopos.core.kitchen.ScreenStatus>> = screenLink.status().held(emptyMap())
    private val _testing = MutableStateFlow<String?>(null)
    val testing: StateFlow<String?> = _testing
    // asks a screen now and says in words how it answered
    fun testScreen(id: String) = viewModelScope.launch {
        if (_testing.value != null) return@launch
        _testing.value = id
        com.restopos.core.ui.Toaster.say(runCatching { screenLink.test(id) }.getOrElse { "That did not work: ${it.message}" })
        _testing.value = null
    }

    // ---- the scanners added on this tablet (Settings, Scanners) ----
    // A scanner that types what it reads (USB, or Bluetooth as a keyboard)
    // works without being added. Adding it tells the till which device it is:
    // the page is open, a barcode is scanned, and the device the keys came
    // from is the scanner.
    val scanners: StateFlow<List<com.restopos.core.common.AddedScanner>> = session.scanners.held(emptyList())
    // the devices joined to the tablet at this moment, by the name Android keeps for each
    private val _joined = MutableStateFlow<Set<String>>(emptySet())
    val joined: StateFlow<Set<String>> = _joined
    // what was last read while the page listened, and from which device
    class ScanRead(val key: String, val name: String, val link: String, val code: String)
    private val _scanRead = MutableStateFlow<ScanRead?>(null)
    val scanRead: StateFlow<ScanRead?> = _scanRead
    private val inputs get() = context.getSystemService(android.hardware.input.InputManager::class.java)
    private fun devices(): List<android.view.InputDevice> = android.view.InputDevice.getDeviceIds().toList().mapNotNull { android.view.InputDevice.getDevice(it) }.filter { !it.isVirtual }
    private val plugged = object : android.hardware.input.InputManager.InputDeviceListener {
        override fun onInputDeviceAdded(deviceId: Int) = lookForScanners()
        override fun onInputDeviceRemoved(deviceId: Int) = lookForScanners()
        override fun onInputDeviceChanged(deviceId: Int) = lookForScanners()
    }
    fun lookForScanners() { _joined.value = runCatching { devices().map { it.descriptor }.toSet() }.getOrDefault(emptySet()) }
    // The page is on show: it is told of every scan, and of a scanner plugged in or taken away.
    fun listenForScans() {
        lookForScanners()
        _scanRead.value = null
        runCatching { inputs?.registerInputDeviceListener(plugged, null) }
        com.restopos.core.common.Scanner.listener = { key, code ->
            val device = runCatching { devices().firstOrNull { it.descriptor == key } }.getOrNull()
            _scanRead.value = ScanRead(key, device?.name?.trim().orEmpty().ifEmpty { "Scanner" }, linkOf(device), code)
        }
    }
    fun stopListeningForScans() {
        com.restopos.core.common.Scanner.stopListening()
        runCatching { inputs?.unregisterInputDeviceListener(plugged) }
    }
    // On a cable when the tablet has a USB device of the same make and model
    // plugged in; part of the tablet when Android says it is not external;
    // otherwise it came over Bluetooth.
    private fun linkOf(device: android.view.InputDevice?): String {
        if (device == null) return "bluetooth"
        val usb = runCatching {
            context.getSystemService(android.hardware.usb.UsbManager::class.java)?.deviceList?.values
                ?.any { it.vendorId == device.vendorId && it.productId == device.productId } == true
        }.getOrDefault(false)
        return when {
            usb -> "usb"
            Build.VERSION.SDK_INT >= 29 && !device.isExternal -> "built in"
            else -> "bluetooth"
        }
    }
    fun addScanner(read: ScanRead) = viewModelScope.launch {
        session.addScanner(com.restopos.core.common.AddedScanner(read.key, read.name, read.link))
        com.restopos.core.ui.Toaster.say("${read.name} added.")
    }
    fun removeScanner(key: String) = viewModelScope.launch { session.removeScanner(key) }
    // whether the tablet lets EasyPay use Bluetooth, for a printer paired with it
    fun bluetoothAllowed(): Boolean = printing.bluetoothAllowed()
    // pairing a Bluetooth scanner or printer is the tablet's own to do: its Bluetooth settings open
    fun bluetoothSettings() {
        runCatching { context.startActivity(android.content.Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)) }
            .onFailure { com.restopos.core.ui.Toaster.say("This tablet would not open its Bluetooth settings. Open them from the tablet's own Settings.") }
    }

    val user: StateFlow<StaffMember?> = staff.current
    fun can(permission: String) = staff.can(permission)

    // The business is a shop: Help is then a shop's. Null for the moment it
    // takes to read the settings this tablet holds, so a shop is never shown
    // a restaurant's help first.
    val retail: StateFlow<Boolean?> = db.ops().settingsFlow().map<String?, Boolean?> { PosSettings.parse(it).retail }.held(null)
    // the restaurant's plan carries the kitchen display and bookings (server 0085)
    val premium: StateFlow<Boolean> = db.ops().settingsFlow().map { PosSettings.parse(it).premium }.held(false)

    // Does it at once when the person signed in may; otherwise asks for
    // someone who may, and does it with their go-ahead.
    fun guard(permission: String, what: String, then: () -> Unit) {
        if (staff.can(permission)) then() else approvals.ask(permission, what) { then() }
    }

    // Opens the first-run set-up again (This till, Set-up). The person signed
    // in stays the one its saves are made by; when they may not set up the
    // till, whoever approves goes with each save as its approver (SetupDoor).
    fun setUp(then: () -> Unit) {
        if (staff.can("settings.device")) { door.approver = null; then() }
        else approvals.ask("settings.device", "set this till up") { who -> door.approver = who; then() }
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
    // the restaurant has one printer for everything (back office, Printers)
    private val _onePrinter = MutableStateFlow(false)
    val onePrinter: StateFlow<Boolean> = _onePrinter

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
        val one = printing.settings().onePrinter
        _onePrinter.value = Routing.single(printers, one) != null
        _routes.value = printers.associate { p -> p.id to categories.filter { c -> Routing.printersFor(Routing.ids(c.printer_ids), printers, one).contains(p.id) }.map { it.name } }
        _printers.value = printers
        _screens.value = printing.screens().map { s ->
            val ticked = categories.filter { c -> Routing.ids(c.printer_ids).contains(s.id) }.map { it.name }
            KitchenScreen(s, if (s.all_items) "Every item of every order" else if (ticked.isEmpty()) "Nothing yet: tick its categories in the back office, under Printers" else "Items of ${ticked.joinToString(", ")}")
        }
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

    fun printShift(s: ShiftEntity) = run { cash.printShift(s).fold({ "Cash drawer report sent to the printer." }, { it.message }) }
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
    Printers("Printers"), Labels("Label printer"), Scanners("Scanners"), Display("Display"), Support("Support"), Help("Help"),
}

// a scanner's frame with a barcode in it, as on the scan key
private const val SCAN_ICON = "M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M8 9v6M11 9v6M13.500 9v6M16 9v6"

// The menu's cards, top to bottom.
private val GROUPS = listOf(
    listOf(Page.Till, Page.Notices), listOf(Page.Cash), listOf(Page.Reports, Page.Payments),
    listOf(Page.Printers, Page.Labels, Page.Scanners, Page.Display), listOf(Page.Support, Page.Help),
)

private fun icon(p: Page): String = when (p) {
    Page.Till -> VI.Screen
    Page.Notices -> VI.Bell
    Page.Cash -> VI.Cash
    Page.Reports -> VI.Bars
    Page.Payments -> VI.Card
    Page.Printers -> VI.Print
    Page.Labels -> VI.Tag
    Page.Scanners -> SCAN_ICON
    Page.Display -> VI.Sun
    Page.Support -> VI.Help
    Page.Help -> VI.Orders
}

private val Shape = RoundedCornerShape(14.dp)
private val CardShape = RoundedCornerShape(16.dp)
private val stamp: DateFormat get() = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT)
private val clock: DateFormat get() = DateFormat.getTimeInstance(DateFormat.SHORT)

// Something that needs someone's attention for as long as it is true.
// `soft` is something that is on its way by itself, not a fault.
private class Standing(val title: String, val detail: String, val button: String, val soft: Boolean = false, val onClick: () -> Unit)

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
    onSetUp: () -> Unit = {},
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
    val retail by vm.retail.collectAsState()
    // A shop has sales and products, no orders, kitchen or menu. Where a line
    // only has two wordings, the moment before the business is read is taken
    // for a restaurant, as the shell does; what only a restaurant has waits
    // until it is known to be one.
    val shop = retail == true
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
        count = { if (shift == null) vm.say("The day is not open.") else onCountDrawer() },
        close = { if (shift == null) vm.say("The day is not open.") else onClosePeriod() },
    )
    val failed = jobs.count { it.error != null }
    val standing = buildList {
        if (needsSignIn) add(Standing("This tablet cannot sync", "Its login was signed out or switched off. Sales are saved here until someone signs in.", "Sign in", onClick = onSignIn))
        if (rejected > 0) add(Standing("$rejected changes were refused by the server", "They are kept on this tablet until someone has looked at them.", "Review", onClick = onRejected))
        if (pending > 0 && !needsSignIn) add(Standing("$pending changes are waiting to be sent", "They go as soon as there is a connection.", "Sync now", soft = true) { vm.sync() })
        val list = printers
        if (list != null && list.isEmpty()) {
            add(Standing("No printer is set up", "Nothing can print: no receipts, no ${if (shop) "reports" else "kitchen tickets"}. Printers are added in the back office.", "Printers") { page = Page.Printers })
        } else if (list != null && list.none { it.is_receipt }) {
            add(Standing("No receipt printer", "${if (shop) "Receipts and reports" else "Receipts, bills and reports"} have nowhere to print, and the drawer cannot open.", "Printers") { page = Page.Printers })
        }
        if (failed > 0) add(Standing("$failed print ${if (failed == 1) "job" else "jobs"} failed", "See what did not print and send it again.", "Printers") { page = Page.Printers })
    }

    // a printer that wants looking at puts a dot on Printers, and so does a kitchen screen that does not answer
    val answers by vm.answers.collectAsState()
    val screenStatus by vm.screenStatus.collectAsState()
    val printerTrouble = failed > 0 || printers?.let { list -> list.isEmpty() || list.any { answers[it.id] == false } } == true ||
        screenStatus.values.any { it.trouble != null }
    // Another page comes up into place. The one that is there when Settings
    // opens is simply there.
    val seen = remember { arrayOfNulls<Page>(1) }
    val shown = remember(page) { Animatable(if (seen[0] == null) 1f else 0f).also { seen[0] = page } }
    LaunchedEffect(shown) { shown.animateTo(1f, Motion.enter(220)) }

    Box(Modifier.fillMaxSize().background(V.Bg)) {
        Row(Modifier.fillMaxSize()) {
            Menu(page, lock, standing.isNotEmpty() || notices.isNotEmpty(), printerTrouble, shop, onPick = { page = it }, onLock = onLock)
            // each page starts at its own top
            key(page) {
                Column(
                    Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState())
                        .graphicsLayer { alpha = shown.value; translationY = (1f - shown.value) * 10.dp.toPx() }
                        .padding(start = 28.dp, end = 28.dp, top = 22.dp, bottom = 28.dp),
                ) {
                    // the page reads as a column, not across the whole tablet
                    Column(Modifier.widthIn(max = 800.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (page != Page.Till) T(page.label, 22.sp, 800, spacing = (-0.4).sp, modifier = Modifier.padding(bottom = 6.dp))
                        when (page) {
                            Page.Till -> TillPage(vm, keys, network, standing, shop, onSignIn, onRejected, onSetUp) { page = it }
                            Page.Notices -> NoticesPage(vm, standing)
                            Page.Cash -> CashPage(vm, more, keys)
                            Page.Reports -> ReportsPage(vm, more, shop, keys.close) { sheet = "day" }
                            Page.Payments -> PaymentsPage(vm) { receipts.showId(it) }
                            Page.Printers -> PrintersPage(vm, more, retail)
                            Page.Labels -> LabelPrinterPage()
                            Page.Scanners -> ScannersPage(vm, retail == true)
                            Page.Display -> DisplayPage(vm, retail)
                            Page.Support -> SupportPage(vm, shop, network, onSignIn, onRejected, onSignOut)
                            // which business this is, is read in a moment: no help is shown for the wrong one meanwhile
                            Page.Help -> retail?.let { shop -> val premium by vm.premium.collectAsState(); HelpPage(shop, premium) }
                        }
                    }
                }
            }
        }
        (said ?: receiptSaid)?.let { m ->
            Row(
                Modifier.align(Alignment.BottomCenter).padding(bottom = 28.dp, start = 40.dp, end = 40.dp).clip(Shape).background(V.On).padding(horizontal = 22.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) { T(m, 15.sp, 700, V.OnText, lines = 3) }
        }
    }

    MoreSheets(more, sheet, onDismiss = { sheet = null; vm.load() }, onCloseShift = onClosePeriod)
    ReceiptDialog(receipts)
}

// The side list: every page of Settings, and the way out at its foot. A dot
// says a page has something that wants looking at.
@Composable
private fun Menu(page: Page, lock: String, waiting: Boolean, printerTrouble: Boolean, shop: Boolean, onPick: (Page) -> Unit, onLock: () -> Unit) {
    Column(
        Modifier.width(250.dp).fillMaxHeight().background(V.Header)
            .drawBehind { drawRect(V.HeaderLine, Offset(size.width - 1.dp.toPx(), 0f), Size(1.dp.toPx(), size.height)) }
            .padding(start = 12.dp, end = 12.dp, top = 22.dp, bottom = 14.dp),
    ) {
        T("Settings", 22.sp, 800, spacing = (-0.4).sp, modifier = Modifier.padding(start = 10.dp, bottom = 14.dp))
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            // labels are a shop's: a restaurant's till has no label printer
            Page.entries.filter { shop || it != Page.Labels }.forEach { p ->
                val on = p == page
                val bg by animateColorAsState(if (on) V.Key else Color.Transparent, tween(140), label = "page")
                Row(
                    Modifier.fillMaxWidth().height(46.dp).press { onPick(p) }.clip(RoundedCornerShape(11.dp)).background(bg).padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    VIcon(icon(p), 18.dp, if (on) V.Text else V.Text2)
                    T(p.label, 15.sp, 700, if (on) V.Text else V.Dim, Modifier.weight(1f).padding(start = 12.dp))
                    if (p == Page.Notices && waiting) Box(Modifier.size(7.dp).clip(CircleShape).background(V.Amber))
                    if (p == Page.Printers && printerTrouble) Box(Modifier.size(7.dp).clip(CircleShape).background(V.Red))
                }
            }
        }
        VBtn(lock, Modifier.fillMaxWidth(), V.Key2, V.Dim, 46.dp, 11.dp, 14.sp, icon = VI.Lock, onClick = onLock)
    }
}

// ---- the pages ----

@Composable
private fun TillPage(vm: SettingsViewModel, keys: CashKeys, network: String, standing: List<Standing>, shop: Boolean, onSignIn: () -> Unit, onRejected: () -> Unit, onSetUp: () -> Unit, onGo: (Page) -> Unit) {
    val user by vm.user.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val rejected by vm.rejected.collectAsState()
    val lastPull by vm.lastPull.collectAsState()
    val shift by vm.shift.collectAsState()
    val printers by vm.printers.collectAsState()
    val answers by vm.answers.collectAsState()

    // what wants attention is said first
    standing.forEach { Alert(it) }
    Heading("Quick actions")
    CashActions(keys)
    Heading("Status")
    Group {
        when {
            needsSignIn -> Fact(VI.Signal, "This device", "It cannot sync until someone signs in. Sales are saved here in the meantime.", V.RedText, "Sign in", onSignIn)
            pending > 0 -> Fact(VI.Signal, "This device", "$pending changes are waiting to be sent", V.AmberText, "Reload device") { vm.sync() }
            else -> Fact(
                VI.Signal, "This device", "Device is up to date" + (lastPull?.let { ", checked at ${clock.format(Date(it))}" } ?: ""),
                V.GreenText, "Reload device",
            ) { vm.sync() }
        }
        if (rejected > 0) {
            Line()
            Fact(VI.Warn, "Refused changes", "$rejected changes were refused by the server and need a look", V.RedText, "Review", onRejected)
        }
        Line()
        Fact(
            VI.Clock, "Day",
            shift?.let { "Open since ${stamp.format(Date(it.opened_at))}, opened with ${Money.format(it.opening_float)} in the drawer" }
                ?: "The day is not open. Someone allowed to opens it from the start screen, by counting the drawer.",
            button = "Cash drawer",
        ) { onGo(Page.Cash) }
        Line()
        val list = printers
        val silent = list.orEmpty().filter { answers[it.id] == false }
        Fact(
            VI.Print, "Printers",
            when {
                list == null -> "Looking…"
                list.isEmpty() -> "No printer is set up"
                silent.isNotEmpty() -> silent.joinToString(", ") { it.name } + (if (silent.size == 1) " is" else " are") + " not answering · ${list.size - silent.size} of ${list.size} connected"
                else -> "${list.size} set up. " + (list.firstOrNull { it.is_receipt }?.let { "Receipts print on ${it.name}." } ?: "None of them prints receipts.")
            },
            if (list != null && (list.isEmpty() || silent.isNotEmpty() || list.none { it.is_receipt })) V.RedText else V.Text2,
            "Printers",
        ) { onGo(Page.Printers) }
        Line()
        Fact(VI.Screen, "Network", network)
        Line()
        Fact(VI.Person, "Signed in", user?.let { it.employee.name + (it.role?.let { r -> " · $r" } ?: "") } ?: "Nobody: this till does not use staff PINs")
        Line()
        // the first-run set-up, open again: what is done, and each step to do or change
        Fact(
            VI.Gear, "Set-up",
            if (shop) "The products, the printer, the business's details and staff PINs, one step at a time"
            else "The menu, the tables, the printer, the business's details and staff PINs, one step at a time",
            V.Text2, "Open",
        ) { vm.setUp(onSetUp) }
    }
}

// The scanners added on this tablet, and adding one. While the page is on
// show it listens: a barcode scanned with a scanner that is already added
// shows what it read (the test), and one scanned with anything else offers
// that device to be added.
@Composable
private fun ScannersPage(vm: SettingsViewModel, shop: Boolean) {
    val scanners by vm.scanners.collectAsState()
    val joined by vm.joined.collectAsState()
    val read by vm.scanRead.collectAsState()
    androidx.compose.runtime.DisposableEffect(Unit) { vm.listenForScans(); onDispose { vm.stopListeningForScans() } }

    // only a shop has screens that take a scan below the screen (Sell, Receipts, Products and stock, Stock check)
    Note(
        "A scanner works as soon as it is plugged into the tablet or paired with it: it types what it reads. Added here, the till knows which device it is. " +
            if (shop) "What it reads then goes straight to the sale and is never typed into a box, and this page says whether it is connected."
            else "This page then says whether it is connected, and shows what it reads.",
    )
    if (scanners.isEmpty()) Panel { Text("No scanner has been added on this tablet.", color = Pos.Text, fontSize = 14.sp) }
    scanners.forEach { s ->
        val here = s.key in joined
        val last = read?.takeIf { it.key == s.key }
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(s.name, color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        if (here) Tag("Connected", Pos.Ok, dot = true) else Tag("Not connected", Pos.Pink, dot = true)
                    }
                    Text("${s.joined} scanner", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp)
                    Text(
                        when {
                            last != null -> "It read ${last.code}."
                            here -> "Scan any barcode to try it."
                            s.link == "bluetooth" -> "Switch it on. If it stays like this, pair it again in the tablet's Bluetooth settings."
                            else -> "Plug it into the tablet."
                        },
                        Modifier.padding(top = 2.dp), color = if (last != null) Pos.Ok else Pos.Text2, fontSize = 13.sp,
                    )
                }
                Small("Remove") { vm.removeScanner(s.key) }
            }
        }
    }

    Heading("Add a scanner")
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(end = 12.dp)) {
                Text("1. Connect it", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                Text("USB: plug its cable into the tablet. Bluetooth: pair it in the tablet's Bluetooth settings, then come back here.", Modifier.padding(top = 2.dp), color = Pos.Text2, fontSize = 13.sp, lineHeight = 19.sp)
            }
            Small("Bluetooth settings") { vm.bluetoothSettings() }
        }
        Box(Modifier.padding(vertical = 12.dp)) { Line() }
        val fresh = read?.takeIf { r -> scanners.none { it.key == r.key } }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(end = 12.dp)) {
                Text("2. Scan any barcode with it", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                if (fresh == null) {
                    Text("Waiting for a scan…", Modifier.padding(top = 2.dp), color = Pos.Text2, fontSize = 13.sp)
                } else {
                    Text("${fresh.name} read ${fresh.code}.", Modifier.padding(top = 2.dp), color = Pos.Ok, fontSize = 13.sp, lineHeight = 19.sp)
                }
            }
            if (fresh != null) Small("Add this scanner") { vm.addScanner(fresh) }
        }
    }
    Note("A scanner has to end each code with Enter or Tab, as nearly all do when new. One that pairs by Bluetooth but reads nothing here is in another mode: its booklet has a barcode that switches it to keyboard (HID) mode.")
}

@Composable
private fun NoticesPage(vm: SettingsViewModel, standing: List<Standing>) {
    val notices by vm.notices.collectAsState()
    if (standing.isEmpty() && notices.isEmpty()) {
        Panel { Text("Nothing needs attention.", color = Pos.Text, fontSize = 15.sp) }
    }
    standing.forEach { Alert(it) }
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
    Note("Cash in and cash out each print a slip for the drawer. Count drawer is for a handover: it records what is in the drawer and how that compares, prints a slip to sign, and the day stays open. Close the day is the same count, then the day's figures are fixed and the Z report prints.")
    Heading("Today")
    Panel {
        if (open == null) {
            Text("The day is not open. Someone allowed to opens it from the start screen, by counting the drawer.", color = Pos.Text, fontSize = 14.sp)
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
        Heading("Drawer counts today")
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
    Heading("Cash in and out today")
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
private fun ReportsPage(vm: SettingsViewModel, more: MoreViewModel, shop: Boolean, onCloseShift: () -> Unit, onCloseDay: () -> Unit) {
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

    Seg(listOf("Cash drawer", "Day so far", "Closed"), tab) { tab = it }
    when (tab) {
        0 -> {
            val s = last
            if (s == null) {
                Panel { Text("No day has been opened on this till yet.", color = Pos.Text, fontSize = 14.sp) }
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
                    if (row.closed_at == null) Action("Close the day", primary = true, onClick = onCloseShift)
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
                // with the day open it is closed by counting the drawer; with none open, these figures are closed on their own
                val dayOpen = last?.first?.closed_at == null && last != null
                Row(Modifier.fillMaxWidth()) { Action(if (dayOpen) "Close the day" else "Close and print", primary = true, onClick = if (dayOpen) onCloseShift else onCloseDay) }
                Note("Closing the day counts the drawer, fixes these figures, prints the Z report and starts a new day. " + if (shop) "Every sale has to be paid first, parked ones included." else "Every order has to be paid first.")
            }
        }
        else -> {
            Heading("Cash drawer reports")
            Panel {
                if (pastShifts.isEmpty()) Note("No day has been closed on this till yet.")
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
    Column(Modifier.fillMaxWidth().clip(CardShape).background(V.Panel).border(1.dp, V.Stroke, CardShape)) {
        Row(Modifier.fillMaxWidth().background(V.PanelFoot).padding(horizontal = 6.dp)) {
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

// `retail` is null for the moment the business is being read.
@Composable
private fun PrintersPage(vm: SettingsViewModel, more: MoreViewModel, retail: Boolean?) {
    val shop = retail == true
    val premium by vm.premium.collectAsState()
    val printers by vm.printers.collectAsState()
    val routes by vm.routes.collectAsState()
    val one by vm.onePrinter.collectAsState()
    val answers by vm.answers.collectAsState()
    val checking by vm.checking.collectAsState()
    val orderTypes by vm.orderTypes.collectAsState()
    val jobs by vm.jobs.collectAsState()
    val busy by more.busy.collectAsState()
    val working by vm.busy.collectAsState()

    Row(verticalAlignment = Alignment.CenterVertically) {
        Note("The tablet prints straight to each printer, over the network, a USB cable or Bluetooth.", Modifier.weight(1f))
        Small(if (checking) "Checking…" else "Check again", enabled = !checking) { vm.check() }
    }
    val list = printers
    if (list != null && list.isEmpty()) {
        Panel { Text("No printer is set up. Add them in the back office, under Printers; they arrive here with the next sync.", color = Pos.Text, fontSize = 14.sp) }
    }
    // A Bluetooth printer: the tablet has to allow EasyPay to use Bluetooth,
    // asked once from Android 12 on, and the printer is paired in the tablet
    // own Bluetooth settings, where the till then finds it.
    if (list.orEmpty().any { it.kind == "bluetooth" }) {
        var allowed by remember { mutableStateOf(vm.bluetoothAllowed()) }
        val ask = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { ok ->
            allowed = ok
            if (ok) vm.check()
        }
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Text(if (allowed) "Bluetooth printers" else "EasyPay may not use Bluetooth yet", color = if (allowed) Pos.Text else Pos.Pink, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    Text(
                        if (allowed) "Pair the printer in the tablet's Bluetooth settings. The till finds it there by the name or address set in the back office."
                        else "A Bluetooth printer cannot be reached until the tablet allows it. It asks once.",
                        Modifier.padding(top = 2.dp), color = Pos.Text2, fontSize = 13.sp, lineHeight = 19.sp,
                    )
                }
                if (allowed) Small("Bluetooth settings") { vm.bluetoothSettings() }
                else Small("Allow Bluetooth") { ask.launch(android.Manifest.permission.BLUETOOTH_CONNECT) }
            }
        }
    }
    list.orEmpty().forEach { p ->
        val usb = p.kind == "usb"
        val bt = p.kind == "bluetooth"
        val up = answers[p.id]
        val cats = routes[p.id].orEmpty()
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(p.name, color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        when (up) {
                            null -> Tag("Checking", Pos.Text3, dot = true)
                            true -> Tag(if (usb) "Plugged in" else if (bt) "Paired" else "Connected", Pos.Ok, dot = true)
                            else -> Tag(if (usb) "Not plugged in" else if (bt) "Not paired" else "Not answering", Pos.Pink, dot = true)
                        }
                    }
                    Text("${if (usb) "USB" else if (bt) "Bluetooth · ${p.address ?: "no name"}" else p.address ?: "no address"} · ${p.paper_mm} mm paper", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp)
                    Text(
                        // a shop sends nothing to a kitchen, whatever is ticked in the back office: all it prints is the receipt printer's
                        if (shop) (if (p.is_receipt) "Everything prints here: receipts, reports and the cash drawer." else "Nothing is sent here: a shop's till prints everything on its receipt printer.")
                        else if (one) (if (p.is_receipt) "Everything prints here: receipts, bills, reports, the cash drawer and every kitchen order" else "Nothing is sent here while one printer does everything")
                        else listOfNotNull(
                            "Receipts, bills, reports and the cash drawer".takeIf { p.is_receipt },
                            cats.takeIf { it.isNotEmpty() }?.let { "Kitchen tickets for ${it.joinToString(", ")}" },
                        ).joinToString(". ").ifEmpty { "Nothing is sent here yet: tick what it prints in the back office, under Printers" } + ".",
                        Modifier.padding(top = 2.dp), color = Pos.Text2, fontSize = 13.sp,
                    )
                }
                Small("Test print", enabled = !busy) { more.testPrint(p.id) }
            }
        }
    }
    // The kitchen screens: tablets in the kitchen that show the orders. Each
    // says whether it answered this till the last time it was asked, and how
    // many orders it has not confirmed.
    val screens by vm.screens.collectAsState()
    val screenStatus by vm.screenStatus.collectAsState()
    val testing by vm.testing.collectAsState()
    if (retail == false && screens.isNotEmpty()) {
        Heading("Kitchen screens")
        if (!premium) Panel { Note("Kitchen screens are part of EasyPay Premium. On this restaurant's plan nothing is sent to them; kitchen orders print as before.") }
        else screens.forEach { s ->
            val st = screenStatus[s.row.id]
            Panel {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f).padding(end = 12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Text(s.row.name, color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                            when {
                                st == null || (st.heardAt == null && st.trouble == null) -> Tag("Not asked yet", Pos.Text3, dot = true)
                                st.trouble != null -> Tag("Not answering", Pos.Pink, dot = true)
                                else -> Tag("Answering", Pos.Ok, dot = true)
                            }
                            if ((st?.waiting ?: 0) > 0) Tag("${st?.waiting} waiting", Pos.Pink)
                        }
                        Text("Kitchen screen · ${s.row.address ?: "no address"}", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp)
                        Text("${s.shows}.", Modifier.padding(top = 2.dp), color = Pos.Text2, fontSize = 13.sp)
                        st?.trouble?.let { Text(it, Modifier.padding(top = 4.dp), color = Pos.Pink, fontSize = 13.sp) }
                    }
                    Small(if (testing == s.row.id) "Asking…" else "Test", enabled = testing == null) { vm.testScreen(s.row.id) }
                }
            }
        }
        if (premium) Note("An order goes to its kitchen screens over the restaurant's own Wi-Fi the moment it is sent, with or without internet. One that a screen has not confirmed is sent again by itself until it has.")
    }
    // only a restaurant sends orders to a kitchen
    if (retail == false && orderTypes.isNotEmpty()) {
        Heading("When an order goes to the kitchen")
        Panel {
            orderTypes.forEach {
                Figure(it.name, when (it.kitchen) { "save" -> "When it is sent"; "pay" -> "When it is paid, or sooner with Send"; else -> "Never" })
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
                        // only a restaurant on the premium tier has a kitchen display for the order to be on
                        Text((if (premium) "The order is on the kitchen display. " else "") + "Try again prints the paper once the printer answers.", color = Pos.Text2, fontSize = 13.sp)
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

// A shop's: the printer this tablet's price and barcode labels come out of.
// It is the tablet's own, like a scanner, and nothing of it is in the back
// office: it is added, tried and changed here (the form is the one the Print
// labels screen opens too).
@Composable
private fun LabelPrinterPage() {
    val vm: LabelPrinterViewModel = hiltViewModel()
    val printer by vm.printer.collectAsState()
    val there by vm.there.collectAsState()
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var testing by remember { mutableStateOf(false) }

    Note("Price and barcode labels come out of a printer of their own: plugged into this tablet, paired with it, or on the network. It belongs to this tablet, so it is set up on each tablet that prints labels.")
    val p = printer
    if (p == null) {
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("No label printer is set up on this tablet.", Modifier.weight(1f).padding(end = 12.dp), color = Pos.Text, fontSize = 14.sp)
                Small("Add a label printer") { open = true }
            }
        }
    } else {
        val usb = p.kind == "usb"
        val bt = p.kind == "bluetooth"
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(p.name, color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        when (there) {
                            null -> Tag("Checking", Pos.Text3, dot = true)
                            true -> Tag(if (usb) "Plugged in" else if (bt) "Paired" else "Connected", Pos.Ok, dot = true)
                            else -> Tag(if (usb) "Not plugged in" else if (bt) "Not paired" else "Not answering", Pos.Pink, dot = true)
                        }
                    }
                    Text(
                        labelConnection(p) + " · " + if (p.sticker) "sticker printer, ${p.dpi} dpi" else "receipt printer, ${p.paper} mm paper",
                        Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp,
                    )
                }
                Small(if (testing) "Sending…" else "Test label", enabled = !testing) {
                    testing = true
                    scope.launch {
                        com.restopos.core.ui.Toaster.say(vm.test(p) ?: "A test label was sent to ${p.name}.")
                        testing = false
                        vm.check()
                    }
                }
            }
            Box(Modifier.padding(vertical = 12.dp)) { Line() }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("The test label has a frame at its edge: all four sides should print.", Modifier.weight(1f), color = Pos.Text2, fontSize = 13.sp, lineHeight = 19.sp)
                Small("Change") { open = true }
                Small("Remove") { vm.remove() }
            }
        }
    }
    Note("Labels are printed from Print labels, in the side menu behind the key at the top left, or from a product's sheet on Products & stock.")
    if (open) LabelPrinterSheet(vm) { open = false; vm.check() }
}

@Composable
private fun DisplayPage(vm: SettingsViewModel, retail: Boolean?) {
    val leftHanded by vm.leftHanded.collectAsState()
    val keepAwake by vm.keepAwake.collectAsState()
    val lightMode by vm.lightMode.collectAsState()
    val change = "change how this till is set up"
    Toggle("Light mode", "A pale screen with dark text, for a bright room or a terrace. Off is the dark screen.", lightMode) { vm.guard("settings.device", change) { vm.setLightMode(it) } }
    // only the restaurant's order screen can be turned round: a shop's sell screen has one layout, so a shop is not offered the switch
    if (retail == false) Toggle("Left-handed order screen", "The order moves to the right, the menu to the left.", leftHanded) { vm.guard("settings.device", change) { vm.setLeftHanded(it) } }
    Toggle("Keep the screen on", "The tablet does not go to sleep while EasyPay is open.", keepAwake) { vm.guard("settings.device", change) { vm.setKeepAwake(it) } }
    Note("These are for this tablet only.")
}

@Composable
private fun SupportPage(vm: SettingsViewModel, shop: Boolean, network: String, onSignIn: () -> Unit, onRejected: () -> Unit, onSignOut: () -> Unit) {
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
        Figure("Version", "EasyPay ${BuildConfig.VERSION_NAME}")
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
                if (shop) "Unlinks the tablet from the shop and clears the products and the receipt list from it. Sales already sent stay in the back office. " +
                    "It is refused while a sale is waiting to be sent or is unpaid, parked ones included."
                else "Unlinks the tablet from the restaurant and clears the menu and the receipt list from it. Sales already sent stay in the back office. " +
                    "It is refused while a sale is waiting to be sent or an order is unpaid.",
                Modifier.weight(1f).padding(end = 12.dp),
            )
            Small("Sign out", color = Pos.Pink) { vm.guard("settings.device", "sign this tablet out", onSignOut) }
        }
    }
}

private val HELP = listOf(
    "Starting the day" to "Clock in: tap Clock in/out, pick your name and enter your PIN. Then open the day: someone allowed to taps their name on the start screen and counts the cash in the drawer, which opens for the count. The till sells from then on.",
    "Serving a table" to "On Tables, tap a free table and the number of guests: its order opens. Tap the items, then Send to kitchen. The table turns blue and shows what it owes and how long it has been. Tap it again to add to the order, print the bill or take payment.",
    "Moving a table, or two tables on one bill" to "On Tables, tap the table, then Move or merge, then the table it should go to. A free table takes the order as it is. A table that has an order of its own takes this one onto its bill: the guests are added together and the first table is free. From an order, the same is under More. To pay apart again afterwards, use Split check.",
    "A counter sale" to "Tap Quick sale, tap the items, tap Pay. What was not sent goes to the kitchen when it is paid. To serve someone else before it is paid, tap New sale: the order waits under Orders, and tapping it there brings it back.",
    "A takeaway or a delivery" to "On Takeaway, tap New takeaway or New delivery. Type who it is for, tap the items, and send or take payment. It then moves along the board: new, in the kitchen, ready, and off the board when it is collected. The Takeaway key counts in green the ones that are ready to hand over. Tap its time to move it, or a delivery's address to pick the rider.",
    "Options and notes for the kitchen" to "An item marked Options asks its questions when you tap it. Press and hold any item to add a kitchen note or several at once. More, Order note says something about the whole order.",
    "The kitchen display" to "Every send is a ticket on Kitchen. The cooks tap a line when it is done and Bump when the ticket is at the pass; Recall last brings the last one back. A sound says when an order arrives. A takeaway is marked ready when its last ticket is bumped: the till makes a sound of its own, says which one, and the Takeaway key counts it in green. The key with the cog sets after how many minutes a ticket turns amber and red, and what a ticket shows. The tablet's volume keys set how loud the sounds are.",
    "A kitchen screen on another tablet" to "A tablet in the kitchen can show the orders as they are sent. On that tablet, install EasyPay and tap Set up as a kitchen screen on its first screen: it needs no login, and shows its address and a pairing code. In the back office, under Printers, add a Kitchen screen with that address and code, and choose whether it shows everything or only the categories ticked for it. From this till's next sync, Send to kitchen puts the order on it at once, over the restaurant's own Wi-Fi, with or without internet. A tick or a Bump there shows on Kitchen here within a few seconds; with several screens, Bump clears that screen's part, and a takeaway is ready when every screen has bumped its part. If the till says a kitchen screen is not answering: check the kitchen tablet is on, has EasyPay open, and is on the same Wi-Fi; the orders wait and go to it by themselves when it is back. Settings, Printers shows each screen, how many orders wait for it, and has Test. Ask whoever set up the Wi-Fi to keep the kitchen tablet's address the same, as for a printer.",
    "Taking payment" to "Tap Pay and pick how it is paid. For cash, tap what the guest gave, or type it, to see the change. The receipt prints and the order closes; Print gives another copy, and Email or WhatsApp hands the receipt to that app on the tablet.",
    "Splitting the bill" to "To share a bill evenly, tap Pay, then Split equally, and set how many are paying: each share is paid its own way and each guest gets a printed copy. To let guests pay for their own items, tap Split: move items onto separate checks and pay each check on its own.",
    "Taking an item off" to "Tap the line on the order. Before it has gone to the kitchen it is simply removed. After that it is a void: the kitchen gets a void ticket, and it needs someone allowed to void.",
    "Bookings" to "On Bookings, New booking takes the name, the guests and the time. Assign table holds a free table for them on the floor plan. When they arrive, tap Seat, or tap their table and Guests arrived.",
    "Something has run out" to "Menu, Menu & stock, and switch the item to Sold out. It stays on the menu, greyed, on every till, until it is switched back.",
    "Adding, changing or removing an item" to "Menu, Menu & stock. Tap New item, or tap an item's name to change it: its name, its price, its category, its barcode and whether it is on sale. Remove, on the same sheet, takes it off every till; receipts that sold it keep its name. It needs a connection, and may need a manager. An item's add-ons and tax are set in the back office.",
    "Categories" to "Menu, Menu & stock, then Categories. Tap New category, or tap one to change it: its name and its colour, which is the colour of its button and of its items' tiles. Remove takes away a category that has no items left in it. Where a category's items print, its place among the buttons and whether its stock is counted are set in the back office. It needs a connection, and may need a manager.",
    "Adding or removing stock" to "For an item whose stock is counted: Menu, Menu & stock, tap the item's name, then Add stock or Remove stock. Type how many. A reason can be picked (a delivery, damaged, expired, lost) and need not be. More than there is cannot be taken out. To have an item's stock counted, switch on Count its stock on its sheet and save: it then says Out until stock is added. It needs a connection, and may need a manager.",
    "An item with no fixed price" to "For a service, or anything charged differently each time, switch on Price typed at the sale on the item. Its tile then says Enter price: tap it, type what this customer pays and tap Done. Each tap is a line of its own, so the same item can be on a bill twice at two prices.",
    "A refund, or the wrong payment type" to "Under Receipts, tap the receipt. Refund gives the whole receipt back. Change corrects how it was paid without changing the amount.",
    "When you are not allowed to" to "A refund, a void after the kitchen has it, opening the drawer and the like may need a manager. The till asks who approves: they tap their name and enter their own PIN, and it is done in your name with their approval on record.",
    "Handing the drawer to someone else" to "Menu, Cash drawer. Count the cash, type the amount and tap Record this count: a slip prints for both of you to sign, and the day carries on.",
    "Cash in and cash out" to "Menu, Cash drawer, Cash in or Cash out. Type the amount and what it is for. A slip prints for the drawer and it shows on the day's reports.",
    "Ending the day" to "Take payment for every open order. Under Menu, Cash drawer, count the cash and type the amount. If you may see the day's figures, the amount starts on what the drawer should hold: change it only if you counted something else. Tap Close the day & print Z report: the day's figures are fixed and the report prints. Then clock out.",
    "Setting the till up" to "A new business is walked through it the first time a tablet is signed in: the menu, the tables, the receipt printer, what prints at the top of a receipt, and staff PINs. Any step can be skipped. Afterwards it is in Settings, under This till: Set-up shows what is done, and a tap on a line does it or changes it. A second printer for the kitchen, which category prints where, and the plan's exact layout are set in the back office. It needs a connection, and may need a manager; adding staff and setting a PIN needs the owner.",
    "A printer does not print" to "Settings, Printers. Check the printer says Connected and try a test print. A failed print has Try again next to it. An order still reaches the kitchen display when a kitchen printer does not answer.",
    "No internet" to "Keep selling. Everything is saved on the tablet and sent by itself when the connection is back. Printing does not need the internet, only the local network.",
)

// The kitchen display and bookings are the premium tier's (server 0085): a
// restaurant on another plan is not told how to use screens it does not have,
// nor that an order is on a display it has not got.
private val PREMIUM_HELP = setOf("The kitchen display", "A kitchen screen on another tablet", "Bookings")
private const val ON_THE_DISPLAY = " An order still reaches the kitchen display when a kitchen printer does not answer."
internal fun helpFor(shop: Boolean, premium: Boolean): List<Pair<String, String>> = when {
    shop -> SHOP_HELP
    premium -> HELP
    else -> HELP.filter { it.first !in PREMIUM_HELP }.map { (title, text) -> title to text.replace(ON_THE_DISPLAY, "") }
}

// A shop's help: its till has no tables, no kitchen and no bookings. Two keys
// are called More there, the one on the top bar (which opens this screen) and
// the one under the sale, so an entry says which it means. The cash drawer is
// in the side menu, which has no name on the screen: "the key at the top left".
private val SHOP_HELP = listOf(
    "Starting the day" to "Clock in: tap Clock in/out, pick your name and enter your PIN. Then open the day: someone allowed to taps their name on the start screen and counts the cash in the drawer, which opens for the count. The till sells from then on.",
    "Ringing up a sale" to "On Sell, scan each product's barcode, or tap its tile on the right. The same product again adds one more to its line. To find a product, type its name, SKU or barcode in the box at the top, or tap its category under the box. On a line, − and + change how many, and tapping the number between them lets you type it. A code that no product carries adds nothing, and the till says so.",
    "Scanning without the keyboard" to "Tap the scan key beside the search box, on Sell, Receipts, Products & stock, Stock check or Print labels. While it is lit, the box gives way to a strip that says what the last scan did, and the tablet's keyboard does not come up. Tap the key off again to search by typing. It is one switch for all of these screens.",
    "Adding a scanner" to "In Settings, under Scanners. Plug the scanner into the tablet, or pair it in the tablet's Bluetooth settings (the page has a key that opens them), scan any barcode, and tap Add this scanner. From then on what it reads goes straight to the sale on Sell, Receipts, Products & stock, Stock check and Print labels, with the scan key lit or not, and is never typed into the search box. The page says whether each scanner is connected, and a barcode scanned there shows what it read. A scanner that was not added still works as before: it types what it reads.",
    "Sizes, colours and other variants" to "A product that comes in variants asks which one when it is tapped: pick the size, the colour or whatever it has, then tap Add. Where its stock is counted, each choice says what is left. Scanning a variant's own barcode adds that variant at once.",
    "A product sold by weight" to "Tap or scan it, type the weight in kilos (0.350 for 350 grams) and tap Done. Each weighing is a line of its own. To weigh it again, tap the weight on its line.",
    "A discount, or another price, on one line" to "Tap the line on the sale. 10% off and 20% off are one tap; Other % and Rs off ask for the figure, and Rs off comes off each one on the line. Change price sets another price for this sale only. The price it was listed at stays on the line, crossed out, and on the receipt. No discount puts the listed price back.",
    "A discount on the whole sale" to "Tap Discount on sale, under the lines. Pick one of the shop's discounts or one of the percentages, or tap Another percentage or Rupees off and type it. It comes off every line in proportion when the sale is paid. One marked manager needs someone allowed to give it. Take the discount off removes it.",
    "A note on a line or on the sale" to "For one product, tap its line, then Note: gift wrapped, a serial number. For the whole sale, tap the More key under the sale, then Sale note. Both print on the receipt.",
    "Taking a line off, or clearing the sale" to "Tap the line, then Remove, or tap − until none is left. The bin at the top of the sale takes every line off at once, after asking. Nothing was paid, so nothing is refunded. Either may need someone allowed to take a line off a sale.",
    "Serving someone else first" to "Tap Park sale: the sale waits as it is and an empty one takes its place. The amber key at the top of the sale says how many are parked. Tap it, then the sale you want back; the one on the screen, if it holds anything, is parked in its place.",
    "A customer on the sale" to "Tap Add customer at the top of the sale, find them by name, phone or email, or tap New customer. Their name prints on the receipt, and Email and WhatsApp after payment start with their address or number. Everyone the shop knows is on Customers, where their details are changed.",
    "Taking payment" to "Tap Pay and pick how it is paid. For cash, tap what the customer gave, or type it, to see the change, then tap Charge. For a card or a transfer, take the money first, then tap Charge to record it. The receipt prints; Print gives another copy, and Email or WhatsApp hands the receipt to that app on the tablet. Next sale brings back an empty sale. To share one sale between several payments, tap Split equally and set how many: each share is paid its own way.",
    "Another copy of a receipt" to "For the last receipt this till issued, tap the More key under the sale, then Reprint last receipt. For an older one, tap it on Receipts, or scan the barcode at its foot, then tap Print again. The paper says it is a copy, and what has been refunded since.",
    "A return or a refund" to "Scan the barcode at the foot of the customer's receipt, on Sell or on Receipts: the receipt opens. Without the paper, open Receipts (Refund or exchange, behind the More key under the sale, goes there too) and tap the receipt or type its number: the list holds the shop's receipts of the last 30 days, from every till. Tap Refund. Take off what the customer keeps, pick how the money goes back and type the reason: a refund must have one. Put back into stock stays on when the goods go on the shelf again; switch it off for something faulty, and it is written off as damaged.",
    "An exchange" to "Open the receipt as for a refund, tap Refund, and take off what the customer keeps. Tap Exchange instead of Refund: Sell opens with the exchange at the top of the sale. Ring up what the customer takes instead, then tap the green key under the sale. What comes back pays for the new sale as far as it goes, and only the difference is paid or given back. Nothing is refunded until that sale is paid; the cross on the exchange cancels it.",
    "The wrong payment type" to "On Receipts, tap the receipt, then Change beside how it was paid, and pick how it was really paid. The amount does not change, and who corrected it and when is kept.",
    "Checking what is in stock" to "Stock check is in the side menu, behind the key at the top left, and behind the More key under the sale. Scan a product, or type its name, SKU or barcode and tap it: it shows what this shop holds of each variant, with its price. The figures are those of the last sync, less what this till has sold since. Nothing is changed from there.",
    "Changing a product's price" to "On Products & stock, scan the product or search for it, then tap it. Change price (Price, on a variant) gives it a new price on every till at its next sync.",
    "Adding or removing stock" to "On Products & stock, tap the product, then Add stock or Remove stock (Stock, on a variant). Type how many. A reason can be picked (a delivery, damaged, expired, lost, returned to the supplier) and need not be. More than there is cannot be taken out. Every change is kept in the stock history with who made it. A delivery with its costs, a count and a transfer are done in the back office. It needs a connection, and may need a manager.",
    "Categories" to "On Products & stock, tap Categories. Tap New category, or tap one to change it: its name and its colour. Remove takes away a category that has no products left in it. It needs a connection, and may need a manager.",
    "Adding, changing or removing a product" to "On Products & stock, tap New product. To change one, tap it, then Edit product: its name, its price, its category, its barcode and whether it is on sale. Remove, on the same sheet, takes it off every till; receipts that sold it keep its name. Count its stock, on the same sheet, says whether its stock is counted: switched on, the product says Out until stock is added. It needs a connection, and may need a manager. Variants, cost and tax are set in the back office.",
    "A product or service with no fixed price" to "For a service, or anything charged differently each time (a repair, an alteration), switch on Price typed at the sale on the product. Tapping or scanning it then opens the keypad: type what this customer pays and tap Done. Each one is a line of its own.",
    "Something has run out, or should not be sold" to "A tile on Sell says what is left of its product: amber when few are left, red when it is out. A product that shows out still sells. To stop one being sold, tap it on Products & stock and switch On sale off: it cannot be rung up on any till until it is switched back, and its stock is not touched.",
    "When you are not allowed to" to "A refund, a discount, a changed price, taking a line off, printing a receipt again, opening the drawer and the like may need a manager. The till asks who approves: they tap their name and enter their own PIN, and it is done in your name with their approval on record.",
    "Cash in, cash out and opening the drawer" to "On Sell, tap the More key under the sale, then Cash in or Cash out. Type the amount and what it is for. A slip prints for the drawer and it shows on the day's reports. Open the cash drawer opens it without a sale, and that is written down too. The same keys are on Cash drawer, in the side menu: the key at the top left opens it.",
    "Handing the drawer to someone else" to "Open the side menu with the key at the top left and tap Cash drawer. Count the cash, type the amount and tap Record this count: a slip prints for both of you to sign, and the day carries on.",
    "Ending the day" to "Take payment for every parked sale and for the one on the screen, or clear them: the day does not close while a sale is unpaid. Then open the side menu with the key at the top left and tap Cash drawer. Count the cash and type the amount. If you may see the day's figures, the amount starts on what the drawer should hold: change it only if you counted something else. Tap Close the day & print Z report: the day's figures are fixed and the report prints. Then clock out.",
    "Setting the till up" to "A new shop is walked through it the first time a tablet is signed in: the products, the receipt printer, what prints at the top of a receipt, and staff PINs. Any step can be skipped. Afterwards, tap More on the top bar, then This till: Set-up shows what is done, and a tap on a line does it or changes it. More printers, variants, costs and tax are set in the back office. It needs a connection, and may need a manager; adding staff and setting a PIN needs the owner.",
    "Printing price and barcode labels" to "Open the side menu with the key at the top left and tap Print labels, or tap Print label on a product's sheet on Products & stock. Tap each product to label on the right, or scan it: each tap is one more label, and a product with variants asks which ones. On the left, − and + change how many of a line, and tapping the number lets you type it. Under the list is the label that will print, drawn as it will come out: tap it to pick another, ready-made or one of your own, in the size of the stickers in the printer. Then tap Print. A line that says it has no bars has neither a barcode nor a SKU, or its code is too wide for that label: it still prints, with the code as characters or without one.",
    "Designing your own label" to "On Print labels, tap the label under the list. Tap New label, or Edit a copy under a ready-made one, or Edit under one of your own. Give the label a name and the width and height of your stickers in millimetres. The Add keys put on it what it should carry: the shop's name, the product's name, its price, its barcode, words of your own, a line, a box. Tap a thing on the label to select it, or pick it in the list beside it. Drag it to move it, drag its blue corner to size it, and use the arrows for half a millimetre at a time. A− and A+ size the letters, Turn 90° turns words or bars on their side, Remove takes the thing off. The label on the screen is drawn as it will print, and Print a test prints one. Save keeps the label on this tablet and makes it the label in use; another tablet does not have it. Someone who may not change products is asked for a manager first.",
    "Setting up the label printer" to "Labels come out of a printer of their own, set up on this tablet: tap More on the top bar, then Label printer, then Add a label printer. Give it a name, say whether it is a sticker printer or a receipt printer, and how it is connected: USB (tap it among what is plugged in), Bluetooth (pair it in the tablet's Bluetooth settings first, then tap it) or the network (type its address). Tap Print a test label before saving: the label has a frame at its edge, and all four sides should print. If the label comes out a third too small, pick 300 dpi.",
    "A printer does not print" to "Tap More on the top bar, then Printers. Check the printer says Connected and try a test print. A failed print has Try again next to it. A sale is recorded whether or not its receipt printed, and can be printed again once the printer answers. The cash drawer opens through the receipt printer, so it stays shut while that printer does not answer.",
    "No internet" to "Keep selling. Everything is saved on the tablet and sent by itself when the connection is back. What is left of each product, and the receipts of the shop's other tills, catch up then too. Printing does not need the internet, only the local network.",
)

// One card of questions: a shop's, or a restaurant's. A tap opens the answer
// under it, and closes the one that was open.
@Composable
private fun HelpPage(shop: Boolean, premium: Boolean) {
    var open by rememberSaveable { mutableStateOf(0) }
    Group {
        helpFor(shop, premium).forEachIndexed { i, (title, text) ->
            if (i > 0) Line()
            val on = open == i
            val turn = animateFloatAsState(if (on) 90f else 0f, spring(dampingRatio = 0.9f, stiffness = 500f), label = "chevron")
            Column(Modifier.fillMaxWidth().quietTap { open = if (on) -1 else i }.padding(horizontal = 18.dp)) {
                Row(Modifier.fillMaxWidth().heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                    T(title, 15.sp, 700, modifier = Modifier.weight(1f), lines = 2)
                    VIcon(VI.Chevron, 16.dp, V.Text3, modifier = Modifier.graphicsLayer { rotationZ = turn.value })
                }
                AnimatedVisibility(on, enter = expandVertically(Motion.enter(240)) + fadeIn(Motion.enter(240)), exit = shrinkVertically(Motion.exit(180)) + fadeOut(Motion.exit(120))) {
                    T(text, 14.sp, 500, V.Text2, Modifier.widthIn(max = 620.dp).padding(bottom = 18.dp), lines = 14, height = 21.sp)
                }
            }
        }
    }
}

// ---- the pieces the pages are built from ----

// the small heading over a group of things: QUICK ACTIONS, STATUS
@Composable
private fun Heading(text: String, modifier: Modifier = Modifier) {
    Caps(text, V.Text3, modifier.padding(top = 12.dp, bottom = 2.dp), 11.sp)
}

@Composable
private fun Note(text: String, modifier: Modifier = Modifier) {
    Text(text, modifier, color = V.Text3, fontSize = 13.sp, lineHeight = 19.sp)
}

// a card
@Composable
private fun Panel(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().clip(CardShape).background(V.Panel).border(1.dp, V.Stroke, CardShape).padding(horizontal = 18.dp, vertical = 14.dp), content = content)
}

// A card whose rows run edge to edge, with a Line between them.
@Composable
private fun Group(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().clip(CardShape).background(V.Panel).border(1.dp, V.Stroke, CardShape), content = content)
}

@Composable
private fun Line() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
}

@Composable
private fun Figure(label: String, value: String, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 5.dp)) {
        Text(label, Modifier.weight(1f), color = if (bold) V.Text else V.Text2, fontSize = 14.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal)
        Text(value, color = V.Text, fontSize = 14.sp, fontWeight = if (bold) FontWeight.Bold else FontWeight.SemiBold)
    }
}

// A wide key: one of a row of things to do.
@Composable
private fun RowScope.Action(label: String, primary: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.weight(1f).height(52.dp).press(onClick = onClick).clip(RoundedCornerShape(12.dp)).background(if (primary) V.On else V.Key),
        contentAlignment = Alignment.Center,
    ) { T(label, 15.sp, 700, if (primary) V.OnText else V.Text) }
}

// A small key at the end of a row.
@Composable
private fun Small(label: String, color: Color = V.Text, enabled: Boolean = true, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        Modifier.height(40.dp).then(if (enabled) Modifier.press(onClick = onClick) else Modifier).clip(shape).background(V.Key2).border(1.dp, V.Stroke2, shape).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) { T(label, 13.5.sp, 700, if (enabled) color else V.Text3) }
}

// Something that wants attention, and the key that deals with it.
@Composable
private fun Alert(s: Standing) {
    val tone = if (s.soft) V.Amber else V.Red
    Row(
        Modifier.fillMaxWidth().clip(CardShape).background(lerp(V.Panel, tone, 0.10f)).border(1.dp, tone.copy(alpha = 0.34f), CardShape)
            .padding(start = 18.dp, end = 12.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).clip(CircleShape).background(tone))
        Column(Modifier.weight(1f).padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(s.title, 15.sp, 800, lines = 2)
            T(s.detail, 13.sp, 500, V.Text2, lines = 3, height = 18.sp)
        }
        Small(s.button, onClick = s.onClick)
    }
}

// The things done to the cash drawer, one tile each; the one that ends the day is lit.
@Composable
private fun CashActions(keys: CashKeys) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Tile("Cash in", VI.Plus, onClick = keys.cashIn)
        Tile("Cash out", VI.Minus, onClick = keys.cashOut)
        Tile("Open drawer", VI.Cash, onClick = keys.open)
        Tile("Count drawer", VI.Receipt, onClick = keys.count)
        Tile("Close the day", VI.Lock, primary = true, onClick = keys.close)
    }
}

@Composable
private fun RowScope.Tile(label: String, icon: String, primary: Boolean = false, onClick: () -> Unit) {
    val fg = if (primary) V.OnText else V.Text
    Column(
        Modifier.weight(1f).height(96.dp).press(onClick = onClick).clip(Shape).background(if (primary) V.On else V.Panel)
            .then(if (primary) Modifier else Modifier.border(1.dp, V.Stroke, Shape)).padding(14.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        VIcon(icon, 19.dp, fg)
        T(label, 15.sp, 700, fg, lines = 2, height = 18.sp)
    }
}

// One line of the till's state: what it is, how it is, and what to do about it.
@Composable
private fun Fact(icon: String, title: String, detail: String, tone: Color = V.Text2, button: String? = null, onClick: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().heightIn(min = 76.dp).padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(38.dp).clip(RoundedCornerShape(11.dp)).background(V.Key2), contentAlignment = Alignment.Center) { VIcon(icon, 18.dp, tone) }
        Column(Modifier.weight(1f).padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(title, 15.sp, 700)
            T(detail, 13.sp, 500, V.Text2, lines = 3, height = 18.sp)
        }
        if (button != null) Small(button, onClick = onClick)
    }
}

@Composable
private fun Seg(options: List<String>, selected: Int, onPick: (Int) -> Unit) {
    Row {
        com.restopos.core.ui.Seg(options.mapIndexed { i, o -> SegOption(o, i == selected) { onPick(i) } }, well = V.Panel, height = 40.dp, radius = 12.dp, size = 14.sp)
    }
}

// A page someone may not open, with the way in: someone who may, and their PIN.
@Composable
private fun Locked(text: String, onAsk: () -> Unit) {
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(text, Modifier.weight(1f).padding(end = 12.dp), color = V.Text, fontSize = 14.sp)
            Small("Open with an approval", onClick = onAsk)
        }
    }
}

@Composable
private fun Toggle(title: String, detail: String, on: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clip(CardShape).background(V.Panel).border(1.dp, V.Stroke, CardShape).quietTap { onChange(!on) }.padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(title, 15.sp, 700)
            T(detail, 13.sp, 500, V.Text2, lines = 3, height = 18.sp)
        }
        com.restopos.core.ui.Toggle(on)
    }
}

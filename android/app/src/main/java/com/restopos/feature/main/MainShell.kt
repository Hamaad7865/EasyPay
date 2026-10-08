package com.restopos.feature.main

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.PinHash
import com.restopos.core.common.Scanner
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffRepository
import com.restopos.core.data.StaffSession
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.BookingEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Badge
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Gap
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.L
import com.restopos.core.ui.Motion
import com.restopos.core.ui.PillRow
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.ToastHost
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.Wordmark
import com.restopos.core.ui.press
import com.restopos.core.ui.quietTap
import com.restopos.feature.board.BoardScreen
import com.restopos.feature.board.BoardViewModel
import com.restopos.feature.bookings.BookingsScreen
import com.restopos.feature.bookings.BookingsViewModel
import com.restopos.feature.cash.CashScreen
import com.restopos.feature.cash.CashViewModel
import com.restopos.feature.customers.CustomersScreen
import com.restopos.feature.floor.FloorScreen
import com.restopos.feature.floor.FloorViewModel
import com.restopos.feature.kds.KdsScreen
import com.restopos.feature.kds.KdsViewModel
import com.restopos.feature.menu.MenuStockScreen
import com.restopos.feature.menu.MenuViewModel
import com.restopos.feature.more.MoreViewModel
import com.restopos.feature.order.OrderScreen
import com.restopos.feature.order.OrderViewModel
import com.restopos.feature.orders.OrdersScreen
import com.restopos.feature.pay.PayScreen
import com.restopos.feature.pay.PayViewModel
import com.restopos.feature.receipts.ReceiptsScreen
import com.restopos.feature.receipts.ReceiptsViewModel
import com.restopos.feature.retail.ProductsScreen
import com.restopos.feature.retail.ProductsViewModel
import com.restopos.feature.retail.RetailSellScreen
import com.restopos.feature.retail.RetailViewModel
import com.restopos.feature.retail.StockCheckScreen
import com.restopos.feature.retail.StockCheckViewModel
import com.restopos.feature.settings.SettingsScreen
import com.restopos.feature.split.SplitScreen
import com.restopos.feature.staff.PinCheck
import com.restopos.feature.staff.PinPad
import com.restopos.feature.today.TodayScreen
import com.restopos.feature.today.TodayViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// Every screen of the till. Order, Pay and Split belong to whichever order is
// open; the rest are places. Sell and Products are a shop's: its sell screen
// in place of tables and orders, its products and stock in place of the menu.
enum class Screen { Floor, Order, Pay, Split, Takeaway, Kitchen, Bookings, Orders, Today, Menu, Cash, Receipts, Customers, Settings, Sell, Products, StockCheck }

// what only a restaurant has, and what only a shop has
private val RESTAURANT_ONLY = setOf(Screen.Floor, Screen.Order, Screen.Takeaway, Screen.Kitchen, Screen.Bookings, Screen.Orders, Screen.Menu)
private val SHOP_ONLY = setOf(Screen.Sell, Screen.Products, Screen.StockCheck)

data class Badges(val takeaway: Int = 0, val kitchen: Int = 0, val bookings: Int = 0)

// Behind the top bar and the side menu: which screen is open, who is signed
// in, what is waiting (the counts on the nav keys), and whether the till is
// in step with the server.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class ShellViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val staffRepo: StaffRepository,
    private val tickets: TicketRepository,
    private val service: ServiceRepository,
    api: com.restopos.core.network.ApiClient,
) : ViewModel() {
    val screen = MutableStateFlow(Screen.Floor)
    // The business is a shop (the back office's settings say so): the till
    // shows the sell screen. Null for the moment it takes to read the
    // settings this tablet holds, so a shop's till never opens on a floor
    // plan first; a till that has never synced is taken for a restaurant.
    val retail: StateFlow<Boolean?> = db.ops().settingsFlow().map<String?, Boolean?> { com.restopos.core.data.PosSettings.parse(it).retail }
        .stateIn(viewModelScope, SharingStarted.Eagerly, null)
    init {
        // a screen the other kind of business has gives way to this one's own
        viewModelScope.launch {
            retail.collect { shop ->
                if (shop == true && screen.value in RESTAURANT_ONLY) screen.value = Screen.Sell
                if (shop == false && screen.value in SHOP_ONLY) screen.value = Screen.Floor
            }
        }
    }
    val clockAhead: StateFlow<Long?> = api.clockAhead
    val updateRequired: StateFlow<Boolean> = api.updateRequired
    // POS settings, Security: minutes without a touch before the till locks; 0 is never
    val lockMinutes: StateFlow<Int> = db.ops().settingsFlow().map { com.restopos.core.data.PosSettings.parse(it).lockMinutes }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    // a booking waiting to be given a table on the floor plan
    val assigning = MutableStateFlow<BookingEntity?>(null)
    val user: StateFlow<StaffMember?> = staff.current
    private val store = flow { emit(session.storeId()) }

    val badges: StateFlow<Badges> = store.flatMapLatest { s ->
        if (s == null) emptyFlow()
        else combine(db.service().board(s), db.service().kdsLines(), service.bookingsToday(s)) { board, kitchen, bookings ->
            Badges(board.count { it.stage == "new" }, kitchen.mapNotNull { it.kds_id }.distinct().size, bookings.count { it.status == "confirmed" || it.status == "pending" })
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), Badges())

    // who can take over the till from the side menu: everyone with a PIN
    val team: StateFlow<List<StaffMember>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else staffRepo.staff(s).map { list -> list.filter { it.hasPin } } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val needsSignIn: StateFlow<Boolean> = session.needsSignIn.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    val pending: StateFlow<Long> = db.outbox().pendingCountFlow().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    val rejected: StateFlow<Long> = db.outbox().deadCountFlow().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    val lang: StateFlow<String> = session.lang.stateIn(viewModelScope, SharingStarted.Eagerly, "en")
    // a shop's scan mode: the scanner's keys are taken below the screen (see Scanner)
    val scanMode: StateFlow<Boolean> = session.scanMode.stateIn(viewModelScope, SharingStarted.Eagerly, false)

    fun go(to: Screen) {
        if (to != Screen.Floor) assigning.value = null
        screen.value = to
    }

    // Quick sale: the counter order that is open comes back; otherwise a new one starts.
    fun quick(then: () -> Unit = {}) = viewModelScope.launch {
        val types = db.catalog().diningOptions()
        val open = tickets.activeTicket()
        val kind = open?.dining_option_id?.let { id -> types.firstOrNull { it.id == id }?.kind } ?: if (open?.table_id != null) "dine" else "counter"
        if (open == null || kind != "counter") {
            tickets.startOrder(tickets.counterTypeId())
        }
        screen.value = Screen.Order
        then()
    }

    fun assign(b: BookingEntity) { assigning.value = b; screen.value = Screen.Floor }

    fun setLang(code: String) = viewModelScope.launch { session.setLang(code) }

    // The hash takes a moment by design; keep it off the main thread. Wrong
    // PINs lock that name for a minute, as on the start screen.
    suspend fun checkPin(member: StaffMember, pin: String): PinCheck {
        val id = member.employee.id
        staff.lockedFor(id).takeIf { it > 0 }?.let { return PinCheck.Locked((it + 999) / 1000) }
        val ok = withContext(Dispatchers.Default) { PinHash.matches(pin, member.employee.pin_hash) }
        return if (ok) { staff.rightPin(id); PinCheck.Ok }
        else {
            staff.wrongPin(id)
            staff.lockedFor(id).takeIf { it > 0 }?.let { PinCheck.Locked((it + 999) / 1000) } ?: PinCheck.Wrong
        }
    }

    fun switchTo(member: StaffMember) {
        staff.signIn(member)
        Toaster.say("Signed in as ${member.employee.name}")
    }
}

private class Nav(val screen: Screen, val icon: String, val label: () -> String)

private val SERVICE = listOf(
    Nav(Screen.Floor, VI.Floor) { L.tables }, Nav(Screen.Order, VI.Bolt) { L.quick }, Nav(Screen.Takeaway, VI.Bag) { L.takeaway },
    Nav(Screen.Kitchen, VI.Screen) { L.kitchen }, Nav(Screen.Bookings, VI.Calendar) { L.bookings }, Nav(Screen.Orders, VI.Orders) { L.orders },
)
private val BACK = listOf(
    Nav(Screen.Today, VI.Bars) { L.today }, Nav(Screen.Menu, VI.List) { L.menuStock }, Nav(Screen.Cash, VI.Cash) { L.cashDrawer },
    Nav(Screen.Receipts, VI.Receipt) { L.receipts }, Nav(Screen.Customers, VI.People) { L.customers }, Nav(Screen.Settings, VI.Gear) { L.settings },
)
// A shop's till, after the approved "Sell" board: Sell, Receipts, Customers,
// Products & stock, Today, More. More is the settings screen, which has the
// printers and the tablet's own switches; the cash drawer, with opening and
// closing the day, is in the side menu.
private val SHOP = listOf(
    Nav(Screen.Sell, VI.Bolt) { L.sell }, Nav(Screen.Receipts, VI.Receipt) { L.receipts }, Nav(Screen.Customers, VI.People) { L.customers },
    Nav(Screen.Products, VI.List) { L.productsStock }, Nav(Screen.Today, VI.Bars) { L.todayShort }, Nav(Screen.Settings, VI.More) { L.more },
)
// Stock check is a look-up, not a place of its own along the top: it is here and under the sale's More.
private val SHOP_BACK = listOf(Nav(Screen.StockCheck, VI.Search) { "Stock check" }, Nav(Screen.Cash, VI.Cash) { L.cashDrawer })

// What is always on screen once someone is at the till: the top bar with the
// service screens, the open screen under it, and the side menu behind the
// menu key.
@Composable
fun MainShell(
    onSignIn: () -> Unit,
    onRejected: () -> Unit,
    onLock: () -> Unit,
    onOpenPeriod: () -> Unit,
    onSignOut: () -> Unit,
) {
    val shell: ShellViewModel = hiltViewModel()
    val floor: FloorViewModel = hiltViewModel()
    val order: OrderViewModel = hiltViewModel()
    val sell: RetailViewModel = hiltViewModel()
    val kind by shell.retail.collectAsState()
    val retail = kind == true
    val pay: PayViewModel = hiltViewModel()
    val more: MoreViewModel = hiltViewModel()
    // the receipts list is held here so that a receipt scanned on the sell screen can be opened on it
    val receipts: ReceiptsViewModel = hiltViewModel()
    val screen by shell.screen.collectAsState()
    val user by shell.user.collectAsState()
    val badges by shell.badges.collectAsState()
    val assigning by shell.assigning.collectAsState()
    val needsSignIn by shell.needsSignIn.collectAsState()
    val pending by shell.pending.collectAsState()
    val rejected by shell.rejected.collectAsState()
    val lang by shell.lang.collectAsState()
    val orderUi by order.ui.collectAsState()
    var drawer by remember { mutableStateOf(false) }
    var confirmSignOut by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(10_000) } }
    LaunchedEffect(lang) { L.lang = lang }
    val clockAhead by shell.clockAhead.collectAsState()
    val updateRequired by shell.updateRequired.collectAsState()
    // Left alone for the minutes set in the back office, the till goes back to
    // its start screen, where a name and its PIN open it again. The order on
    // the register is kept. The kitchen display is read, not touched, so it
    // never locks; nor does a payment that is under way.
    val lockAfter by shell.lockMinutes.collectAsState()
    var touched by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(lockAfter, screen) {
        if (lockAfter <= 0 || screen == Screen.Kitchen || screen == Screen.Pay) return@LaunchedEffect
        touched = System.currentTimeMillis()
        while (true) {
            delay(15_000)
            if (System.currentTimeMillis() - touched >= lockAfter * 60_000L) { onLock(); break }
        }
    }
    LaunchedEffect(screen) { if (screen == Screen.Pay || screen == Screen.Split) order.open() }
    // Scan mode holds on a shop's screens that take a scanner, and nowhere
    // else: a payment, a restaurant's screens and the start screen get their
    // keys as always.
    val scanMode by shell.scanMode.collectAsState()
    SideEffect {
        Scanner.mode = scanMode
        Scanner.taking = retail && (screen == Screen.Sell || screen == Screen.Products || screen == Screen.StockCheck || screen == Screen.Receipts)
    }
    DisposableEffect(Unit) { onDispose { Scanner.taking = false } }
    // what a printer said when it could not print behind the scenes, and what Settings has to say
    LaunchedEffect(Unit) { more.load(); more.problems.collect { Toaster.say(it) } }
    val said by more.message.collectAsState()
    LaunchedEffect(said) { said?.let { Toaster.say(it); more.messageShown() } }

    // Quick sale was tapped with the order screen at this turn: its key is lit at once, before the sale is read
    var quickAt by remember { mutableIntStateOf(-1) }
    val go: (Screen) -> Unit = { s -> drawer = false; if (s == Screen.Order) { quickAt = orderUi.session; shell.quick { order.open() } } else shell.go(s) }
    // the keys along the top: a shop's, or a restaurant's
    val bar = if (retail) SHOP else SERVICE
    // The key that is lit: the place, or for an order where that order lives.
    // An order screen that has only just opened still holds the order before
    // it until the new one is read, so the key that was lit stays lit until
    // then: the pill goes to its key once, never by way of the wrong one.
    val inOrder = screen == Screen.Order || screen == Screen.Pay || screen == Screen.Split
    val entered = remember(inOrder) { orderUi.session }
    val litBefore = remember { arrayOf(Screen.Floor) }
    val lit = when {
        // a shop's sale is one place: paying it is still Sell
        retail -> if (screen == Screen.Pay || screen == Screen.Split) Screen.Sell else screen
        quickAt == orderUi.session -> Screen.Order
        !inOrder -> screen
        orderUi.session == entered -> litBefore[0]
        else -> when (orderUi.kind) { "dine" -> Screen.Floor; "takeaway", "delivery" -> Screen.Takeaway; else -> Screen.Order }
    }
    SideEffect { litBefore[0] = lit }
    val cal = remember(now / 60_000) { Calendar.getInstance() }
    val date = remember(now / 3_600_000, lang) { SimpleDateFormat("EEE d MMM", if (L.fr) Locale.FRANCE else Locale.UK).format(Date(now)) }
    val serviceLine = (if (cal.get(Calendar.HOUR_OF_DAY) < 16) L.lunch else L.dinner) + " · " + date
    val home = { board: Boolean -> shell.go(if (board) Screen.Takeaway else Screen.Floor) }

    // Back never drops out to the start screen (that is Lock, in the menu):
    // it closes the menu, steps back from an order, or goes to the floor.
    BackHandler(enabled = screen != Screen.Pay) {
        when {
            drawer -> drawer = false
            retail -> if (screen != Screen.Sell) shell.go(Screen.Sell)
            screen == Screen.Order -> home(orderUi.board)
            screen == Screen.Split -> shell.go(Screen.Order)
            screen != Screen.Floor -> shell.go(Screen.Floor)
        }
    }

    // which kind of business this is, is read from the tablet in a moment: nothing is drawn for the wrong one meanwhile
    if (kind == null) { Box(Modifier.fillMaxSize().background(V.Bg)); return }
    Box(
        Modifier.fillMaxSize().background(V.Bg)
            // any finger anywhere counts as someone being at the till
            .pointerInput(Unit) { awaitPointerEventScope { while (true) { awaitPointerEvent(PointerEventPass.Initial); touched = System.currentTimeMillis() } } },
    ) {
        Column(Modifier.fillMaxSize()) {
            Row(
                Modifier.fillMaxWidth().height(64.dp).background(V.Header)
                    .drawBehind { drawRect(V.HeaderLine, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx())) }.padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Box(Modifier.size(48.dp).press { drawer = true }.clip(RoundedCornerShape(12.dp)).background(V.Panel), contentAlignment = Alignment.Center) {
                    VIcon(VI.Menu, 22.dp, V.Text)
                }
                Wordmark()
                // the service screens, straight on the bar: the lit one on a pill that slides to whichever is tapped
                Box(Modifier.weight(1f)) {
                    PillRow(bar.size, bar.indexOfFirst { it.screen == lit }, { go(bar[it].screen) }, scroll = rememberScrollState()) { i, onPill, m ->
                        val n = bar[i]
                        val count = when (n.screen) { Screen.Takeaway -> badges.takeaway; Screen.Kitchen -> badges.kitchen; Screen.Bookings -> badges.bookings; else -> 0 }
                        Row(m.height(42.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            VIcon(n.icon, 19.dp, if (onPill) V.OnText else V.Text2)
                            T(n.label(), 15.sp, 700, if (onPill) V.OnText else V.Text2)
                            if (count > 0) Badge(count, when (n.screen) { Screen.Takeaway -> V.Red; Screen.Kitchen -> V.Blue; else -> Color(0xFF6243C8) })
                        }
                    }
                }
                if (pending > 0 || rejected > 0 || needsSignIn) {
                    Box(Modifier.size(10.dp).clip(CircleShape).background(if (rejected > 0 || needsSignIn) V.Red else V.Amber))
                }
                Column(horizontalAlignment = Alignment.End) {
                    T(SimpleDateFormat("HH:mm", Locale.US).format(Date(now)), 18.sp, 800)
                    T(date, 12.sp, 600, V.Text2)
                }
                val name = user?.employee?.name ?: "Till"
                Row(
                    Modifier.height(48.dp).press { drawer = true }.clip(RoundedCornerShape(24.dp)).background(V.Panel).padding(start = 6.dp, end = 16.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Box(Modifier.size(36.dp).clip(CircleShape).background(V.Blue), contentAlignment = Alignment.Center) { T(name.take(1).uppercase(), 15.sp, 800, Color.White) }
                    T(name.substringBefore(' '), 15.sp, 700, modifier = Modifier.widthIn(max = 96.dp))
                }
            }
            SyncNotices(needsSignIn, pending, rejected, onSignIn, onRejected, clockAhead, updateRequired)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (screen) {
                    Screen.Floor -> FloorScreen(floor, assigning, onAssigned = { shell.assigning.value = null }, onOrder = { shell.go(Screen.Order) }, onPay = { shell.go(Screen.Pay) }, onBookings = { shell.go(Screen.Bookings) })
                    Screen.Order -> OrderScreen(order, onBack = home, onPay = { shell.go(Screen.Pay) }, onSplit = { shell.go(Screen.Split) }, onSent = { shell.go(Screen.Floor) }, onGone = home)
                    Screen.Pay -> PayScreen(pay, onBack = { shell.go(if (retail) Screen.Sell else Screen.Order) }, onSplit = { shell.go(Screen.Split) }) { kind ->
                        when {
                            // a shop's sale is paid: the sell screen again, with an empty sale
                            retail -> { shell.go(Screen.Sell); sell.open() }
                            kind == "dine" -> { floor.pick(null); shell.go(Screen.Floor) }
                            kind == "takeaway" || kind == "delivery" -> shell.go(Screen.Takeaway)
                            else -> shell.quick { order.open() }
                        }
                    }
                    Screen.Split -> SplitScreen(onBack = { shell.go(if (retail) Screen.Sell else Screen.Order) }, onPay = { shell.go(Screen.Pay) })
                    Screen.Sell -> RetailSellScreen(
                        sell, more, onPay = { shell.go(Screen.Pay) }, onReceipts = { shell.go(Screen.Receipts) },
                        onReceipt = { id -> receipts.showId(id); shell.go(Screen.Receipts) }, onStock = { shell.go(Screen.StockCheck) },
                    )
                    Screen.Products -> { val vm: ProductsViewModel = hiltViewModel(); ProductsScreen(vm) }
                    Screen.StockCheck -> { val vm: StockCheckViewModel = hiltViewModel(); StockCheckScreen(vm, onBack = { shell.go(Screen.Sell) }) }
                    Screen.Takeaway -> { val vm: BoardViewModel = hiltViewModel(); BoardScreen(vm, onOrder = { shell.go(Screen.Order) }, onPay = { shell.go(Screen.Pay) }) }
                    Screen.Kitchen -> { val vm: KdsViewModel = hiltViewModel(); KdsScreen(vm) }
                    Screen.Bookings -> { val vm: BookingsViewModel = hiltViewModel(); BookingsScreen(vm, serviceLine, onAssign = { b -> b.area?.let { floor.pickZone(it) }; shell.assign(b) }, onSeated = { shell.go(Screen.Order) }) }
                    Screen.Orders -> Box(Modifier.padding(top = 12.dp)) { OrdersScreen(onOpen = { shell.go(Screen.Order) }) }
                    Screen.Today -> { val vm: TodayViewModel = hiltViewModel(); TodayScreen(vm, if (retail) date else serviceLine) }
                    Screen.Menu -> { val vm: MenuViewModel = hiltViewModel(); MenuStockScreen(vm) }
                    Screen.Cash -> { val vm: CashViewModel = hiltViewModel(); CashScreen(vm, onOpenPeriod = onOpenPeriod, onClosed = onLock) }
                    Screen.Receipts -> Box(Modifier.padding(top = 12.dp)) { ReceiptsScreen(receipts, onExchange = { shell.go(Screen.Sell) }) }
                    Screen.Customers -> Box(Modifier.padding(top = 12.dp)) { CustomersScreen() }
                    Screen.Settings -> Box {
                        SettingsScreen(
                            more, lock = if (user != null) "Log out" else "Lock", onLock = onLock, onSignIn = onSignIn, onRejected = onRejected,
                            onClosePeriod = { shell.go(Screen.Cash) }, onCountDrawer = { shell.go(Screen.Cash) }, onSignOut = { confirmSignOut = true },
                        )
                    }
                }
            }
        }
        SideMenu(drawer, shell, lit, badges, user, lang, retail, onGo = go, onLock = { drawer = false; onLock() }, onClose = { drawer = false })
        ToastHost()
    }

    if (confirmSignOut) {
        Sheet(onDismiss = { confirmSignOut = false }, width = 560.dp) {
            SheetHead("Sign this tablet out?", "This clears the menu and the receipt list from this tablet. Sales already synced stay in the back office. It is refused while a sale is still waiting to sync or an order is still unpaid.") { confirmSignOut = false }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Cancel", Modifier.weight(1f), height = 60.dp) { confirmSignOut = false }
                VBtn("Sign out", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800) { confirmSignOut = false; onSignOut() }
            }
        }
    }
}

// The side menu: every screen, the language, and who is at the till. It
// slides out from the left as the screen behind it dims, follows a finger
// that drags it, and goes back the way it came: let go on its way shut, or
// flicked shut, it closes; otherwise it comes back out.
@Composable
private fun SideMenu(
    open: Boolean, shell: ShellViewModel, lit: Screen, badges: Badges, user: StaffMember?, lang: String, retail: Boolean,
    onGo: (Screen) -> Unit, onLock: () -> Unit, onClose: () -> Unit,
) {
    val wide = with(LocalDensity.current) { 340.dp.toPx() }
    val out = remember { Animatable(0f) } // how far out it is: 0 is off the screen, 1 is all the way
    val flick = remember { floatArrayOf(0f) } // the speed a finger let it go at
    LaunchedEffect(open) {
        val v = flick[0]
        flick[0] = 0f
        when {
            v != 0f -> out.animateTo(if (open) 1f else 0f, Motion.Settle, v)
            open -> out.animateTo(1f, Motion.enter())
            else -> out.animateTo(0f, Motion.exit())
        }
    }
    val gone by remember { derivedStateOf { out.value == 0f } }
    if (!open && gone) return

    val team by shell.team.collectAsState()
    var asking by remember { mutableStateOf<StaffMember?>(null) }
    val scope = rememberCoroutineScope()
    val drag = rememberDraggableState { by -> scope.launch { out.snapTo((out.value + by / wide).coerceIn(0f, 1f)) } }
    Box(
        Modifier.fillMaxSize().drawBehind { drawRect(Color.Black, alpha = 0.55f * out.value) }
            .draggable(drag, Orientation.Horizontal, enabled = open, onDragStopped = { v ->
                if (v < -900f || out.value < 0.6f) { flick[0] = v / wide; onClose() } else out.animateTo(1f, Motion.Settle, v / wide)
            })
            // once it is on its way shut, a tap goes to the screen behind it
            .then(if (open) Modifier.quietTap(onClose) else Modifier),
    ) {
        Column(
            Modifier.width(340.dp).fillMaxHeight().graphicsLayer { translationX = (out.value - 1f) * wide }.background(V.Panel)
                .drawBehind { drawRect(V.Stroke, Offset(size.width - 1.dp.toPx(), 0f), Size(1.dp.toPx(), size.height)) }
                .quietTap {}.verticalScroll(rememberScrollState()).padding(horizontal = 14.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(Modifier.padding(start = 6.dp, end = 6.dp, top = 2.dp, bottom = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Wordmark()
                Gap()
                IconKey(VI.Close, onClick = onClose)
            }
            if (retail) {
                // a shop: the same places as along the top, and the cash drawer
                Spacer(Modifier.height(4.dp))
                (SHOP + SHOP_BACK).forEach { n -> Entry(n, lit == n.screen, 0, V.Red) { onGo(n.screen) } }
            } else {
                Caps(L.service, modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 6.dp))
                SERVICE.forEach { n ->
                    val count = when (n.screen) { Screen.Takeaway -> badges.takeaway; Screen.Kitchen -> badges.kitchen; Screen.Bookings -> badges.bookings; else -> 0 }
                    Entry(n, lit == n.screen, count, when (n.screen) { Screen.Takeaway -> V.Red; Screen.Kitchen -> V.Blue; else -> Color(0xFF6243C8) }) { onGo(n.screen) }
                }
                Caps(L.backOffice, modifier = Modifier.padding(start = 12.dp, top = 16.dp, bottom = 6.dp))
                BACK.forEach { n -> Entry(n, lit == n.screen, 0, V.Red) { onGo(n.screen) } }
            }
            Caps(L.language, modifier = Modifier.padding(start = 12.dp, top = 16.dp, bottom = 8.dp))
            Seg(
                listOf(
                    SegOption("English", lang != "fr" && lang != "mfe") { shell.setLang("en") },
                    SegOption("Français", lang == "fr") { shell.setLang("fr") },
                    SegOption("Kreol", lang == "mfe") { shell.setLang("mfe") },
                ),
                Modifier.fillMaxWidth().padding(horizontal = 4.dp), V.Well, 44.dp, 12.dp, fill = true,
            )
            if (team.isNotEmpty()) {
                Caps(L.switchStaff, modifier = Modifier.padding(start = 12.dp, top = 16.dp, bottom = 6.dp))
                team.forEach { m ->
                    val me = user?.employee?.id == m.employee.id
                    Row(
                        Modifier.fillMaxWidth().height(54.dp).clip(RoundedCornerShape(12.dp)).background(if (me) V.Key else Color.Transparent)
                            .clickable { if (!me) asking = m }.padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Box(Modifier.size(34.dp).clip(CircleShape).background(V.TableFree).border(2.dp, if (me) V.Cyan else V.Stroke2, CircleShape), contentAlignment = Alignment.Center) {
                            T(m.employee.name.take(1).uppercase(), 14.sp, 800)
                        }
                        T(m.employee.name, 16.sp, 700, modifier = Modifier.weight(1f))
                        m.role?.let { T(it, 12.sp, 600, V.Text3) }
                    }
                }
            }
            Spacer(Modifier.height(12.dp))
            VBtn(L.lock, Modifier.fillMaxWidth(), icon = VI.Lock, onClick = onLock)
        }
    }
    asking?.let { m ->
        PinPad(m, check = { shell.checkPin(m, it) }, onOk = { asking = null; shell.switchTo(m); onClose() }, onDismiss = { asking = null })
    }
}

@Composable
private fun Entry(n: Nav, on: Boolean, count: Int, badge: Color, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(54.dp).clip(RoundedCornerShape(12.dp)).background(if (on) V.Key else Color.Transparent).clickable(onClick = onClick).padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        VIcon(n.icon, 20.dp, if (on) V.Text else V.Dim)
        T(n.label(), 16.sp, 700, if (on) V.Text else V.Dim, Modifier.weight(1f))
        if (count > 0) Badge(count, badge, 22.dp)
    }
}

// What the till needs someone to know about syncing, in a strip under the top
// bar. Selling carries on in every one of these states.
@Composable
private fun SyncNotices(needsSignIn: Boolean, pending: Long, rejected: Long, onSignIn: () -> Unit, onRejected: () -> Unit, clockAhead: Long?, updateRequired: Boolean) {
    if (updateRequired) {
        Row(Modifier.fillMaxWidth().background(V.RedWash).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            T(
                "This till is too old to sync: it must be updated. It keeps selling and keeps every sale" +
                    (if (pending > 0) " ($pending waiting)" else "") + " until then. Ask EasyPay for the new version.",
                13.sp, 600, V.RedText, Modifier.weight(1f), lines = 2,
            )
        }
    }
    // Five minutes is past any honest drift. A receipt carries the tablet's
    // time, so a clock that is hours out books sales to the wrong day.
    val off = clockAhead?.let { kotlin.math.abs(it) / 60_000 } ?: 0
    if (off >= 5) {
        val by = if (off >= 120) "${off / 60} hours" else "$off minutes"
        Row(Modifier.fillMaxWidth().background(V.RedWash).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            T(
                "This tablet's clock is $by ${if ((clockAhead ?: 0) > 0) "fast" else "slow"}. Receipts carry the tablet's time: set the date and time in the tablet's own settings (automatic date and time).",
                13.sp, 600, V.RedText, Modifier.weight(1f), lines = 2,
            )
        }
    }
    if (needsSignIn) {
        Row(Modifier.fillMaxWidth().background(V.RedWash).padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            T(
                "This tablet cannot sync: its login was signed out or switched off. " +
                    (if (pending > 0) "$pending changes are saved here. " else "Sales are saved here. ") + "Sign in with a login of this business to send them.",
                13.sp, 600, V.RedText, Modifier.weight(1f), lines = 2,
            )
            VBtn("Sign in", bg = V.Red, fg = Color.White, height = 38.dp, radius = 10.dp, size = 14.sp, onClick = onSignIn)
        }
    }
    if (rejected > 0) {
        Row(Modifier.fillMaxWidth().background(V.RedWash).padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            T("$rejected changes were refused by the server", 13.sp, 600, V.RedText, Modifier.weight(1f))
            VBtn("Review", height = 38.dp, radius = 10.dp, size = 14.sp, onClick = onRejected)
        }
    }
}

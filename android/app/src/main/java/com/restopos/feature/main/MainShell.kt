package com.restopos.feature.main

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ExitToApp
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.restopos.core.ui.Avatar
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import com.restopos.feature.more.MoreSheets
import com.restopos.feature.more.MoreViewModel
import com.restopos.feature.more.OrderTypeDialog
import kotlinx.coroutines.delay
import com.restopos.feature.orders.OrdersScreen
import com.restopos.feature.receipts.ReceiptsScreen
import com.restopos.feature.sale.RegisterScreen
import com.restopos.feature.sale.SaleAction
import com.restopos.feature.sale.SaleViewModel
import com.restopos.feature.settings.SettingsScreen
import com.restopos.feature.tables.TablesScreen

// The lists are picked in the top bar. Settings is in the side menu. The
// register is the order screen: New order, an order or a table opens it, and
// Close goes back to the list it was opened from.
enum class Tab(val label: String) { Plan("Floor plan"), Orders("Orders"), Receipts("Receipts"), Settings("Settings"), Register("Register") }

private val LISTS = listOf(Tab.Plan, Tab.Orders, Tab.Receipts)
private val BAR = 56.dp
private val MENU = 250.dp

// What is always on screen once the till is set up: the top bar, the sync
// notices and the open screen.
@Composable
fun MainShell(
    onPay: () -> Unit,
    onSplit: () -> Unit,
    onPaid: (String, Long, Long) -> Unit,
    onSignIn: () -> Unit,
    onRejected: () -> Unit,
    onLock: () -> Unit,
    onClosePeriod: () -> Unit,
    onCountDrawer: () -> Unit,
    onSignOut: () -> Unit,
) {
    val vm: SaleViewModel = hiltViewModel()
    val more: MoreViewModel = hiltViewModel()
    val user by vm.user.collectAsState()
    val shift by vm.shift.collectAsState()
    val till by vm.till.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val rejected by vm.rejected.collectAsState()
    var tab by rememberSaveable { mutableStateOf(Tab.Register) }
    // the list Close goes back to
    var home by rememberSaveable { mutableStateOf(Tab.Orders) }
    var menu by rememberSaveable { mutableStateOf(false) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var confirmSignOut by remember { mutableStateOf(false) }
    // which of the side menu's dialogs is open: "in", "out", "shift", "day"
    var sheet by remember { mutableStateOf<String?>(null) }
    var pickType by remember { mutableStateOf(false) }
    val types by more.types.collectAsState()
    val said by more.message.collectAsState()
    // what a printer said when it could not print behind the scenes
    var printerSaid by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { more.load(); more.problems.collect { printerSaid = it } }
    printerSaid?.let { m -> LaunchedEffect(m) { delay(7000); printerSaid = null } }
    said?.let { m -> LaunchedEffect(m) { delay(5000); more.messageShown() } }
    // true while the floor plan is open to pick where the order on the register moves to
    var moving by remember { mutableStateOf(false) }
    val closeSearch = { searching = false; vm.onAction(SaleAction.Search("")); Unit }
    val go = { t: Tab ->
        if (searching) closeSearch()
        moving = false
        menu = false
        if (t != Tab.Register) home = t
        tab = t
    }
    val alert = rejected > 0 || needsSignIn
    // green only says nothing is waiting here; the till cannot see the network itself
    val sync = when {
        alert -> Pos.Pink
        pending > 0 -> Pos.Warn
        else -> Pos.Ok
    }
    val slide by animateDpAsState(if (menu) MENU else 0.dp, label = "menu")
    // the tablet's Back key closes what is open, as Close and the menu button do
    BackHandler(enabled = tab == Tab.Register || menu) { if (menu) menu = false else go(home) }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        // the side menu pushes the screen to the right, it does not squeeze it
        Column(Modifier.fillMaxSize().offset(x = slide)) {
            if (tab == Tab.Register) {
                RegisterBar(
                    title = user?.employee?.name ?: till.ifBlank { "RestoPOS" },
                    sync = sync, pending = pending, searching = searching,
                    onClose = { go(home) },
                    onSearch = { if (searching) closeSearch() else searching = true },
                    onMenu = { menu = !menu },
                )
            } else {
                NavBar(
                    tab = tab,
                    // back to the start screen; signing the tablet out is under Settings
                    lock = if (user != null) "Log out" else "Lock",
                    name = user?.employee?.name,
                    sync = sync, pending = pending, alert = alert,
                    onLock = onLock,
                    onMenu = { menu = !menu },
                    onTab = go,
                    // more than one order type: ask which (Dine in, Take away)
                    onNew = { if (types.size > 1) pickType = true else vm.newOrder { go(Tab.Register) } },
                )
            }
            SyncNotices(needsSignIn, pending, rejected, onSignIn, onRejected)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (tab) {
                    Tab.Register -> RegisterScreen(
                        vm, searching, closeSearch, { if (vm.mayPay()) onPay() }, onPaid,
                        onTables = { tab = Tab.Plan },
                        onMoveTable = { moving = true; tab = Tab.Plan },
                        onSaved = { go(home) },
                        onSplit = { if (vm.mayPay()) onSplit() },
                    )
                    Tab.Plan -> TablesScreen(
                        moving,
                        onOpen = { go(Tab.Register) },
                        onCancelMove = { go(Tab.Register) },
                    )
                    Tab.Orders -> OrdersScreen(onOpen = { go(Tab.Register) })
                    Tab.Receipts -> ReceiptsScreen()
                    Tab.Settings -> SettingsScreen(
                        more, lock = if (user != null) "Log out" else "Lock", onLock = onLock,
                        onSignIn = onSignIn, onRejected = onRejected, onClosePeriod = onClosePeriod, onCountDrawer = onCountDrawer,
                        onSignOut = { confirmSignOut = true },
                    )
                }
            }
        }
        if (slide > 0.dp) {
            SideMenu(
                Modifier.width(MENU).offset(x = slide - MENU), tab, alert,
                lock = if (user != null) "Log out" else "Lock",
                onClose = { menu = false }, onTab = go,
                onDrawer = { menu = false; more.openDrawer() },
                onSheet = { menu = false; sheet = it },
                onCount = { menu = false; if (shift == null) more.say("No shift is open.") else onCountDrawer() },
                onLock = { menu = false; onLock() },
            )
        }
        (printerSaid ?: said)?.let { m ->
            Text(
                m,
                Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp))
                    .background(if (printerSaid != null) Pos.Warn else Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    MoreSheets(more, sheet, onDismiss = { sheet = null }, onCloseShift = onClosePeriod)
    if (pickType) {
        OrderTypeDialog(types, onDismiss = { pickType = false }) { t ->
            pickType = false
            // an order that needs a table starts on the floor plan
            vm.startOrder(t.id) { go(if (t.needs_table) Tab.Plan else Tab.Register) }
        }
    }

    if (confirmSignOut) {
        AlertDialog(
            onDismissRequest = { confirmSignOut = false },
            title = { Text("Sign out of this till?") },
            text = { Text("This clears the menu and the receipt list from this tablet. Sales already synced stay in the back office. Signing out is refused while a sale is still waiting to sync or an order is still unpaid.") },
            confirmButton = { Button(onClick = { confirmSignOut = false; onSignOut() }) { Text("Sign out") } },
            dismissButton = { OutlinedButton(onClick = { confirmSignOut = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun NavBar(
    tab: Tab,
    lock: String,
    name: String?,
    sync: Color,
    pending: Long,
    alert: Boolean,
    onLock: () -> Unit,
    onMenu: () -> Unit,
    onTab: (Tab) -> Unit,
    onNew: () -> Unit,
) {
    Box(Modifier.fillMaxWidth().height(BAR)) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.clickable(onClick = onLock).padding(start = 14.dp, end = 10.dp, top = 16.dp, bottom = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.AutoMirrored.Filled.ExitToApp, contentDescription = null, tint = Pos.Link, modifier = Modifier.size(22.dp))
                Text(lock, Modifier.padding(start = 6.dp), color = Pos.Link, fontSize = 16.sp)
            }
            SyncMark(sync, pending)
            if (name != null) {
                Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Avatar(name, 24.dp)
                    Text(
                        name, Modifier.padding(start = 7.dp).widthIn(max = 96.dp),
                        color = Pos.Text2, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
        Row(
            Modifier.align(Alignment.Center).clip(RoundedCornerShape(22.dp)).background(Pos.Panel).border(1.dp, Pos.Stroke, RoundedCornerShape(22.dp)).padding(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.clip(CircleShape).clickable(onClick = onMenu).padding(horizontal = 14.dp, vertical = 8.dp)) {
                Icon(PosIcons.SidePanel, contentDescription = "Menu", tint = Pos.Text2, modifier = Modifier.size(20.dp))
                if (alert) Box(Modifier.align(Alignment.TopEnd).size(8.dp).clip(CircleShape).background(Pos.Pink))
            }
            LISTS.forEach { t ->
                val on = t == tab
                Text(
                    t.label,
                    Modifier.clip(RoundedCornerShape(18.dp)).background(if (on) Pos.Selected else Color.Transparent)
                        .clickable { onTab(t) }.padding(horizontal = 18.dp, vertical = 8.dp),
                    color = if (on) Pos.Text else Pos.Text2, fontSize = 16.sp, fontWeight = if (on) FontWeight.Medium else FontWeight.Normal,
                )
            }
        }
        // the one thing this bar is for
        Row(
            Modifier.align(Alignment.CenterEnd).padding(end = 14.dp).height(40.dp).clip(RoundedCornerShape(20.dp)).background(Pos.TabOn)
                .clickable(onClick = onNew).padding(start = 12.dp, end = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.AddCircle, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp))
            Text("New order", Modifier.padding(start = 8.dp), color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

// The register's own bar: Close on the left, who is selling in the middle.
@Composable
private fun RegisterBar(title: String, sync: Color, pending: Long, searching: Boolean, onClose: () -> Unit, onSearch: () -> Unit, onMenu: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(BAR)) {
        Row(Modifier.align(Alignment.CenterStart), verticalAlignment = Alignment.CenterVertically) {
            Text("Close", Modifier.clickable(onClick = onClose).padding(start = 16.dp, end = 10.dp, top = 16.dp, bottom = 16.dp), color = Pos.Link, fontSize = 16.sp)
            SyncMark(sync, pending)
        }
        Text(
            title, Modifier.align(Alignment.Center).padding(horizontal = 200.dp),
            color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Row(Modifier.align(Alignment.CenterEnd), verticalAlignment = Alignment.CenterVertically) {
            // the same side menu as on the lists: the cash drawer, cash in and out, the closings
            Icon(
                PosIcons.SidePanel, contentDescription = "Menu", tint = Pos.Link,
                modifier = Modifier.clip(CircleShape).clickable(onClick = onMenu).padding(10.dp).size(24.dp),
            )
            Icon(
                Icons.Filled.Search, contentDescription = "Search the menu", tint = if (searching) Pos.Text else Pos.Link,
                modifier = Modifier.padding(end = 8.dp).clip(CircleShape).clickable(onClick = onSearch).padding(10.dp).size(26.dp),
            )
        }
    }
}

@Composable
private fun SyncMark(color: Color, pending: Long) {
    Icon(PosIcons.Signal, contentDescription = if (pending > 0) "Changes waiting to sync" else "Nothing waiting to sync", tint = color, modifier = Modifier.size(22.dp))
    if (pending > 0) Text("$pending to sync", Modifier.padding(start = 6.dp), color = Pos.Text3, fontSize = 12.sp)
}

// The side menu: the lists, then what a cashier does to the drawer and at the
// end of a shift and of the day, then this till.
@Composable
private fun SideMenu(
    modifier: Modifier,
    tab: Tab,
    alert: Boolean,
    lock: String,
    onClose: () -> Unit,
    onTab: (Tab) -> Unit,
    onDrawer: () -> Unit,
    onSheet: (String) -> Unit,
    onCount: () -> Unit,
    onLock: () -> Unit,
) {
    Column(modifier.fillMaxHeight().background(Pos.Panel).verticalScroll(rememberScrollState()).padding(vertical = 8.dp)) {
        Box(Modifier.padding(start = 8.dp, bottom = 4.dp).clip(CircleShape).clickable(onClick = onClose).padding(12.dp)) {
            Icon(PosIcons.SidePanel, contentDescription = "Close the menu", tint = Pos.Text2, modifier = Modifier.size(22.dp))
        }
        MenuRow(PosIcons.Grid, Tab.Plan, tab, onTab)
        MenuRow(Icons.AutoMirrored.Filled.List, Tab.Orders, tab, onTab)
        MenuRow(PosIcons.Receipt, Tab.Receipts, tab, onTab)
        MenuHead("Cash drawer")
        MenuAction("Open cash drawer", onDrawer)
        MenuAction("Cash in") { onSheet("in") }
        MenuAction("Cash out") { onSheet("out") }
        MenuAction("Count drawer", onCount)
        MenuHead("Closing")
        MenuAction("Shift") { onSheet("shift") }
        MenuAction("Day closing") { onSheet("day") }
        MenuHead("This till")
        MenuAction("Refund or reprint") { onTab(Tab.Receipts) }
        MenuRow(Icons.Filled.Settings, Tab.Settings, tab, onTab, dot = alert)
        MenuAction(lock, onLock)
    }
}

@Composable
private fun MenuHead(title: String) {
    Text(title, Modifier.padding(start = 20.dp, top = 16.dp, bottom = 4.dp), color = Pos.Text3, fontSize = 13.sp)
}

@Composable
private fun MenuAction(label: String, onClick: () -> Unit) {
    Text(
        label, Modifier.fillMaxWidth().clickable(onClick = onClick).padding(start = 52.dp, end = 20.dp, top = 12.dp, bottom = 12.dp),
        color = Pos.Text, fontSize = 16.sp,
    )
}

@Composable
private fun MenuRow(icon: ImageVector, to: Tab, tab: Tab, onTab: (Tab) -> Unit, dot: Boolean = false) {
    val on = to == tab
    Row(
        Modifier.fillMaxWidth().background(if (on) Pos.Selected else Color.Transparent).clickable { onTab(to) }
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = Pos.Link, modifier = Modifier.size(20.dp))
        Text(to.label, Modifier.padding(start = 12.dp), color = Pos.Text, fontSize = 16.sp)
        if (dot) Box(Modifier.padding(start = 8.dp).size(8.dp).clip(CircleShape).background(Pos.Pink))
    }
}

// What the till needs someone to know about syncing, in a strip under the top
// bar. Selling carries on in every one of these states.
@Composable
private fun SyncNotices(needsSignIn: Boolean, pending: Long, rejected: Long, onSignIn: () -> Unit, onRejected: () -> Unit) {
    if (needsSignIn) {
        Row(Modifier.fillMaxWidth().background(Pos.Danger).padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "This tablet cannot sync: its login was signed out or switched off. " +
                    (if (pending > 0) "$pending changes are saved here. " else "Sales are saved here. ") +
                    "Sign in with a login of this restaurant to send them.",
                Modifier.weight(1f), color = Pos.Text, fontSize = 13.sp,
            )
            Button(onClick = onSignIn) { Text("Sign in") }
        }
    }
    if (rejected > 0) {
        Row(Modifier.fillMaxWidth().background(Pos.Danger).padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("$rejected changes were refused by the server", Modifier.weight(1f), color = Pos.Text, fontSize = 13.sp)
            OutlinedButton(onClick = onRejected) { Text("Review", color = Pos.Text) }
        }
    }
}

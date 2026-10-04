package com.restopos.feature.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Person
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
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import com.restopos.feature.customers.CustomersScreen
import com.restopos.feature.more.MoreViewModel
import com.restopos.feature.orders.OrdersScreen
import com.restopos.feature.receipts.ReceiptsScreen
import com.restopos.feature.sale.RegisterScreen
import com.restopos.feature.sale.SaleAction
import com.restopos.feature.sale.SaleViewModel
import com.restopos.feature.settings.SettingsScreen
import com.restopos.feature.tables.TablesScreen
import kotlinx.coroutines.delay

// The six screens of the till, picked along the bottom. The register always
// holds an order: the one that was opened from Tables or Orders, or a new one.
enum class Tab(val label: String) {
    Register("Register"), Plan("Tables"), Orders("Orders"), Customers("Customers"), Receipts("Receipts"), Settings("Settings"),
}

private val TOP = 44.dp
private val BOTTOM = 54.dp

// What is always on screen once the till is set up: who is signed in along the
// top, the sync notices, the open screen, and the tabs along the bottom.
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
    val till by vm.till.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val rejected by vm.rejected.collectAsState()
    var tab by rememberSaveable { mutableStateOf(Tab.Register) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var confirmSignOut by remember { mutableStateOf(false) }
    val said by more.message.collectAsState()
    // what a printer said when it could not print behind the scenes
    var printerSaid by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { more.load(); more.problems.collect { printerSaid = it } }
    printerSaid?.let { m -> LaunchedEffect(m) { delay(7000); printerSaid = null } }
    said?.let { m -> LaunchedEffect(m) { delay(5000); more.messageShown() } }
    // true while Tables is open to pick where the order on the register goes
    var moving by remember { mutableStateOf(false) }
    val closeSearch = { searching = false; vm.onAction(SaleAction.Search("")); Unit }
    val go = { t: Tab ->
        if (searching) closeSearch()
        moving = false
        tab = t
    }
    val alert = rejected > 0 || needsSignIn
    // green only says nothing is waiting here; the till cannot see the network itself
    val sync = when {
        alert -> Pos.Pink
        pending > 0 -> Pos.Warn
        else -> Pos.Ok
    }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize()) {
            TitleBar(
                title = user?.employee?.name ?: till.ifBlank { "RestoPOS" },
                search = tab == Tab.Register, searching = searching,
                onSearch = { if (searching) closeSearch() else searching = true },
            )
            SyncNotices(needsSignIn, pending, rejected, onSignIn, onRejected)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (tab) {
                    Tab.Register -> RegisterScreen(
                        vm, searching, closeSearch, { if (vm.mayPay()) onPay() }, onPaid,
                        onTables = { tab = Tab.Plan },
                        onMoveTable = { moving = true; tab = Tab.Plan },
                        // sent and put away: the register stays, with a new order on it
                        onSaved = { },
                        onSplit = { if (vm.mayPay()) onSplit() },
                    )
                    Tab.Plan -> TablesScreen(
                        moving,
                        onOpen = { go(Tab.Register) },
                        onCancelMove = { go(Tab.Register) },
                    )
                    Tab.Orders -> OrdersScreen(onOpen = { go(Tab.Register) })
                    Tab.Customers -> CustomersScreen()
                    Tab.Receipts -> ReceiptsScreen()
                    Tab.Settings -> SettingsScreen(
                        more, lock = if (user != null) "Log out" else "Lock", onLock = onLock,
                        onSignIn = onSignIn, onRejected = onRejected, onClosePeriod = onClosePeriod, onCountDrawer = onCountDrawer,
                        onSignOut = { confirmSignOut = true },
                    )
                }
            }
            BottomBar(tab, sync, pending, onTab = go)
        }
        (printerSaid ?: said)?.let { m ->
            Text(
                m,
                Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = BOTTOM + 16.dp).clip(RoundedCornerShape(6.dp))
                    .background(if (printerSaid != null) Pos.Warn else Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
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

// Who is at the till, in the middle. On the register, the magnifier that
// searches the whole menu.
@Composable
private fun TitleBar(title: String, search: Boolean, searching: Boolean, onSearch: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(TOP).background(Pos.Panel)) {
        Text(
            title, Modifier.align(Alignment.Center).padding(horizontal = 120.dp),
            color = Pos.Text2, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        if (search) {
            Icon(
                Icons.Filled.Search, contentDescription = "Search the menu", tint = if (searching) Pos.Text else Pos.Text3,
                modifier = Modifier.align(Alignment.CenterEnd).padding(end = 8.dp).clip(CircleShape).clickable(onClick = onSearch).padding(8.dp).size(22.dp),
            )
        }
    }
}

private fun icon(t: Tab): ImageVector = when (t) {
    Tab.Register -> PosIcons.Drawer
    Tab.Plan -> PosIcons.Grid
    Tab.Orders -> Icons.AutoMirrored.Filled.List
    Tab.Customers -> Icons.Filled.Person
    Tab.Receipts -> PosIcons.Receipt
    Tab.Settings -> Icons.Filled.Settings
}

// The tabs, and at the end the state of the sync: three dots, green when
// nothing is waiting, amber when changes are, red when it needs someone.
@Composable
private fun BottomBar(tab: Tab, sync: Color, pending: Long, onTab: (Tab) -> Unit) {
    Row(Modifier.fillMaxWidth().height(BOTTOM).background(Pos.Panel), verticalAlignment = Alignment.CenterVertically) {
        Tab.entries.forEach { t ->
            val on = t == tab
            Row(
                Modifier.weight(1f).fillMaxHeight().background(if (on) Pos.PanelDeep else Color.Transparent).clickable { onTab(t) },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
            ) {
                Icon(icon(t), contentDescription = null, tint = if (on) Pos.Text else Pos.Text2, modifier = Modifier.size(20.dp))
                Text(
                    t.label, Modifier.padding(start = 8.dp), color = if (on) Pos.Text else Pos.Text2,
                    fontSize = 14.sp, fontWeight = if (on) FontWeight.Medium else FontWeight.Normal, maxLines = 1,
                )
            }
        }
        Column(
            Modifier.width(46.dp).fillMaxHeight().background(Pos.Key).clickable { onTab(Tab.Settings) },
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
        ) {
            repeat(3) { Box(Modifier.padding(vertical = 2.5.dp).size(4.dp).clip(CircleShape).background(sync)) }
            if (pending > 0) Text(if (pending > 99) "99+" else pending.toString(), color = Pos.Text3, fontSize = 9.sp)
        }
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

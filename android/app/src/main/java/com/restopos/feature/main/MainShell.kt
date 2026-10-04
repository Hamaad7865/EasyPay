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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.ShoppingCart
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import com.restopos.feature.orders.OrdersScreen
import com.restopos.feature.receipts.ReceiptsScreen
import com.restopos.feature.sale.RegisterScreen
import com.restopos.feature.sale.SaleAction
import com.restopos.feature.sale.SaleViewModel
import com.restopos.feature.settings.SettingsScreen

enum class Tab(val label: String) { Register("Register"), Orders("Orders"), Receipts("Receipts"), Settings("Settings") }

// What is always on screen once the till is set up: the top bar, the sync
// notices, the open tab, and the tab bar along the bottom.
@Composable
fun MainShell(
    onPay: () -> Unit,
    onPaid: (String, Long, Long) -> Unit,
    onSignIn: () -> Unit,
    onRejected: () -> Unit,
    onSignOut: () -> Unit,
) {
    val vm: SaleViewModel = hiltViewModel()
    val till by vm.till.collectAsState()
    val needsSignIn by vm.needsSignIn.collectAsState()
    val pending by vm.pending.collectAsState()
    val rejected by vm.rejected.collectAsState()
    var tab by rememberSaveable { mutableStateOf(Tab.Register) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var confirmSignOut by remember { mutableStateOf(false) }
    val closeSearch = { searching = false; vm.onAction(SaleAction.Search("")); Unit }

    Column(Modifier.fillMaxSize().background(Pos.Bg)) {
        Box(
            Modifier.fillMaxWidth().height(52.dp).background(Brush.verticalGradient(listOf(Pos.BarTop, Pos.BarBottom))),
        ) {
            Text(
                "Sign out",
                Modifier.align(Alignment.CenterStart).clickable { confirmSignOut = true }.padding(horizontal = 16.dp, vertical = 14.dp),
                color = Pos.Pink, fontSize = 14.sp,
            )
            Text(
                till.ifBlank { "RestoPOS" }, Modifier.align(Alignment.Center).padding(horizontal = 140.dp),
                color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Row(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (pending > 0) Text("$pending to sync", Modifier.padding(end = 8.dp), color = Pos.Text2, fontSize = 12.sp)
                if (tab == Tab.Register) {
                    Icon(
                        Icons.Filled.Search, contentDescription = "Search the menu", tint = Pos.NavOn,
                        modifier = Modifier.clip(CircleShape).clickable { if (searching) closeSearch() else searching = true }
                            .padding(10.dp).size(24.dp),
                    )
                }
            }
        }
        SyncNotices(needsSignIn, pending, rejected, onSignIn, onRejected)
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when (tab) {
                Tab.Register -> RegisterScreen(vm, searching, closeSearch, onPay, onPaid)
                Tab.Orders -> OrdersScreen(onOpen = { tab = Tab.Register })
                Tab.Receipts -> ReceiptsScreen()
                Tab.Settings -> SettingsScreen(till, needsSignIn, pending, rejected, onSignIn, onRejected) { confirmSignOut = true }
            }
        }
        Row(Modifier.fillMaxWidth().height(52.dp).background(Pos.Panel)) {
            Tab.entries.forEach { t ->
                val on = t == tab
                val tint = if (on) Pos.NavOn else Pos.Text3
                Row(
                    Modifier.weight(1f).fillMaxHeight().clickable { if (searching) closeSearch(); tab = t },
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(icon(t), contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
                    Text(t.label, Modifier.padding(start = 8.dp), color = tint, fontSize = 13.sp, fontWeight = if (on) FontWeight.Medium else FontWeight.Normal)
                    if (t == Tab.Settings && (rejected > 0 || needsSignIn)) {
                        Box(Modifier.padding(start = 6.dp).size(8.dp).clip(CircleShape).background(Pos.Pink))
                    }
                }
            }
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

private fun icon(tab: Tab): ImageVector = when (tab) {
    Tab.Register -> Icons.Filled.ShoppingCart
    Tab.Orders -> Icons.AutoMirrored.Filled.List
    Tab.Receipts -> PosIcons.Receipt
    Tab.Settings -> Icons.Filled.Settings
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

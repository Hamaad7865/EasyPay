package com.restopos.feature.sale

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.paging.compose.collectAsLazyPagingItems
import androidx.paging.compose.itemKey
import com.restopos.core.common.Money
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.ModPick
import kotlinx.coroutines.launch

// Tablet landscape: grid left, ticket right (design prototype). Phone portrait
// reuses the same entry; the ticket collapses into the Charge flow (7.9).
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SaleScreen(vm: SaleViewModel = hiltViewModel(), onPay: () -> Unit, onReceipts: () -> Unit, onSignOut: () -> Unit) {
    val state by vm.state.collectAsState(SaleUiState.Ready(emptyList(), null))
    val paged = vm.items.collectAsLazyPagingItems()
    val toast by vm.toast.collectAsState()
    val ticket by vm.ticket.collectAsState()
    val lines by vm.lines.collectAsState()
    val totals by vm.totals.collectAsState()
    val discounts by vm.discounts.collectAsState()
    val discount by vm.discount.collectAsState()
    val sheet by vm.sheet.collectAsState()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    toast?.let { LaunchedEffect(it) { snackbar.showSnackbar(it); vm.toastShown() } }
    var voidTarget by remember { mutableStateOf<String?>(null) }
    var voidReason by remember { mutableStateOf("") }

    ModalNavigationDrawer(
        drawerState = drawer,
        drawerContent = {
            ModalDrawerSheet {
                Text("RestoPOS", Modifier.padding(16.dp))
                NavigationDrawerItem(label = { Text("Sale") }, selected = true, onClick = { scope.launch { drawer.close() } })
                NavigationDrawerItem(label = { Text("Open tickets (Phase 3)") }, selected = false, onClick = {})
                NavigationDrawerItem(label = { Text("Receipts") }, selected = false, onClick = { scope.launch { drawer.close() }; onReceipts() })
                NavigationDrawerItem(label = { Text("Sign out") }, selected = false, onClick = onSignOut)
            }
        },
    ) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbar) },
            topBar = {
                TopAppBar(
                    title = { Text("Sale") },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawer.open() } }) {
                            Icon(Icons.Filled.Menu, contentDescription = "Menu")
                        }
                    },
                )
            },
        ) { inner ->
            Row(Modifier.fillMaxSize().padding(inner)) {
                Column(Modifier.weight(1f).fillMaxHeight()) {
                    var q by remember { mutableStateOf("") }
                    OutlinedTextField(
                        value = q,
                        onValueChange = { q = it; vm.onAction(SaleAction.Search(it)) },
                        modifier = Modifier.fillMaxWidth().padding(8.dp),
                        label = { Text("Search menu") },
                        leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                        singleLine = true,
                    )
                    if (state is SaleUiState.Ready) {
                        val cats = (state as SaleUiState.Ready).categories
                        val sel = (state as SaleUiState.Ready).selectedCat
                        LazyRow(Modifier.fillMaxWidth(), contentPadding = PaddingValues(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            item {
                                Button(onClick = { vm.onAction(SaleAction.SelectCategory(null)) }) { Text("All") }
                            }
                            items(cats, key = { it.id }) { c ->
                                Button(onClick = { vm.onAction(SaleAction.SelectCategory(if (sel == c.id) null else c.id)) }) {
                                    Text(c.name)
                                }
                            }
                        }
                    }
                    LazyVerticalGrid(GridCells.Adaptive(150.dp), Modifier.weight(1f), contentPadding = PaddingValues(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(paged.itemCount, key = paged.itemKey { it.id }) { i ->
                            val item = paged[i] ?: return@items
                            Card(onClick = { vm.onAction(SaleAction.TapItem(item)) }, enabled = item.is_available) {
                                Column(Modifier.padding(12.dp)) {
                                    Text(item.name, minLines = 2)
                                    Text(Money.format(item.price))
                                }
                            }
                        }
                    }
                }
                // Ticket panel (Phase 2).
                Column(Modifier.fillMaxHeight().padding(8.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(ticket?.let { "Order" } ?: "New order")
                        OutlinedButton(onClick = { vm.onAction(SaleAction.NewTicket) }) { Text("New") }
                    }
                    LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                        items(lines, key = { it.line.id }) { lu ->
                            val l = lu.line
                            Column(Modifier.padding(vertical = 6.dp)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Text(l.name_snapshot, Modifier.weight(1f))
                                    Text(Money.format((l.unit_price * l.qty + 500) / 1000))
                                }
                                if (lu.mods.isNotBlank()) Text(lu.mods)
                                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    IconButton(onClick = {
                                        val q = l.qty - 1000
                                        if (q <= 0) voidTarget = l.id else vm.onAction(SaleAction.SetQty(l.id, q / 1000))
                                    }) { Text("\u2212") }
                                    Text("${l.qty / 1000}")
                                    IconButton(onClick = { vm.onAction(SaleAction.SetQty(l.id, l.qty / 1000 + 1)) }) {
                                        Icon(Icons.Filled.Add, contentDescription = "More")
                                    }
                                    OutlinedButton(onClick = { voidTarget = l.id }) { Text("Void") }
                                }
                            }
                            HorizontalDivider()
                        }
                    }
                    if (discounts.isNotEmpty()) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            item {
                                OutlinedButton(onClick = { vm.setDiscount(null) }) { Text("No disc.") }
                            }
                            items(discounts, key = { it.id }) { d ->
                                OutlinedButton(onClick = {
                                    vm.setDiscount(DiscountPick(d.id, d.type, d.value, d.name))
                                }) { Text(d.name) }
                            }
                        }
                    }
                    Text("Subtotal ${Money.format(totals.subtotal)}")
                    if (totals.discount > 0) Text("Discount −${Money.format(totals.discount)}")
                    Text("VAT ${Money.format(totals.tax)}")
                    Text("Total ${Money.format(totals.total)}")
                    Button(
                        onClick = onPay,
                        enabled = lines.isNotEmpty(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Charge · ${Money.format(totals.total)}") }
                }
            }
        }
    }

    sheet?.let { s ->
        ModsSheet(
            data = s,
            onDismiss = { vm.onAction(SaleAction.DismissSheet) },
            onConfirm = { qty, picks, note -> vm.onAction(SaleAction.ConfirmMods(qty, picks, note)) },
        )
    }
    voidTarget?.let { id ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { voidTarget = null; voidReason = "" },
            title = { Text("Void line") },
            text = {
                OutlinedTextField(voidReason, { voidReason = it }, Modifier.fillMaxWidth(), label = { Text("Reason (required)") })
            },
            confirmButton = {
                Button(onClick = {
                    if (voidReason.isNotBlank()) {
                        vm.onAction(SaleAction.VoidLine(id, voidReason)); voidTarget = null; voidReason = ""
                    }
                }) { Text("Void") }
            },
            dismissButton = {
                OutlinedButton(onClick = { voidTarget = null; voidReason = "" }) { Text("Cancel") }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModsSheet(data: SheetData, onDismiss: () -> Unit, onConfirm: (Int, List<ModPick>, String) -> Unit) {
    var qty by remember { mutableStateOf(1) }
    var note by remember { mutableStateOf("") }
    var warn by remember { mutableStateOf<String?>(null) }
    val sel = remember { mutableStateOf<Map<String, Set<String>>>(emptyMap()) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(data.item.name)
            data.groups.forEach { g ->
                Text(g.name + if (g.min_select > 0) " (required)" else " (optional)")
                LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(data.mods.filter { it.group_id == g.id }, key = { it.id }) { m ->
                        val on = sel.value[g.id]?.contains(m.id) == true
                        OutlinedButton(onClick = {
                            val cur = sel.value[g.id] ?: emptySet()
                            val next = if (g.max_select <= 1) setOf(m.id)
                            else if (cur.contains(m.id)) cur - m.id else cur + m.id
                            sel.value = sel.value + (g.id to next)
                        }) { Text(m.name + if (m.price > 0) " +${Money.format(m.price)}" else "") }
                    }
                }
            }
            OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), label = { Text("Kitchen note") })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                IconButton(onClick = { qty = maxOf(1, qty - 1) }) { Text("\u2212") }
                Text("$qty")
                IconButton(onClick = { qty++ }) { Icon(Icons.Filled.Add, contentDescription = null) }
                Button(onClick = {
                    val picks = data.groups.flatMap { g ->
                        (sel.value[g.id] ?: emptySet()).mapNotNull { id ->
                            data.mods.firstOrNull { it.id == id }?.let { ModPick(it.id, it.name, it.price) }
                        }
                    }
                    val missing = data.groups.filter { it.min_select > 0 && sel.value[it.id].isNullOrEmpty() }
                    if (missing.isEmpty()) onConfirm(qty, picks, note)
                    else warn = "Required: " + missing.joinToString { it.name }
                }) { Text("Add") }
            }
            warn?.let { Text(it) }
        }
    }
}

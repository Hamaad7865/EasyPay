package com.restopos.feature.sale

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.paging.compose.collectAsLazyPagingItems
import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Calc
import com.restopos.core.data.DiscountPick
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.data.ModPick
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.CustomerEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.TicketEntity
import com.restopos.feature.customers.CustomerPicker
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import com.restopos.feature.tables.GuestsDialog
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val TILE_RATIO = 1.45f // a tile's width over its height

// Inside a row laid out right to left, its columns still read left to right.
@Composable
private fun Ltr(content: @Composable () -> Unit) = CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr, content = content)

// The register, tablet landscape: the order and keypad on the left, the
// categories two across in the middle, the open category's items on the right.
@Composable
fun RegisterScreen(
    vm: SaleViewModel,
    searching: Boolean,
    onSearchDone: () -> Unit,
    onPay: () -> Unit,
    onPaid: (String, Long, Long) -> Unit,
    onTables: () -> Unit,
    onMoveTable: () -> Unit,
    onSaved: () -> Unit,
    onSplit: () -> Unit,
) {
    val tableName by vm.tableName.collectAsState()
    val leftHanded by vm.leftHanded.collectAsState()
    val bySeat by vm.bySeat.collectAsState()
    val seat by vm.seat.collectAsState()
    val seats by vm.seats.collectAsState()
    val customer by vm.customer.collectAsState()
    val quick by vm.quick.collectAsState()
    // Edit order: the keypad makes way for the whole order, and items are ticked
    var editing by remember { mutableStateOf(false) }
    var picked by remember { mutableStateOf(setOf<String>()) }
    var placing by remember { mutableStateOf<String?>(null) } // "seat" or "course": where the ticked items go
    var confirmCancel by remember { mutableStateOf(false) }
    var pickCustomer by remember { mutableStateOf(false) }
    val byCourse by vm.byCourse.collectAsState()
    val course by vm.course.collectAsState()
    val courses by vm.courses.collectAsState()
    val state by vm.state.collectAsState(SaleUiState.Ready(emptyList(), null))
    val ready = state as SaleUiState.Ready
    val paged = vm.items.collectAsLazyPagingItems()
    val toast by vm.toast.collectAsState()
    val ticket by vm.ticket.collectAsState()
    val lines by vm.lines.collectAsState()
    val totals by vm.totals.collectAsState()
    val discounts by vm.discounts.collectAsState()
    val discount by vm.discount.collectAsState()
    val dining by vm.dining.collectAsState()
    val sheet by vm.sheet.collectAsState()
    val buffer by vm.buffer.collectAsState()
    val selected by vm.selected.collectAsState()
    val paid by vm.paid.collectAsState()
    val saves by vm.saves.collectAsState()
    val saved by vm.saved.collectAsState()
    val saving by vm.saving.collectAsState()
    val waiters by vm.waiters.collectAsState()
    var naming by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") } // the search text, as last typed

    // Back on screen (after paying, or after picking an order): reload it.
    LaunchedEffect(Unit) { vm.refresh() }
    paid?.let { p -> LaunchedEffect(p) { vm.paidShown(); onPaid(p.receiptId, p.change, p.total) } }
    if (saved) LaunchedEffect(Unit) { vm.savedShown(); onSaved() }
    toast?.let { msg -> LaunchedEffect(msg) { delay(3500); vm.toastShown() } }

    val canPay = lines.any { !it.line.paid }
    // a tick only stands for a line that is still on the order and unpaid
    LaunchedEffect(lines) { picked = picked.filter { id -> lines.any { it.line.id == id && !it.line.paid } }.toSet() }
    val inOrder = remember(lines) {
        lines.filter { !it.line.paid }.groupBy { it.line.item_id }.mapValues { e -> e.value.sumOf { it.line.qty } / 1000 }
    }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        // Left-handed (Settings, Display): the same three columns the other way round.
        CompositionLocalProvider(LocalLayoutDirection provides if (leftHanded) LayoutDirection.Rtl else LayoutDirection.Ltr) {
            Row(Modifier.fillMaxSize().padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Ltr {
                    BoxWithConstraints(Modifier.weight(3.75f).fillMaxHeight()) {
                        val keyHeight = ((maxHeight * 0.48f - 40.dp) / 5).coerceIn(34.dp, 60.dp)
                        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            OrderPanel(
                                Modifier.weight(1f).fillMaxWidth(), ticket, tableName, customer, lines, totals, selected, dining, discounts, discount,
                                byCourse, bySeat, course, courses, seat, seats, waiters, editing, picked,
                                onPick = { id -> picked = if (picked.contains(id)) picked - id else picked + id },
                                onEdit = { editing = true; vm.onAction(SaleAction.SelectLine(null)) },
                                onName = { naming = true },
                                onCustomer = { pickCustomer = true },
                                onAction = { vm.onAction(it) },
                                onMoveTable = onMoveTable,
                                onDiscount = { vm.setDiscount(it) },
                                onVoid = { vm.onAction(SaleAction.RemoveLine(it)) },
                            )
                            if (editing) {
                                EditBar(
                                    picked.size,
                                    onSeat = { placing = "seat" },
                                    onCourse = { placing = "course" },
                                    onRemove = { vm.onAction(SaleAction.RemoveLines(picked.toList())) },
                                    onDone = { editing = false; picked = emptySet() },
                                )
                            } else {
                                Keypad(
                                    keyHeight, buffer,
                                    tables = if (tableName != null) "Switch Table" else "Tables",
                                    quick = quick.second,
                                    // C clears what is typed; with nothing typed it offers to cancel the order
                                    onKey = {
                                        if (it == Keys.CLEAR && buffer.isEmpty()) { if (ticket != null || tableName != null) confirmCancel = true }
                                        else vm.onAction(if (it == Keys.TIMES) SaleAction.ApplyQty else SaleAction.Key(it))
                                    },
                                    onEdit = { if (lines.isEmpty()) vm.onAction(SaleAction.Key("")) ; editing = lines.isNotEmpty() },
                                    onHold = { vm.onAction(SaleAction.OnHold) },
                                    // a table's name typed first opens that table; otherwise the floor plan
                                    onTables = { if (buffer.isEmpty()) onTables() else vm.onAction(SaleAction.OpenTable) },
                                    onQuick = { vm.onAction(SaleAction.QuickPay(quick.first)) },
                                )
                            }
                        }
                    }
                }
                Ltr {
                    CategoryStrip(Modifier.weight(1.75f).fillMaxHeight(), ready.categories, ready.selectedCat) {
                        vm.onAction(SaleAction.SelectCategory(it))
                    }
                }
                Ltr {
                    Column(Modifier.weight(4.5f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        SeatBar(seat, seats, onPick = { vm.onAction(SaleAction.PickSeat(it)) }, onAdd = { vm.onAction(SaleAction.AddSeat) })
                        ItemsHeader(
                            title = ready.categories.firstOrNull { it.id == ready.selectedCat }?.name ?: "Menu",
                            searching = searching,
                            onQuery = { typed = it; vm.onAction(SaleAction.Search(it)) },
                            onSearchDone = onSearchDone,
                        )
                        if (paged.itemCount == 0) {
                            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                                Text(
                                    when {
                                        searching -> "No item matches that search."
                                        ready.categories.isEmpty() -> "The menu has not been downloaded yet. Connect this tablet to the internet."
                                        else -> "No items in this category."
                                    },
                                    color = Pos.Text3, fontSize = 14.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(24.dp),
                                )
                            }
                        } else {
                            BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
                                // two columns as designed, with three rows of them filling the
                                // height: the tiles flatten a little to fit. Three columns when
                                // the screen is too short for that.
                                val need = ((maxWidth - 4.dp) / 2) / ((maxHeight - 10.dp) / 3)
                                val columns = if (need <= TILE_RATIO * 1.2f) 2 else 3
                                val ratio = if (columns == 2) maxOf(TILE_RATIO, need) else TILE_RATIO
                                val grid = rememberLazyGridState()
                                val scope = rememberCoroutineScope()
                                // a new category or search starts at the top. The tiles are
                                // placed by position (no item keys): with keys the grid would
                                // keep the first visible item in view and open part-way down.
                                LaunchedEffect(ready.selectedCat, searching, typed) { grid.scrollToItem(0) }
                                Column(Modifier.fillMaxSize()) {
                                    LazyVerticalGrid(
                                        GridCells.Fixed(columns), Modifier.weight(1f).fillMaxWidth(), state = grid,
                                        verticalArrangement = Arrangement.spacedBy(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        items(paged.itemCount) { i ->
                                            val item = paged[i] ?: return@items
                                            ItemTile(item, inOrder[item.id] ?: 0, Pos.TileEdge, ratio) { vm.onAction(SaleAction.TapItem(item)) }
                                        }
                                    }
                                    // more items than fit: arrows that move a screenful
                                    if (grid.canScrollForward || grid.canScrollBackward) {
                                        Row(Modifier.fillMaxWidth().height(30.dp).padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                            val step = { grid.layoutInfo.viewportSize.height.toFloat() }
                                            if (grid.canScrollBackward) PagerButton(up = true, Modifier.weight(1f)) { scope.launch { grid.animateScrollBy(-step()) } }
                                            if (grid.canScrollForward) PagerButton(up = false, Modifier.weight(1f)) { scope.launch { grid.animateScrollBy(step()) } }
                                        }
                                    }
                                }
                            }
                        }
                        // Send prints what the kitchen has not had and puts the order
                        // away; Split Check divides it; Pay opens the payment screen.
                        Row(Modifier.fillMaxWidth().height(52.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            val unsent = lines.any { !it.line.paid && it.line.sent_to_kitchen_at == null }
                            BarKey(if (saving) "Sending…" else "Send", if (unsent && !saving) Pos.Green else Pos.Key, if (lines.isNotEmpty()) Color.White else Pos.Text3, Modifier.weight(1f), lines.isNotEmpty() && !saving) {
                                vm.onAction(SaleAction.Save)
                            }
                            BarKey("Split Check", Pos.Key, if (canPay) Pos.Text else Pos.Text3, Modifier.weight(1f), canPay, onSplit)
                            BarKey("Pay - ${Money.format(totals.total)}", if (canPay) Pos.Blue else Pos.Key, if (canPay) Color.White else Pos.Text3, Modifier.weight(1.4f), canPay, onPay)
                        }
                    }
                }
            }
        }
        toast?.let { msg ->
            Text(
                msg,
                Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp))
                    .background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    sheet?.let { s ->
        ModsSheet(
            data = s,
            onDismiss = { vm.onAction(SaleAction.DismissSheet) },
            onConfirm = { qty, picks, note -> vm.onAction(SaleAction.ConfirmMods(qty, picks, note)) },
        )
    }
    if (confirmCancel) {
        CancelOrderDialog(onNo = { confirmCancel = false }) { confirmCancel = false; vm.onAction(SaleAction.CancelOrder) }
    }
    if (pickCustomer) {
        CustomerPicker(current = customer?.id, onDismiss = { pickCustomer = false }) { id -> pickCustomer = false; vm.onAction(SaleAction.SetCustomer(id)) }
    }
    placing?.let { what ->
        val ids = picked.toList()
        if (what == "seat") {
            PickDialog(
                "Move to which seat?",
                listOf("Table" to null) + (1..maxOf(seats, 1) + 1).map { "Seat $it" to it },
                onDismiss = { placing = null },
            ) { n -> placing = null; vm.onAction(SaleAction.PlaceLines(ids, true, n, null)); picked = emptySet() }
        } else {
            PickDialog(
                "Move to which course?",
                (1..courses + 1).map { "Course $it" to it },
                onDismiss = { placing = null },
            ) { n -> placing = null; vm.onAction(SaleAction.PlaceLines(ids, false, null, n)); picked = emptySet() }
        }
    }
    if (naming) {
        TabNameDialog(
            initial = ticket?.name ?: "",
            onDismiss = { naming = false },
            onOk = { vm.onAction(SaleAction.SetName(it)); naming = false },
        )
    }
}

@Composable
private fun RowScope.BarKey(label: String, color: Color, text: Color, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    Box(modifier.fillMaxHeight().background(color).clickable(enabled = enabled, onClick = onClick), contentAlignment = Alignment.Center) {
        Text(label, Modifier.padding(horizontal = 4.dp), color = text, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun OrderPanel(
    modifier: Modifier,
    ticket: TicketEntity?,
    tableName: String?,
    customer: CustomerEntity?,
    lines: List<LineUi>,
    totals: Calc.Totals,
    selected: String?,
    dining: List<DiningOptionEntity>,
    discounts: List<DiscountEntity>,
    discount: DiscountPick?,
    byCourse: Boolean,
    bySeat: Boolean,
    course: Int,
    courses: Int,
    seat: Int?,
    seats: Int,
    waiters: List<EmployeeEntity>,
    editing: Boolean,
    picked: Set<String>,
    onPick: (String) -> Unit,
    onEdit: () -> Unit,
    onName: () -> Unit,
    onCustomer: () -> Unit,
    onAction: (SaleAction) -> Unit,
    onMoveTable: () -> Unit,
    onDiscount: (DiscountPick?) -> Unit,
    onVoid: (String) -> Unit,
) {
    var actionsOpen by remember { mutableStateOf(false) }
    var diningOpen by remember { mutableStateOf(false) }
    var viewOpen by remember { mutableStateOf(false) }
    var askGuests by remember { mutableStateOf(false) }
    var askDiscount by remember { mutableStateOf(false) }
    var askWaiter by remember { mutableStateOf(false) }
    var askNote by remember { mutableStateOf(false) }
    Column(modifier.background(Pos.Panel)) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                ticket?.name ?: tableName?.let { tableLabel(it) } ?: customer?.name ?: "Direct sale", Modifier.weight(1f),
                color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Box {
                Text(
                    "Actions", Modifier.clickable { actionsOpen = true }.padding(horizontal = 8.dp, vertical = 8.dp),
                    color = Pos.NavOn, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                )
                DropdownMenu(expanded = actionsOpen, onDismissRequest = { actionsOpen = false }) {
                    DropdownMenuItem(text = { Text("New order") }, onClick = { actionsOpen = false; onAction(SaleAction.NewTicket) })
                    DropdownMenuItem(text = { Text(if (ticket?.name == null) "Name the order" else "Rename the order") }, onClick = { actionsOpen = false; onName() })
                    if (tableName != null) {
                        DropdownMenuItem(text = { Text("Transfer to another table") }, onClick = { actionsOpen = false; onMoveTable() })
                    }
                    if (ticket != null && waiters.size > 1) {
                        DropdownMenuItem(text = { Text("Change waiter") }, onClick = { actionsOpen = false; askWaiter = true })
                    }
                    DropdownMenuItem(text = { Text(if (ticket?.note.isNullOrBlank()) "Add a remark" else "Change the remark") }, onClick = { actionsOpen = false; askNote = true })
                    if (lines.any { !it.line.paid }) {
                        DropdownMenuItem(text = { Text("Print the bill") }, onClick = { actionsOpen = false; onAction(SaleAction.PrintBill) })
                    }
                    if (lines.any { it.line.sent_to_kitchen_at != null }) {
                        DropdownMenuItem(text = { Text("Print the kitchen order again") }, onClick = { actionsOpen = false; onAction(SaleAction.ReprintKitchen) })
                    }
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text("Discount in % or Rs") }, onClick = { actionsOpen = false; askDiscount = true })
                    if (discount != null) {
                        DropdownMenuItem(text = { Text("Remove the discount") }, onClick = { actionsOpen = false; onDiscount(null) })
                    }
                    if (discounts.isNotEmpty()) {
                        discounts.forEach { d ->
                            DropdownMenuItem(
                                text = { Text(if (discount?.discountId == d.id) "${d.name}  ✓" else d.name) },
                                onClick = { actionsOpen = false; onDiscount(DiscountPick(d.id, d.type, d.value, d.name)) },
                            )
                        }
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            // how the order is listed: course by course, seat by seat, or as it was rung up
            Box {
                Chip((if (bySeat) "By seat" else if (byCourse) "By course" else "As ordered") + "  ▾") { viewOpen = true }
                DropdownMenu(expanded = viewOpen, onDismissRequest = { viewOpen = false }) {
                    DropdownMenuItem(text = { Text("By course") }, onClick = { viewOpen = false; onAction(SaleAction.ByCourse(true)) })
                    DropdownMenuItem(text = { Text("By seat") }, onClick = { viewOpen = false; onAction(SaleAction.BySeat) })
                    DropdownMenuItem(text = { Text("As ordered") }, onClick = { viewOpen = false; onAction(SaleAction.ByCourse(false)) })
                }
            }
            Row(
                Modifier.clip(RoundedCornerShape(4.dp)).background(Pos.Key).clickable { askGuests = true }.padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(PosIcons.Cutlery, contentDescription = "Guests", tint = Pos.Text2, modifier = Modifier.size(15.dp))
                Text(ticket?.covers?.toString() ?: "–", Modifier.padding(start = 6.dp), color = Pos.Text2, fontSize = 12.sp)
            }
            if (dining.isNotEmpty()) {
                val current = dining.firstOrNull { it.id == ticket?.dining_option_id }
                    ?: dining.firstOrNull { it.is_default } ?: dining.first()
                Box {
                    Chip(current.name) { diningOpen = true }
                    DropdownMenu(expanded = diningOpen, onDismissRequest = { diningOpen = false }) {
                        dining.forEach { o ->
                            DropdownMenuItem(text = { Text(o.name) }, onClick = { diningOpen = false; onAction(SaleAction.SetDining(o.id)) })
                        }
                    }
                }
            }
            // who the order is for
            Chip(customer?.name ?: "Assign customer") { onCustomer() }
            discount?.let { Chip(it.name) }
        }
        HorizontalDivider(color = Pos.Line)
        // What the list holds: the lines under a heading per course, or per
        // seat, or as they were rung up. A line with no course counts as
        // course 1; one with no seat is for the table.
        val rows: List<Any> = remember(lines, byCourse, bySeat, courses, seats) {
            when {
                bySeat -> buildList {
                    add(SeatHead(null))
                    addAll(lines.filter { it.line.seat == null })
                    for (n in 1..maxOf(seats, lines.maxOfOrNull { it.line.seat ?: 0 } ?: 0)) {
                        add(SeatHead(n))
                        addAll(lines.filter { it.line.seat == n })
                    }
                }
                byCourse -> buildList {
                    for (c in 1..courses) {
                        add(c)
                        addAll(lines.filter { (it.line.course ?: 1) == c })
                    }
                    add("add")
                }
                else -> lines
            }
        }
        // a line that was just selected, or replaced by a quantity change, stays in view
        val listState = rememberLazyListState()
        LaunchedEffect(selected, rows.size) {
            val at = rows.indexOfFirst { it is LineUi && it.line.id == selected }
            if (at >= 0) listState.animateScrollToItem(at)
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().background(Brush.verticalGradient(listOf(Pos.Panel, Pos.PanelDeep))), state = listState) {
            items(rows, key = { r -> if (r is LineUi) r.line.id else if (r is SeatHead) "seat-${r.n}" else "course-$r" }) { r ->
                when (r) {
                    is LineUi -> LineRow(
                        r, selected == r.line.id, editing, picked.contains(r.line.id),
                        // what the heading does not already say
                        tag = if (bySeat) r.line.course?.takeIf { it > 1 }?.let { "Course $it" } else r.line.seat?.let { "Seat $it" },
                        onPick, onAction, onVoid,
                    )
                    is Int -> Row(
                        // new items go to the course that is lit
                        Modifier.fillMaxWidth().background(if (r == course) Pos.Selected else Color.Transparent)
                            .clickable { onAction(SaleAction.PickCourse(r)) }.padding(start = 12.dp, end = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Course $r", Modifier.weight(1f).padding(vertical = 7.dp), color = if (r == course) Pos.Text else Pos.Text2, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                        Icon(
                            Icons.Filled.Edit, contentDescription = "Edit order", tint = Pos.Text2,
                            modifier = Modifier.clip(CircleShape).clickable(onClick = onEdit).padding(6.dp).size(15.dp),
                        )
                    }
                    is SeatHead -> Row(
                        // new items go to the seat that is lit
                        Modifier.fillMaxWidth().background(if (r.n == seat) Pos.Selected else Color.Transparent)
                            .clickable { onAction(SaleAction.PickSeat(r.n)) }.padding(horizontal = 12.dp, vertical = 7.dp),
                    ) {
                        Text(r.n?.let { "Seat $it" } ?: "Table", Modifier.weight(1f), color = if (r.n == seat) Pos.Text else Pos.Text2, fontSize = 13.sp, fontWeight = FontWeight.Medium)
                    }
                    else -> Row(Modifier.fillMaxWidth().clickable { onAction(SaleAction.AddCourse) }.padding(horizontal = 12.dp, vertical = 7.dp)) {
                        Text("Add a course", Modifier.weight(1f), color = Pos.NavOn, fontSize = 13.sp)
                        Text("+", color = Pos.NavOn, fontSize = 15.sp)
                    }
                }
                HorizontalDivider(color = Pos.Line)
            }
        }
        HorizontalDivider(color = Pos.Line)
        if (askGuests) {
            GuestsDialog("How many guests?", seats = 12, onDismiss = { askGuests = false }) { n ->
                askGuests = false
                if (n != null) onAction(SaleAction.SetGuests(n))
            }
        }
        if (askDiscount) DiscountDialog(onDismiss = { askDiscount = false }) { askDiscount = false; onDiscount(it) }
        if (askWaiter) {
            AlertDialog(
                onDismissRequest = { askWaiter = false },
                title = { Text("Who takes this order?") },
                text = {
                    Column(Modifier.verticalScroll(rememberScrollState())) {
                        waiters.forEach { w ->
                            Text(
                                w.name + if (w.id == ticket?.opened_by) "  ✓" else "",
                                Modifier.fillMaxWidth().clickable { askWaiter = false; onAction(SaleAction.SetWaiter(w.id)) }.padding(vertical = 12.dp),
                                color = Pos.Text, fontSize = 16.sp,
                            )
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { OutlinedButton(onClick = { askWaiter = false }) { Text("Cancel") } },
            )
        }
        if (askNote) {
            var note by remember { mutableStateOf(ticket?.note ?: "") }
            AlertDialog(
                onDismissRequest = { askNote = false },
                title = { Text("Remark") },
                text = {
                    OutlinedTextField(note, { note = it.take(120) }, Modifier.fillMaxWidth(), label = { Text("Prints on the kitchen order and the receipt") })
                },
                confirmButton = { Button(onClick = { askNote = false; onAction(SaleAction.SetNote(note)) }) { Text("OK") } },
                dismissButton = { OutlinedButton(onClick = { askNote = false }) { Text("Cancel") } },
            )
        }
        ticket?.note?.takeIf { it.isNotBlank() }?.let {
            Text("Remark: $it", Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 6.dp), color = Pos.Text2, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (totals.discount > 0) {
            Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 6.dp)) {
                Text("Discount", Modifier.weight(1f), color = Pos.Text2, fontSize = 12.sp)
                Text("−${Money.format(totals.discount)}", color = Pos.Text2, fontSize = 12.sp)
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Total", color = Pos.Text, fontSize = 13.sp, fontWeight = FontWeight.Bold)
            if (totals.tax > 0) Text("   VAT ${Money.format(totals.tax)}", color = Pos.Text3, fontSize = 11.sp)
            Spacer(Modifier.weight(1f))
            Text(Money.format(totals.total), color = Pos.Text, fontSize = 14.sp, fontWeight = FontWeight.Bold)
        }
    }
}

// A discount typed in: a percentage of the bill, or an amount in rupees.
@Composable
private fun DiscountDialog(onDismiss: () -> Unit, onPick: (DiscountPick) -> Unit) {
    var percent by remember { mutableStateOf(true) }
    var typed by remember { mutableStateOf("") }
    var problem by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Discount") },
        text = {
            Column {
                Row(Modifier.fillMaxWidth().padding(bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(true to "Percent %", false to "Amount Rs").forEach { (isPercent, label) ->
                        Box(
                            Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(4.dp)).background(if (percent == isPercent) Pos.TabOn else Pos.Key)
                                .clickable { percent = isPercent; typed = ""; problem = null },
                            contentAlignment = Alignment.Center,
                        ) { Text(label, color = Color.White, fontSize = 14.sp) }
                    }
                }
                Text(
                    if (percent) "${typed.ifEmpty { "0" }} %" else "Rs ${typed.ifEmpty { "0" }}", Modifier.fillMaxWidth().padding(bottom = 10.dp),
                    color = Pos.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End,
                )
                com.restopos.feature.staff.AmountPad(typed, 44.dp, Modifier.fillMaxWidth()) { typed = it; problem = null }
                problem?.let { Text(it, Modifier.padding(top = 8.dp), color = Pos.Pink, fontSize = 13.sp) }
            }
        },
        confirmButton = {
            Button(onClick = {
                if (percent) {
                    val n = typed.toIntOrNull()
                    if (n == null || n !in 1..100) problem = "A percentage is a whole number from 1 to 100"
                    else onPick(DiscountPick(null, "percent", n.toLong(), "$n%"))
                } else {
                    val cents = Money.parseRs(typed)
                    if (cents == null || cents <= 0) problem = "Type the amount to take off"
                    else onPick(DiscountPick(null, "amount", cents, Money.format(cents) + " off"))
                }
            }) { Text("Apply") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// The order's name. It is what the guest's bill will carry.
@Composable
private fun TabNameDialog(initial: String, onDismiss: () -> Unit, onOk: (String) -> Unit) {
    var name by remember { mutableStateOf(initial) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.width(520.dp).clip(RoundedCornerShape(4.dp)).background(Pos.PanelDeep)) {
            Box(Modifier.fillMaxWidth().background(Pos.Panel).padding(vertical = 18.dp), contentAlignment = Alignment.Center) {
                Text("Tab name", color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
            Column(Modifier.padding(start = 28.dp, end = 28.dp, top = 24.dp, bottom = 28.dp)) {
                Text(
                    "Give this order a name. It is the name on the guest's bill. An order that is on a table leaves it, " +
                        "and the table is free for the next guests.",
                    color = Pos.Text, fontSize = 16.sp, lineHeight = 22.sp,
                )
                BasicTextField(
                    value = name,
                    onValueChange = { name = it.take(40) },
                    modifier = Modifier.fillMaxWidth().padding(top = 26.dp).focusRequester(focus),
                    singleLine = true,
                    textStyle = TextStyle(color = Pos.Text, fontSize = 17.sp),
                    cursorBrush = SolidColor(Pos.Text),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
                    keyboardActions = KeyboardActions(onDone = { onOk(name) }),
                    decorationBox = { inner ->
                        Column {
                            Box {
                                if (name.isEmpty()) Text("Name", color = Pos.Text2, fontSize = 17.sp, fontWeight = FontWeight.Medium)
                                inner()
                            }
                            Box(Modifier.padding(top = 8.dp).fillMaxWidth().height(1.dp).background(Pos.Text3))
                        }
                    },
                )
                Row(Modifier.fillMaxWidth().padding(top = 34.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Box(
                        Modifier.weight(1f).height(64.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Key).clickable(onClick = onDismiss),
                        contentAlignment = Alignment.Center,
                    ) { Text("Cancel", color = Pos.NavOn, fontSize = 17.sp, fontWeight = FontWeight.Medium) }
                    Box(
                        Modifier.weight(1f).height(64.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Blue).clickable { onOk(name) },
                        contentAlignment = Alignment.Center,
                    ) { Text("OK", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold) }
                }
            }
        }
    }
}

@Composable
private fun Chip(text: String, onClick: (() -> Unit)? = null) {
    Text(
        text,
        Modifier.clip(RoundedCornerShape(4.dp)).background(Pos.Key)
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 8.dp, vertical = 5.dp),
        color = Pos.Text2, fontSize = 12.sp, maxLines = 1,
    )
}

// A seat's heading when the order is listed by seat; null is the table.
private class SeatHead(val n: Int?)

// One line of the order. Tapping it selects it: the keypad's quantity key and
// the buttons under it then act on this line. While the order is being edited
// a tap ticks it instead. A paid line is locked.
@Composable
private fun LineRow(
    lu: LineUi, selected: Boolean, editing: Boolean, picked: Boolean, tag: String?,
    onPick: (String) -> Unit, onAction: (SaleAction) -> Unit, onVoid: (String) -> Unit,
) {
    val l = lu.line
    Column(
        Modifier.fillMaxWidth().background(if (if (editing) picked else selected) Pos.Selected else Color.Transparent)
            .clickable(enabled = !l.paid) { if (editing) onPick(l.id) else onAction(SaleAction.SelectLine(if (selected) null else l.id)) }
            .alpha(if (l.paid) 0.5f else 1f)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(Modifier.fillMaxWidth()) {
            if (editing) {
                Box(
                    Modifier.padding(end = 10.dp, top = 1.dp).size(18.dp).clip(RoundedCornerShape(3.dp)).background(if (picked) Pos.Blue else Pos.Key),
                    contentAlignment = Alignment.Center,
                ) { if (picked) Text("✓", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
            }
            Text("${l.qty / 1000}×", Modifier.width(34.dp), color = Pos.Text2, fontSize = 14.sp)
            Column(Modifier.weight(1f)) {
                Text(l.name_snapshot + if (l.paid) "  (paid)" else "", color = Pos.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                if (!l.paid && l.sent_to_kitchen_at == null) Text("Not sent yet", color = Pos.Warn, fontSize = 11.sp)
                if (lu.mods.isNotBlank()) Text(lu.mods, color = Pos.Text2, fontSize = 12.sp)
                l.note?.takeIf { it.isNotBlank() }?.let { Text("Note: $it", color = Pos.Text2, fontSize = 12.sp) }
                tag?.let { Text(it, color = Pos.Text3, fontSize = 11.sp) }
            }
            Text(Money.format(lu.amount), color = Pos.Text, fontSize = 14.sp)
        }
        if (selected && !editing) {
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                val sent = l.sent_to_kitchen_at != null
                if (!sent) {
                    LineButton("−", Pos.Key) {
                        val q = l.qty / 1000 - 1
                        if (q <= 0) onVoid(l.id) else onAction(SaleAction.SetQty(l.id, q))
                    }
                    LineButton("+", Pos.Key) { onAction(SaleAction.SetQty(l.id, l.qty / 1000 + 1)) }
                } else {
                    Text("The kitchen has this", color = Pos.Text3, fontSize = 12.sp)
                }
                Spacer(Modifier.weight(1f))
                // before it is sent it is simply taken off; after, the kitchen is told
                LineButton(if (sent) "Void" else "Delete", Pos.Danger) { onVoid(l.id) }
            }
        }
    }
}

@Composable
private fun LineButton(label: String, color: Color, onClick: () -> Unit) {
    Box(
        Modifier.height(36.dp).clip(RoundedCornerShape(4.dp)).background(color).clickable(onClick = onClick).padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium) }
}

// Number keys on the left, four keys on the right. The number is used by
// what is tapped next.
@Composable
private fun Keypad(
    keyHeight: Dp,
    buffer: String,
    tables: String,
    quick: String,
    onKey: (String) -> Unit,
    onEdit: () -> Unit,
    onHold: () -> Unit,
    onTables: () -> Unit,
    onQuick: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().background(Pos.Panel)) {
        Row(Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Use keypad to apply quantity, table or payment", Modifier.weight(1f),
                color = Pos.Text3, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                textAlign = if (buffer.isEmpty()) TextAlign.End else TextAlign.Start,
            )
            if (buffer.isNotEmpty()) Text(buffer, Modifier.padding(start = 8.dp), color = Pos.Text, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        }
        Row(Modifier.fillMaxWidth().height(keyHeight * 5).background(Pos.Line), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            Column(Modifier.weight(2.2f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                listOf(
                    listOf(Keys.CLEAR, ".", Keys.BACK), listOf("7", "8", "9"), listOf("4", "5", "6"),
                    listOf("1", "2", "3"), listOf("00", "0", Keys.TIMES),
                ).forEach { row ->
                    Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
                        row.forEach { k ->
                            Box(
                                Modifier.weight(1f).fillMaxHeight().background(Pos.Key).clickable { onKey(k) },
                                contentAlignment = Alignment.Center,
                            ) {
                                when (k) {
                                    Keys.BACK -> Icon(PosIcons.Backspace, contentDescription = "Delete last digit", tint = Pos.Text, modifier = Modifier.size(22.dp))
                                    Keys.CLEAR -> Text("C", color = Pos.Pink, fontSize = 22.sp, fontWeight = FontWeight.Medium)
                                    Keys.TIMES -> Text("×", color = Pos.Violet, fontSize = 24.sp)
                                    else -> Text(k, color = Pos.Text, fontSize = 22.sp, fontWeight = FontWeight.Medium)
                                }
                            }
                        }
                    }
                }
            }
            // Edit order and On hold are quiet keys; the table key and the quick payment are lit
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                listOf(
                    Triple("Edit order", Pos.Key, onEdit), Triple("On hold", Pos.Key, onHold),
                    Triple(tables, Pos.TabOn, onTables), Triple(quick, Pos.Green, onQuick),
                ).forEach { (label, color, press) ->
                    Box(
                        Modifier.weight(1f).fillMaxWidth().background(color).clickable(onClick = press),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            label, Modifier.padding(horizontal = 4.dp), color = if (color == Pos.Key) Pos.Link else Color.White,
                            fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

// Edit order: in place of the keypad. The items are ticked in the order
// above; these keys move them to a seat or a course, or take them off.
@Composable
private fun EditBar(count: Int, onSeat: () -> Unit, onCourse: () -> Unit, onRemove: () -> Unit, onDone: () -> Unit) {
    Column(Modifier.fillMaxWidth().background(Pos.Panel)) {
        Text(
            if (count == 0) "Tick the items to change, then choose what to do with them" else "$count ticked",
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp), color = Pos.Text3, fontSize = 12.sp, maxLines = 1,
        )
        Row(Modifier.fillMaxWidth().height(56.dp).background(Pos.Line), horizontalArrangement = Arrangement.spacedBy(1.dp)) {
            listOf(
                Triple("Seat", Pos.Key, onSeat), Triple("Course", Pos.Key, onCourse), Triple("Remove", Pos.Danger, onRemove),
            ).forEach { (label, color, press) ->
                Box(Modifier.weight(1f).fillMaxHeight().background(color).clickable(enabled = count > 0, onClick = press), contentAlignment = Alignment.Center) {
                    Text(label, color = if (count > 0) Pos.Text else Pos.Text3, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                }
            }
            Box(Modifier.weight(1f).fillMaxHeight().background(Pos.TabOn).clickable(onClick = onDone), contentAlignment = Alignment.Center) {
                Text("Done", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            }
        }
    }
}

// Which seat the next items are for: the table, a seat, or a new seat.
@Composable
private fun SeatBar(seat: Int?, seats: Int, onPick: (Int?) -> Unit, onAdd: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(40.dp).background(Pos.Panel).horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("Select a seat", Modifier.padding(end = 10.dp), color = Pos.Text3, fontSize = 13.sp)
        SeatKey("Table", seat == null) { onPick(null) }
        for (n in 1..seats) SeatKey(n.toString(), seat == n) { onPick(n) }
        SeatKey("+", false, onAdd)
    }
}

@Composable
private fun SeatKey(label: String, on: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.height(28.dp).clip(RoundedCornerShape(3.dp)).background(if (on) Pos.TabOn else Pos.Key).clickable(onClick = onClick).padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (on) Color.White else Pos.Text2, fontSize = 13.sp, fontWeight = FontWeight.Medium) }
}

// C with nothing typed: the order is cleared only after a yes.
@Composable
private fun CancelOrderDialog(onNo: () -> Unit, onYes: () -> Unit) {
    Dialog(onDismissRequest = onNo, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Column(Modifier.width(440.dp).clip(RoundedCornerShape(4.dp)).background(Pos.PanelDeep)) {
            Box(Modifier.fillMaxWidth().background(Pos.Panel).padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
                Text("Cancel order", color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
            }
            Text(
                "Clear this order? Its items come off, and the register goes back to a new direct sale.",
                Modifier.fillMaxWidth().padding(horizontal = 32.dp, vertical = 28.dp), color = Pos.Text, fontSize = 16.sp, textAlign = TextAlign.Center, lineHeight = 22.sp,
            )
            Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 24.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(Modifier.weight(1f).height(56.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Key).clickable(onClick = onNo), contentAlignment = Alignment.Center) {
                    Text("No", color = Pos.Link, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                }
                Box(Modifier.weight(1f).height(56.dp).clip(RoundedCornerShape(3.dp)).background(Pos.TabOn).clickable(onClick = onYes), contentAlignment = Alignment.Center) {
                    Text("Yes", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

// A handful of choices, three across.
@Composable
private fun <T> PickDialog(title: String, options: List<Pair<String, T>>, onDismiss: () -> Unit, onPick: (T) -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                options.chunked(3).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        row.forEach { (label, value) ->
                            Box(
                                Modifier.weight(1f).height(48.dp).clip(RoundedCornerShape(4.dp)).background(Pos.Key).clickable { onPick(value) },
                                contentAlignment = Alignment.Center,
                            ) { Text(label, color = Pos.Text, fontSize = 14.sp, maxLines = 1) }
                        }
                        repeat(3 - row.size) { Box(Modifier.weight(1f)) }
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

private val CATEGORY_MIN = 56.dp // the smallest a category button gets before the grid pages
private const val CATEGORY_COLS = 2

// Categories two across, all in the till's blue. When they do not all fit, the grid shows a page of them and
// its last row becomes the pager: down for the next page, up for the previous.
@Composable
private fun CategoryStrip(modifier: Modifier, categories: List<CategoryEntity>, selected: String?, onPick: (String) -> Unit) {
    BoxWithConstraints(modifier) {
        val gap = 2.dp
        val fit = ((maxHeight + gap) / (CATEGORY_MIN + gap)).toInt().coerceAtLeast(2)
        val paged = categories.size > fit * CATEGORY_COLS
        val perPage = if (paged) (fit - 1) * CATEGORY_COLS else categories.size.coerceAtLeast(1)
        val pages = if (paged) (categories.size + perPage - 1) / perPage else 1
        // opens on the page that holds the selected category
        var page by remember(perPage, categories.size) {
            mutableStateOf(if (paged) categories.indexOfFirst { it.id == selected }.coerceAtLeast(0) / perPage else 0)
        }
        val current = page.coerceIn(0, pages - 1)
        val rows = if (paged) fit else (perPage + CATEGORY_COLS - 1) / CATEGORY_COLS
        val each = ((maxHeight - gap * (rows - 1)) / rows).coerceAtMost(84.dp)
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(gap)) {
            (if (paged) categories.drop(current * perPage).take(perPage) else categories).chunked(CATEGORY_COLS).forEach { pair ->
                Row(Modifier.fillMaxWidth().height(each), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    pair.forEach { c ->
                        val color = Pos.CategoryDefault
                        val on = c.id == selected
                        Box(Modifier.weight(1f).fillMaxHeight().background(color).clickable { onPick(c.id) }, contentAlignment = Alignment.Center) {
                            if (on) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(4.dp).background(Color.White))
                            Text(
                                c.name, Modifier.padding(horizontal = 4.dp),
                                color = if (color.luminance() > 0.5f) Pos.Line else Color.White,
                                fontSize = 13.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium,
                                textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis, lineHeight = 16.sp,
                            )
                        }
                    }
                    // an odd one out keeps its half of the row
                    repeat(CATEGORY_COLS - pair.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            if (paged) {
                // the pager stays in the last row when the last page is short
                Spacer(Modifier.weight(1f))
                Row(Modifier.fillMaxWidth().height(each), horizontalArrangement = Arrangement.spacedBy(gap)) {
                    if (current > 0) PagerButton(up = true, Modifier.weight(1f)) { page = current - 1 }
                    if (current < pages - 1) PagerButton(up = false, Modifier.weight(1f)) { page = current + 1 }
                }
            }
        }
    }
}

@Composable
private fun PagerButton(up: Boolean, modifier: Modifier, onClick: () -> Unit) {
    Box(modifier.fillMaxHeight().background(Pos.Key).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(
            Icons.Filled.ArrowDropDown, contentDescription = if (up) "Previous" else "More",
            tint = Pos.Text, modifier = Modifier.size(30.dp).rotate(if (up) 180f else 0f),
        )
    }
}

@Composable
private fun ItemsHeader(title: String, searching: Boolean, onQuery: (String) -> Unit, onSearchDone: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().height(40.dp).background(Pos.PanelDeep).padding(horizontal = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (searching) {
            var q by remember { mutableStateOf("") }
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            BasicTextField(
                value = q,
                onValueChange = { q = it; onQuery(it) },
                modifier = Modifier.weight(1f).focusRequester(focus),
                singleLine = true,
                textStyle = TextStyle(color = Pos.Text, fontSize = 15.sp),
                cursorBrush = SolidColor(Pos.Text),
                decorationBox = { inner ->
                    if (q.isEmpty()) Text("Search the menu", color = Pos.Text3, fontSize = 15.sp)
                    inner()
                },
            )
            Text("Close", Modifier.clickable(onClick = onSearchDone).padding(8.dp), color = Pos.NavOn, fontSize = 14.sp)
        } else {
            Text(title, Modifier.weight(1f), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, maxLines = 1)
        }
    }
}

@Composable
private fun ItemTile(item: ItemEntity, inOrder: Int, edge: Color, ratio: Float, onTap: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().aspectRatio(ratio).background(Pos.Tile)
            .clickable(enabled = item.is_available, onClick = onTap)
            .alpha(if (item.is_available) 1f else 0.45f),
    ) {
        Column(Modifier.align(Alignment.Center).padding(horizontal = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                item.name, color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center, maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
            if (!item.is_available) Text("Sold out", color = Pos.Text2, fontSize = 12.sp)
        }
        if (inOrder > 0) {
            Box(
                Modifier.align(Alignment.TopEnd).padding(6.dp).size(24.dp).clip(CircleShape).background(Pos.Blue),
                contentAlignment = Alignment.Center,
            ) { Text("$inOrder", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Bold) }
        }
        Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(3.dp).background(edge))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModsSheet(data: SheetData, onDismiss: () -> Unit, onConfirm: (Int, List<ModPick>, String) -> Unit) {
    var qty by remember { mutableStateOf(data.qty) }
    var note by remember { mutableStateOf("") }
    var warn by remember { mutableStateOf<String?>(null) }
    val sel = remember { mutableStateOf<Map<String, Set<String>>>(emptyMap()) }
    // Opens at full height (a half-open sheet hides the Add button on a
    // landscape tablet) and scrolls when an item has many option groups.
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(data.item.name, fontSize = 18.sp, fontWeight = FontWeight.Bold)
            data.groups.forEach { g ->
                Text(g.name + if (g.min_select > 0) " (required)" else " (optional)", color = Pos.Text2)
                LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), contentPadding = PaddingValues(vertical = 2.dp)) {
                    items(data.mods.filter { it.group_id == g.id }, key = { it.id }) { m ->
                        val on = sel.value[g.id]?.contains(m.id) == true
                        val pick = {
                            val cur = sel.value[g.id] ?: emptySet()
                            // at most 1: one choice; at most 0: as many as wanted; else up to the limit
                            val next = when {
                                cur.contains(m.id) -> if (g.max_select == 1 && g.min_select > 0) cur else cur - m.id
                                g.max_select == 1 -> setOf(m.id)
                                g.max_select > 1 && cur.size >= g.max_select -> cur
                                else -> cur + m.id
                            }
                            sel.value = sel.value + (g.id to next)
                        }
                        val label = m.name + if (m.price > 0) " +${Money.format(m.price)}" else ""
                        if (on) Button(onClick = pick) { Text(label) } else OutlinedButton(onClick = pick) { Text(label) }
                    }
                }
            }
            OutlinedTextField(note, { note = it }, Modifier.fillMaxWidth(), label = { Text("Kitchen note") })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { qty = maxOf(1, qty - 1) }) { Text("−", fontSize = 20.sp) }
                Text("$qty", fontSize = 18.sp)
                IconButton(onClick = { qty++ }) { Icon(Icons.Filled.Add, contentDescription = "More") }
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
            warn?.let { Text(it, color = Pos.Pink) }
        }
    }
}

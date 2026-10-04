package com.restopos.feature.sale

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.animateScrollBy
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.paging.compose.collectAsLazyPagingItems
import com.restopos.core.common.Money
import com.restopos.core.data.Calc
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.ModPick
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.TicketEntity
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val TILE_RATIO = 1.45f // a tile's width over its height

// The register, tablet landscape: the order and keypad on the left, the
// category strip in the middle, the open category's items on the right.
@Composable
fun RegisterScreen(
    vm: SaleViewModel,
    searching: Boolean,
    onSearchDone: () -> Unit,
    onPay: () -> Unit,
    onPaid: (String, Long, Long) -> Unit,
) {
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
    var voidTarget by remember { mutableStateOf<String?>(null) }
    var voidReason by remember { mutableStateOf("") }
    var naming by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") } // the search text, as last typed

    // Back on screen (after paying, or after picking an order): reload it.
    LaunchedEffect(Unit) { vm.refresh() }
    paid?.let { p -> LaunchedEffect(p) { vm.paidShown(); onPaid(p.receiptId, p.change, p.total) } }
    toast?.let { msg -> LaunchedEffect(msg) { delay(3500); vm.toastShown() } }

    val canPay = lines.any { !it.line.paid }
    // a tile's bottom edge is its category's colour, unless the item has its own
    val categoryColors = remember(ready.categories) {
        ready.categories.filter { it.color != null }.associate { it.id to Pos.css(it.color, Pos.TileEdge) }
    }
    val inOrder = remember(lines) {
        lines.filter { !it.line.paid }.groupBy { it.line.item_id }.mapValues { e -> e.value.sumOf { it.line.qty } / 1000 }
    }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Row(Modifier.fillMaxSize().padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            BoxWithConstraints(Modifier.weight(3.75f).fillMaxHeight()) {
                val keyHeight = ((maxHeight * 0.48f - 40.dp) / 5).coerceIn(34.dp, 60.dp)
                Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    OrderPanel(
                        Modifier.weight(1f).fillMaxWidth(), ticket, lines, totals, selected, dining, discounts, discount,
                        onAction = { vm.onAction(it) },
                        onDiscount = { vm.setDiscount(it) },
                        onVoid = { voidTarget = it },
                    )
                    Keypad(
                        keyHeight, buffer,
                        onKey = { vm.onAction(if (it == Keys.TIMES) SaleAction.ApplyQty else SaleAction.Key(it)) },
                        onName = { naming = true },
                        onGuests = { vm.onAction(SaleAction.Guests) },
                        onCash = { vm.onAction(SaleAction.QuickPay("cash")) },
                        onCard = { vm.onAction(SaleAction.QuickPay("card")) },
                    )
                }
            }
            CategoryStrip(Modifier.weight(1.57f).fillMaxHeight(), ready.categories, ready.selectedCat) {
                vm.onAction(SaleAction.SelectCategory(it))
            }
            Column(Modifier.weight(4.68f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
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
                        // two columns as designed; three when the screen is too
                        // short to show three rows of two
                        val columns = if (maxHeight >= (maxWidth - 4.dp) / 2 / TILE_RATIO * 3) 2 else 3
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
                                    val edge = Pos.css(item.tile_color, categoryColors[item.category_id] ?: Pos.TileEdge)
                                    ItemTile(item, inOrder[item.id] ?: 0, edge) { vm.onAction(SaleAction.TapItem(item)) }
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
                Box(
                    Modifier.fillMaxWidth().height(52.dp).background(if (canPay) Pos.Blue else Pos.Key)
                        .clickable(enabled = canPay, onClick = onPay),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        "Pay - ${Money.format(totals.total)}",
                        color = if (canPay) Color.White else Pos.Text3, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                    )
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
    if (naming) {
        var name by remember { mutableStateOf(ticket?.name ?: "") }
        AlertDialog(
            onDismissRequest = { naming = false },
            title = { Text("Tab name") },
            text = {
                OutlinedTextField(name, { name = it.take(40) }, Modifier.fillMaxWidth(), label = { Text("Name for this order") }, singleLine = true)
            },
            confirmButton = {
                Button(onClick = { vm.onAction(SaleAction.SetName(name)); naming = false }) { Text("Save") }
            },
            dismissButton = { OutlinedButton(onClick = { naming = false }) { Text("Cancel") } },
        )
    }
    voidTarget?.let { id ->
        AlertDialog(
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

@Composable
private fun OrderPanel(
    modifier: Modifier,
    ticket: TicketEntity?,
    lines: List<LineUi>,
    totals: Calc.Totals,
    selected: String?,
    dining: List<DiningOptionEntity>,
    discounts: List<DiscountEntity>,
    discount: DiscountPick?,
    onAction: (SaleAction) -> Unit,
    onDiscount: (DiscountPick?) -> Unit,
    onVoid: (String) -> Unit,
) {
    var actionsOpen by remember { mutableStateOf(false) }
    var diningOpen by remember { mutableStateOf(false) }
    Column(modifier.background(Pos.Panel)) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                ticket?.name ?: "Direct sale", Modifier.weight(1f),
                color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Box {
                Text(
                    "Actions", Modifier.clickable { actionsOpen = true }.padding(horizontal = 8.dp, vertical = 8.dp),
                    color = Pos.NavOn, fontSize = 14.sp, fontWeight = FontWeight.Medium,
                )
                DropdownMenu(expanded = actionsOpen, onDismissRequest = { actionsOpen = false }) {
                    DropdownMenuItem(text = { Text("New order") }, onClick = { actionsOpen = false; onAction(SaleAction.NewTicket) })
                    if (discounts.isNotEmpty()) {
                        HorizontalDivider()
                        DropdownMenuItem(
                            text = { Text(if (discount == null) "No discount  ✓" else "No discount") },
                            onClick = { actionsOpen = false; onDiscount(null) },
                        )
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
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
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
            ticket?.covers?.let { Chip(if (it == 1) "1 guest" else "$it guests") }
            discount?.let { Chip(it.name) }
        }
        HorizontalDivider(color = Pos.Line)
        // a line that was just selected, or replaced by a quantity change, stays in view
        val listState = rememberLazyListState()
        LaunchedEffect(selected, lines.size) {
            val at = lines.indexOfFirst { it.line.id == selected }
            if (at >= 0) listState.animateScrollToItem(at)
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().background(Brush.verticalGradient(listOf(Pos.Panel, Pos.PanelDeep))), state = listState) {
            items(lines, key = { it.line.id }) { lu ->
                LineRow(lu, selected == lu.line.id, onAction, onVoid)
                HorizontalDivider(color = Pos.Line)
            }
        }
        HorizontalDivider(color = Pos.Line)
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

// One line of the order. Tapping it selects it: the keypad's quantity key and
// the buttons under it then act on this line. A paid line is locked.
@Composable
private fun LineRow(lu: LineUi, selected: Boolean, onAction: (SaleAction) -> Unit, onVoid: (String) -> Unit) {
    val l = lu.line
    Column(
        Modifier.fillMaxWidth().background(if (selected) Pos.Selected else Color.Transparent)
            .clickable(enabled = !l.paid) { onAction(SaleAction.SelectLine(if (selected) null else l.id)) }
            .alpha(if (l.paid) 0.5f else 1f)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Row(Modifier.fillMaxWidth()) {
            Text("${l.qty / 1000}×", Modifier.width(34.dp), color = Pos.Text2, fontSize = 14.sp)
            Column(Modifier.weight(1f)) {
                Text(l.name_snapshot + if (l.paid) "  (paid)" else "", color = Pos.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                if (lu.mods.isNotBlank()) Text(lu.mods, color = Pos.Text2, fontSize = 12.sp)
                l.note?.takeIf { it.isNotBlank() }?.let { Text("Note: $it", color = Pos.Text2, fontSize = 12.sp) }
            }
            Text(Money.format(lu.amount), color = Pos.Text, fontSize = 14.sp)
        }
        if (selected) {
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                LineButton("−", Pos.Key) {
                    val q = l.qty / 1000 - 1
                    if (q <= 0) onVoid(l.id) else onAction(SaleAction.SetQty(l.id, q))
                }
                LineButton("+", Pos.Key) { onAction(SaleAction.SetQty(l.id, l.qty / 1000 + 1)) }
                Spacer(Modifier.weight(1f))
                LineButton("Void", Pos.Danger) { onVoid(l.id) }
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

// Number keys on the left, four actions on the right. The number is used by
// what is tapped next.
@Composable
private fun Keypad(
    keyHeight: Dp,
    buffer: String,
    onKey: (String) -> Unit,
    onName: () -> Unit,
    onGuests: () -> Unit,
    onCash: () -> Unit,
    onCard: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().background(Pos.Panel)) {
        Row(Modifier.fillMaxWidth().height(40.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                "Use keypad to apply quantity, guests or payment", Modifier.weight(1f),
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
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                listOf(
                    Triple("Tab name", Pos.Blue, onName), Triple("Guests", Pos.Blue, onGuests),
                    Triple("Cash", Pos.Green, onCash), Triple("Card", Pos.Green, onCard),
                ).forEach { (label, color, press) ->
                    Box(
                        Modifier.weight(1f).fillMaxWidth().background(color).clickable(onClick = press),
                        contentAlignment = Alignment.Center,
                    ) { Text(label, color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium, maxLines = 1) }
                }
            }
        }
    }
}

private val CATEGORY_MIN = 56.dp // the smallest a category button gets before the strip pages

// Categories in the colours set in the back office, stacked to fill the
// height. When they do not all fit, the strip shows a page of them and its
// last slot becomes the pager: down for the next page, up for the previous.
@Composable
private fun CategoryStrip(modifier: Modifier, categories: List<CategoryEntity>, selected: String?, onPick: (String) -> Unit) {
    BoxWithConstraints(modifier) {
        val gap = 1.dp
        val slots = ((maxHeight + gap) / (CATEGORY_MIN + gap)).toInt().coerceAtLeast(2)
        val paged = categories.size > slots
        val perPage = if (paged) slots - 1 else categories.size.coerceAtLeast(1)
        val pages = if (paged) (categories.size + perPage - 1) / perPage else 1
        // opens on the page that holds the selected category
        var page by remember(perPage, categories.size) {
            mutableStateOf(if (paged) categories.indexOfFirst { it.id == selected }.coerceAtLeast(0) / perPage else 0)
        }
        val current = page.coerceIn(0, pages - 1)
        val rows = if (paged) slots else perPage
        val each = ((maxHeight - gap * (rows - 1)) / rows).coerceAtMost(84.dp)
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(gap)) {
            (if (paged) categories.drop(current * perPage).take(perPage) else categories).forEach { c ->
                val color = Pos.css(c.color, Pos.CategoryDefault)
                val on = c.id == selected
                Box(Modifier.fillMaxWidth().height(each).background(color).clickable { onPick(c.id) }, contentAlignment = Alignment.Center) {
                    if (on) Box(Modifier.align(Alignment.CenterStart).width(5.dp).fillMaxHeight().background(Color.White))
                    Text(
                        c.name, Modifier.padding(horizontal = 10.dp),
                        color = if (color.luminance() > 0.5f) Pos.Line else Color.White,
                        fontSize = 14.sp, fontWeight = if (on) FontWeight.Bold else FontWeight.Medium,
                        textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (paged) {
                // the pager stays in the last slot when the last page is short
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
private fun ItemTile(item: ItemEntity, inOrder: Int, edge: Color, onTap: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().aspectRatio(TILE_RATIO).background(Pos.Tile)
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
                            val next = if (g.max_select <= 1) setOf(m.id)
                            else if (cur.contains(m.id)) cur - m.id else cur + m.id
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

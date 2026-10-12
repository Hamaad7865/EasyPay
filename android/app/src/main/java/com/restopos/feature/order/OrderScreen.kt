package com.restopos.feature.order

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.LineInfo
import com.restopos.core.data.ModPick
import com.restopos.core.data.OrderInfo
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.database.TicketLineModEntity
import com.restopos.core.ui.Caps
import com.restopos.core.ui.FastKey
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.GoRow
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.L
import com.restopos.core.ui.Motion
import com.restopos.core.ui.PayKey
import com.restopos.core.ui.PictureBand
import com.restopos.core.ui.Pos
import com.restopos.core.ui.Rail
import com.restopos.core.ui.RailKey
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.SellFit
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.Stepper
import com.restopos.core.ui.T
import com.restopos.core.ui.TotalRow
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.anyPictured
import com.restopos.core.ui.inSight
import com.restopos.core.ui.press
import com.restopos.core.ui.rememberPress
import com.restopos.feature.customers.CustomerPicker
import kotlinx.coroutines.flow.collectLatest
import java.text.SimpleDateFormat
import java.util.Locale

// the colours a category gets when the back office gave it none
private fun colorOf(c: CategoryEntity?, index: Int): Color = com.restopos.core.ui.catColor(c?.color, index)
private val HM = SimpleDateFormat("HH:mm", Locale.US)

// The order screen, after the board the owner approved for selling: the menu
// on the left (a search over the categories, listed down the side, the items
// as cards, and under them the keys of the lit line's options), the order on
// the right with what the kitchen has and what it has not, and under it its
// total, then Send, Fast and Pay. Settings, Display puts the order on the left.
// onFast: the order paid in cash, the exact amount, without the payment screen.
@Composable
fun OrderScreen(vm: OrderViewModel, onBack: (board: Boolean) -> Unit, onPay: () -> Unit, onFast: () -> Unit, onSplit: () -> Unit, onSent: () -> Unit, onGone: (board: Boolean) -> Unit) {
    val ui by vm.ui.collectAsState()
    val sheet by vm.sheet.collectAsState()
    val asking by vm.asking.collectAsState()
    var more by remember { mutableStateOf(false) }
    val orderLeft by vm.orderLeft.collectAsState()
    LaunchedEffect(Unit) { vm.open() }
    // while this screen is open, a scanned barcode adds its item
    LaunchedEffect(Unit) { com.restopos.core.common.Scanner.codes.collect { vm.scanned(it) } }

    // On a screen that is not tall (a 10-inch, where the till is drawn larger:
    // core/ui/ScreenFit) the order gives way, so that the order itself can still
    // be read: its head, its lines, its total and its keys are a little lower.
    // On one that is not wide, the list of categories and the order are
    // narrower (core/ui/SellParts). A large screen is drawn in full.
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val low = maxHeight < 600.dp
        val narrow = SellFit.narrow(maxWidth)
        Row(Modifier.fillMaxSize().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (!orderLeft) Menu(ui, vm, narrow, low, Modifier.weight(1f))
            Column(Modifier.width(SellFit.sale(narrow)).fillMaxHeight().clip(RoundedCornerShape(20.dp)).background(V.Panel)) {
                Head(ui, vm, low, onMore = { more = true }) { onBack(ui.board) }
                Lines(ui, vm, low, Modifier.weight(1f))
                Column(
                    Modifier.fillMaxWidth().background(V.PanelFoot).padding(start = 16.dp, end = 16.dp, top = if (low) 8.dp else 12.dp, bottom = if (low) 10.dp else 14.dp),
                    verticalArrangement = Arrangement.spacedBy(if (low) 6.dp else 8.dp),
                ) {
                    Totals(ui, low)
                    val fn = if (low) 40.dp else 44.dp
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (ui.dine) Fn(L.printBill, VI.Print, V.Soft, Modifier.weight(1f), fn) { vm.printBill() }
                        // a counter sale can wait while the next customer is served
                        else if (ui.kind == "counter" || ui.kind == "tab") Fn(L.newSale, VI.Plus, if (!ui.empty) V.Soft else V.Off, Modifier.weight(1f), fn) { vm.newSale() }
                        Fn(L.split, VI.Split, V.Soft, Modifier.weight(1f), fn) { if (vm.mayPay()) onSplit() }
                        Fn(L.clearNew, VI.Close, if (ui.unsent > 0) V.RedText else V.Off, Modifier.weight(1f), fn) { vm.clearNew() }
                    }
                    GoRow(low) {
                        // A table's bill is printed and brought before it is paid: it has Send
                        // and Pay, half each. The others have Fast between them.
                        val on = ui.unsent > 0 && !ui.busy
                        Box(
                            (if (ui.dine) Modifier.weight(1f) else Modifier.width(if (narrow) 92.dp else 104.dp)).fillMaxHeight()
                                .press { vm.send(onSent) }.clip(RoundedCornerShape(16.dp)).background(if (on) V.Blue else V.Key).padding(horizontal = 8.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            T((if (ui.dine) L.send else L.sendShort) + if (ui.unsent > 0) " · ${ui.unsent}" else "", 16.sp, 800, if (on) Color.White else V.Text3, lines = 2, align = TextAlign.Center, height = 19.sp)
                        }
                        if (!ui.dine) FastKey(!ui.empty, if (narrow) 84.dp else 96.dp) { if (vm.mayPay()) onFast() }
                        PayKey(L.pay, !ui.empty) { if (vm.mayPay()) onPay() }
                    }
                }
            }
            if (orderLeft) Menu(ui, vm, narrow, low, Modifier.weight(1f))
        }
    }

    sheet?.let { OptionsSheet(it, ui.notes, vm) }
    // an item whose price is typed at the sale: the keypad
    asking?.let { com.restopos.feature.retail.NumSheet(it) { vm.closeAsk() } }
    if (more) MoreSheet(ui, vm, onDismiss = { more = false }, onGone = { more = false; onGone(ui.board) })
}

// What the order is, and what can be said about it up front: how many
// guests at a table; for the others what kind of order it is and who it is for.
@Composable
private fun Head(ui: OrderUi, vm: OrderViewModel, low: Boolean, onMore: () -> Unit, onBack: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(start = 6.dp, end = 6.dp, top = if (low) 4.dp else 8.dp, bottom = if (low) 6.dp else 8.dp),
        verticalArrangement = Arrangement.spacedBy(if (low) 6.dp else 8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            IconKey(VI.Back, bg = Color.Transparent, tint = V.Text, width = 2.2f, onClick = onBack)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    T(ui.title, 19.sp, 800, spacing = (-0.3).sp, modifier = Modifier.weight(1f, fill = false))
                    if (ui.count > 0) T("(${ui.count})", 15.sp, 700, V.Text3, Modifier.padding(bottom = 1.dp))
                }
                T(ui.sub, 13.sp, 600, V.Text2)
            }
            if (ui.dine) Stepper(ui.covers.toString(), L.covers, onDown = { vm.covers(-1) }, onUp = { vm.covers(1) })
            IconKey(VI.More, bg = Color.Transparent, tint = V.Text, icon = 22.dp, width = 3f, onClick = onMore)
        }
        if (!ui.dine && ui.modes.size > 1) {
            Seg(ui.modes.take(4).map { m -> SegOption(m.name, m.id == ui.typeId) { vm.setType(m.id) } }, Modifier.fillMaxWidth().padding(horizontal = 6.dp), V.Well, if (low) 36.dp else 40.dp, 12.dp, fill = true, size = 14.sp)
        }
        if (ui.board) {
            // typed here, saved after a pause; another order starts them afresh
            var name by remember(ui.session) { mutableStateOf(ui.ticket?.name ?: "") }
            var phone by remember(ui.session) { mutableStateOf(ui.ticket?.phone ?: "") }
            Row(Modifier.padding(horizontal = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(name, { name = it.take(60); vm.contact(name = name, phone = phone) }, "Customer name", Modifier.weight(1f))
                Field(phone, { phone = it.take(24); vm.contact(name = name, phone = phone) }, "+230 5…", Modifier.weight(1f), phone = true)
            }
            if (ui.kind == "delivery") {
                var address by remember(ui.session) { mutableStateOf(ui.ticket?.address ?: "") }
                Field(address, { address = it.take(160); vm.contact(address = address) }, "Delivery address · e.g. Royal Rd, Grand Baie", Modifier.fillMaxWidth().padding(horizontal = 6.dp))
            }
        }
    }
}

// The order's lines, each on a card: how many, what, its options one by one
// with what each is charged, its kitchen note, what it comes to. The line the
// keys under the menu are for is lit.
@Composable
private fun Lines(ui: OrderUi, vm: OrderViewModel, low: Boolean, modifier: Modifier) {
    if (ui.empty) {
        Column(modifier.fillMaxWidth().padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            VIcon(VI.Receipt, 40.dp, V.Stroke2, 1.6f)
            Spacer(Modifier.height(10.dp))
            T(L.empty, 15.sp, 600, V.Text3, lines = 2)
        }
        return
    }
    val keys by vm.keys.collectAsState()
    // A line just added is brought into sight: the list shows a few at a time,
    // and what was tapped last is what the cashier looks for.
    val list = rememberLazyListState()
    val had = remember { intArrayOf(ui.fresh.size) }
    LaunchedEffect(ui.fresh.size) {
        if (ui.fresh.size > had[0]) list.animateScrollToItem((list.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
        had[0] = ui.fresh.size
    }
    LazyColumn(modifier.fillMaxWidth(), list, contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (ui.sent.isNotEmpty()) {
            item { Caps(L.inKitchen, modifier = Modifier.padding(start = 4.dp, top = if (low) 2.dp else 4.dp), size = 11.sp) }
            items(ui.sent, key = { it.line.id }) { l ->
                val on = ui.selected == l.line.id
                val paid = l.line.paid
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (on) V.RowOn else V.Key2)) {
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = !paid) { vm.select(if (on) null else l.line.id) }.padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        T(l.units.toString(), 15.sp, 800, V.Text2, Modifier.width(24.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(l.line.name_snapshot, 15.sp, 600, V.Dim, lines = 2)
                            Options(ui.mods[l.line.id], l)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                VIcon(VI.Check, 12.dp, V.GreenText, 3f)
                                val at = l.line.sent_to_kitchen_at?.let { runCatching { HM.format(java.util.Date(java.time.Instant.parse(it).toEpochMilli())) }.getOrNull() }
                                T((if (paid) "Paid" else "") + (if (paid && at != null) " · " else "") + (at?.let { "Sent $it" } ?: ""), 12.sp, 700, V.GreenText)
                            }
                        }
                        T(Money.format(l.amount), 15.sp, 700, V.Dim)
                    }
                    if (on) {
                        Row(Modifier.fillMaxWidth().inSight().padding(start = 46.dp, end = 12.dp, bottom = 10.dp)) {
                            Gap()
                            VBtn("Void · tell the kitchen", bg = V.RedWash, fg = V.RedText, height = 44.dp, radius = 10.dp, size = 14.sp) { vm.remove(l.line.id) }
                        }
                    }
                }
            }
        }
        if (ui.fresh.isNotEmpty()) {
            item { Caps(L.notSent, V.BlueText, Modifier.padding(start = 4.dp, top = if (low) 4.dp else 6.dp), 11.sp) }
            items(ui.fresh, key = { it.line.id }) { l ->
                val on = ui.selected == l.line.id
                val lit = on || keys?.lineId == l.line.id
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(if (lit) V.RowOn else V.Key2)) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = if (low) 44.dp else 48.dp).clickable { vm.select(if (on) null else l.line.id) }
                            .padding(start = 12.dp, end = 4.dp, top = if (low) 6.dp else 8.dp, bottom = if (low) 6.dp else 8.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        T(l.units.toString(), 15.sp, 800, modifier = Modifier.width(24.dp).padding(top = 6.dp))
                        Column(Modifier.weight(1f).padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(l.line.name_snapshot, 15.sp, 700, lines = 2)
                            Options(ui.mods[l.line.id], l)
                        }
                        T(Money.format(l.amount), 15.sp, 700, modifier = Modifier.padding(top = 6.dp))
                        // taken off at once, as Remove under it does
                        Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).clickable { vm.remove(l.line.id) }, contentAlignment = Alignment.Center) {
                            VIcon(VI.Trash, 16.dp, V.Text3)
                        }
                    }
                    if (on) {
                        Row(Modifier.fillMaxWidth().inSight().padding(start = 46.dp, end = 12.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Box(Modifier.size(52.dp, 44.dp).clip(RoundedCornerShape(10.dp)).background(V.Hover).clickable { vm.bump(l, -1) }, contentAlignment = Alignment.Center) { T("−", 20.sp, 700) }
                            Box(Modifier.size(52.dp, 44.dp).clip(RoundedCornerShape(10.dp)).background(V.Hover).clickable { vm.bump(l, 1) }, contentAlignment = Alignment.Center) { T("+", 20.sp, 700) }
                            Gap()
                            VBtn(L.remove, bg = V.RedWash, fg = V.RedText, height = 44.dp, radius = 10.dp, size = 14.sp) { vm.remove(l.line.id) }
                        }
                    }
                }
            }
        }
    }
}

// A line's options under its name, one to a row with what each is charged,
// then its kitchen note. Read from the line's own options (OrderUi.mods);
// before they are read, the line's description says them on one row.
@Composable
private fun Options(mods: List<TicketLineModEntity>?, l: LineInfo) {
    if (mods.isNullOrEmpty()) {
        if (l.mods.isNotBlank()) T(l.mods, 13.sp, 500, V.Text2, lines = 2)
    } else {
        mods.forEach { m ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                T("+ " + m.name_snapshot, 13.sp, 500, V.Text2, Modifier.weight(1f))
                if (m.price != 0L) T(Money.format(m.price), 13.sp, 500, V.Text2)
            }
        }
    }
    l.line.note?.takeIf { it.isNotBlank() }?.let { T("“$it”", 13.sp, 500, V.Text3, lines = 2) }
}

@Composable
private fun Totals(ui: OrderUi, low: Boolean) {
    val t = ui.totals
    Column(verticalArrangement = Arrangement.spacedBy(if (low) 2.dp else 4.dp)) {
        if (t.service > 0 || t.discount > 0) Small(L.subtotal, Money.format(t.subtotal))
        if (t.discount > 0) Small("${L.discount} · ${ui.discount?.name ?: ""}", "− " + Money.format(t.discount), V.AmberText)
        if (t.service > 0) Small(L.serviceCharge, Money.format(t.service))
        if (ui.paid > 0) Small("Already paid", "− " + Money.format(ui.paid), V.GreenText, 700)
        Small(L.t("Of which tax", "Dont taxes", "Ladan tax"), Money.format(t.tax), V.Text3)
    }
    TotalRow(L.total, ui.count, Money.format(t.total), low)
}

@Composable
private fun Small(label: String, value: String, color: Color = V.Text2, weight: Int = 600) {
    Row {
        T(label, 14.sp, weight, color, Modifier.weight(1f))
        T(value, 14.sp, weight, color)
    }
}

@Composable
private fun Fn(label: String, icon: String, fg: Color, modifier: Modifier, height: Dp, onClick: () -> Unit) {
    Row(
        modifier.height(height).clip(RoundedCornerShape(12.dp)).background(V.Key).clickable(onClick = onClick).padding(horizontal = 2.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        VIcon(icon, 14.dp, fg)
        Spacer(Modifier.width(4.dp))
        T(label, 12.5.sp, 700, fg)
    }
}

// The menu: a search over the whole menu, the categories in a list down the
// side, the items as cards, and under them the keys of the lit line's
// options. A category's colour (or the one the back office gave an item) is
// a rail down the card's leading edge and a wash from it, not the whole card.
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Menu(ui: OrderUi, vm: OrderViewModel, narrow: Boolean, low: Boolean, modifier: Modifier) {
    val cats by vm.cats.collectAsState()
    val cat by vm.cat.collectAsState()
    val q by vm.query.collectAsState()
    val items by vm.items.collectAsState()
    val withOptions by vm.withOptions.collectAsState()
    val catCounts by vm.catCounts.collectAsState()
    val keys by vm.keys.collectAsState()
    val searching = q.isNotBlank()
    val index = remember(cats) { cats.mapIndexed { i, c -> c.id to i }.toMap() }
    val byId = remember(cats) { cats.associateBy { it.id } }
    // how many of each item are on the order and not sent yet
    val counts = remember(ui.fresh) { ui.fresh.groupBy { it.line.item_id }.mapValues { e -> e.value.sumOf { it.units } } }
    val band = anyPictured(items) { it.id }

    Column(modifier.fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.fillMaxWidth()) {
            Field(q, { vm.query.value = it.take(40) }, L.search, Modifier.fillMaxWidth(), height = 52.dp, bg = V.Panel, size = 16.sp, leading = { VIcon(VI.Search, 20.dp, V.Text2) })
            if (searching) {
                Box(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp)) { IconKey(VI.Close, size = 40.dp, onClick = { vm.query.value = "" }) }
            }
        }
        Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Rail(SellFit.rail(narrow)) {
                items(cats, key = { it.id }) { c -> RailKey(c.name, catCounts[c.id], !searching && c.id == cat, colorOf(c, index[c.id] ?: 0)) { vm.pickCat(c.id) } }
            }
            BoxWithConstraints(Modifier.weight(1f).fillMaxHeight()) {
                // as many keys to a row under the menu as cards above them
                val cols = ((maxWidth + 10.dp) / 160.dp).toInt().coerceAtLeast(2)
                Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (searching) {
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            T("Results for “${q.trim()}”", 18.sp, 800, spacing = (-0.3).sp, modifier = Modifier.weight(1f, fill = false))
                            T("${items.size} items", 13.sp, 600, V.Text3)
                        }
                    }
                    // Another category's items come up into place. The ones that are there
                    // when the screen opens are simply there.
                    val seen = remember { arrayOfNulls<String>(1) }
                    val shown = remember(cat) { Animatable(if (seen[0] == null) 1f else 0f).also { if (cat != null) seen[0] = cat } }
                    LaunchedEffect(shown) { shown.animateTo(1f, Motion.enter(200)) }
                    LazyVerticalGrid(
                        GridCells.Adaptive(150.dp), Modifier.weight(1f).fillMaxWidth().graphicsLayer { alpha = shown.value; translationY = (1f - shown.value) * 10.dp.toPx() },
                        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        if (items.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                            T(if (searching) "Nothing on the menu matches that search." else (if (com.restopos.core.data.Journey.alone) "No items in this category yet. Add them on Menu & stock." else "No items in this category yet. Add them in the back office, under Items."), 15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3)
                        }
                        items(items, key = { it.id }) { i -> MenuCard(i, byId, index, counts[i.id] ?: 0, withOptions.contains(i.id), band, vm) }
                    }
                    keys?.let { OptionKeysPanel(it, ui.notes, vm, cols, low) }
                }
            }
        }
    }
}

// An item's card: its picture along the top with how many are on the order
// unsent in its corner, its name and price under it on the card's own ground.
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MenuCard(i: ItemEntity, byId: Map<String, CategoryEntity>, index: Map<String, Int>, n: Int, options: Boolean, band: Boolean, vm: OrderViewModel) {
    val out = !i.is_available
    val hue = Pos.css(i.tile_color, colorOf(byId[i.category_id], index[i.category_id] ?: 0))
    val tag = i.tags.split(',').firstOrNull { it.isNotBlank() }?.trim()?.replaceFirstChar { it.uppercase() }
    val rail = if (out) V.Stroke2 else hue
    val source = remember { MutableInteractionSource() }
    val press = rememberPress(source, 0.97f)
    // Its count jumps when one more of it goes on the order, and only
    // then: not when the card is merely shown again.
    val pop = remember { Animatable(1f) }
    LaunchedEffect(i.id) {
        vm.added.collectLatest { id ->
            if (id == i.id) {
                pop.snapTo(1.28f)
                pop.animateTo(1f, spring(dampingRatio = 0.45f, stiffness = 500f))
            }
        }
    }
    // how many of it are on the order and not sent yet
    val count: @Composable (Modifier) -> Unit = { at ->
        if (n > 0) {
            Box(
                at.graphicsLayer { scaleX = pop.value; scaleY = pop.value }.heightIn(min = 26.dp).widthIn(min = 26.dp)
                    .clip(RoundedCornerShape(13.dp)).background(V.On).padding(horizontal = 7.dp),
                contentAlignment = Alignment.Center,
            ) { T(n.toString(), 13.sp, 800, V.OnText) }
        }
    }
    Column(
        Modifier.graphicsLayer { scaleX = press.value; scaleY = press.value }
            .clip(RoundedCornerShape(14.dp)).background(V.Panel)
            .border(1.dp, V.Stroke, RoundedCornerShape(14.dp))
            .combinedClickable(interactionSource = source, indication = null, onClick = { vm.tap(i) }, onLongClick = { vm.tap(i, ask = true) }),
    ) {
        // Its picture along the top, the count in its corner; an item with none shows its initials on its category's colour.
        if (band) Box {
            PictureBand(i.id, i.name, if (out) V.Well else hue.copy(alpha = 0.18f).compositeOver(V.Well), off = out)
            count(Modifier.align(Alignment.TopEnd).padding(8.dp))
        }
        // The name and the price, on the card's own ground: the category's colour is a rail down their side and a wash from it.
        Box(
            Modifier.fillMaxWidth().height(if (band) 88.dp else 104.dp)
                .drawBehind {
                    if (!out) drawRect(Brush.horizontalGradient(0f to hue.copy(alpha = 0.20f), 0.8f to hue.copy(alpha = 0.03f)))
                    drawRect(rail, size = Size(4.dp.toPx(), size.height))
                }
                .padding(start = 16.dp, end = 12.dp, top = if (band) 10.dp else 12.dp, bottom = if (band) 10.dp else 11.dp),
        ) {
            T(i.name, 15.sp, 700, if (out) V.Text3 else V.Text, Modifier.align(Alignment.TopStart).padding(end = if (n > 0 && !band) 30.dp else 0.dp), lines = if (band) 2 else 3, height = 19.sp)
            Row(Modifier.align(Alignment.BottomStart).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                T(if (i.open_price) "Enter price" else Money.format(i.price), 14.sp, 700, if (out) V.Text3 else V.Text2)
                Gap()
                // what else there is to know about it, said quietly
                val note = if (out) "Sold out" else listOfNotNull(tag, if (options) "Options" else null).joinToString(" · ")
                if (note.isNotEmpty()) T(note, 12.sp, if (out) 700 else 600, if (out) V.RedText else V.Text3)
            }
            if (!band) count(Modifier.align(Alignment.TopEnd))
        }
    }
}

// The keys under the menu (the approved board's "tap to add"): the options of
// the lit line's item, as the options sheet's keys, then the kitchen notes, as
// its note keys. A tap puts one on the line or takes it off. The panel keeps to
// a few rows; more scroll in it, so the menu above keeps its room.
@Composable
private fun OptionKeysPanel(k: OptionKeys, notes: List<String>, vm: OrderViewModel, cols: Int, low: Boolean) {
    // the till's kitchen notes, then any other the line carries (one typed in the options sheet)
    val keys = k.ordered.map { m -> KeyOf(m.name, if (m.price != 0L) "+ " + Money.format(m.price) else null, m.id in k.picked, false) { vm.toggleOption(m) } } +
        (notes + k.notes.filter { it !in notes }).map { n -> KeyOf(n, null, n in k.notes, true) { vm.toggleNote(n) } }
    Column(Modifier.fillMaxWidth().heightIn(max = if (low) 150.dp else 196.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            T(k.item.name, 15.sp, 800)
            T(L.optionsTap, 12.5.sp, 600, V.Text3, Modifier.weight(1f))
            IconKey(VI.Close, size = 36.dp, bg = Color.Transparent, tint = V.Text2) { vm.closeKeys() }
        }
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            keys.chunked(cols).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    row.forEach { key -> OptionKey(key.label, key.price, key.on, key.note, Modifier.weight(1f), key.tap) }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

private class KeyOf(val label: String, val price: String?, val on: Boolean, val note: Boolean, val tap: () -> Unit)

// One key under the menu. An option is drawn as the options sheet draws one
// (lit: V.On); a kitchen note as its note keys (lit: the accent's wash).
@Composable
private fun OptionKey(label: String, price: String?, on: Boolean, note: Boolean, modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(if (note) 27.dp else 12.dp)
    val bg = when { note && on -> V.BlueWash; on -> V.On; else -> V.Key }
    val line = when { note && on -> V.Blue; note -> V.Key; on -> V.On; else -> V.Stroke2 }
    val ink = when { note && on -> V.BlueSoft; note -> V.Dim; on -> V.OnText; else -> V.Text }
    Column(
        modifier.height(54.dp).clip(shape).background(bg).border(1.5.dp, line, shape).clickable(onClick = onClick).padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(1.dp, Alignment.CenterVertically),
    ) {
        T(label, 14.5.sp, 700, ink)
        price?.let { T(it, 12.sp, 700, ink.copy(alpha = 0.8f)) }
    }
}

// An item's options: one pick in each group that wants one, any of the
// kitchen notes, how many.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OptionsSheet(s: OptionSheet, notes: List<String>, vm: OrderViewModel) {
    // which options are picked, group by group. A group that needs one starts on its first.
    val picked = remember(s) {
        mutableStateMapOf<String, List<String>>().apply {
            s.groups.forEach { g -> if (g.min_select >= 1) s.mods.firstOrNull { it.group_id == g.id }?.let { put(g.id, listOf(it.id)) } }
        }
    }
    val said = remember(s) { mutableStateListOf<String>() }
    var other by remember(s) { mutableStateOf("") }
    var qty by remember(s) { mutableIntStateOf(1) }
    val picks = s.mods.filter { m -> picked[m.group_id].orEmpty().contains(m.id) }
    val short = s.groups.firstOrNull { g -> com.restopos.core.guest.OptionRules.tooFew(g.min_select, picked[g.id].orEmpty().size) }

    Sheet(onDismiss = { vm.closeSheet() }) {
        SheetHead(s.item.name, Money.format(s.item.price)) { vm.closeSheet() }
        s.groups.forEach { g ->
            val mine = picked[g.id].orEmpty()
            val max = com.restopos.core.guest.OptionRules.most(g.max_select)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Caps(g.name + if (max > 1) " · up to $max" else "")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    s.mods.filter { it.group_id == g.id }.forEach { m ->
                        val on = mine.contains(m.id)
                        Row(
                            Modifier.height(54.dp).clip(RoundedCornerShape(12.dp)).background(if (on) V.On else V.Key)
                                .border(1.5.dp, if (on) V.On else V.Stroke2, RoundedCornerShape(12.dp))
                                .clickable {
                                    // what a tap leaves picked is one rule, also held to an order sent from a table (core/guest)
                                    picked[g.id] = com.restopos.core.guest.OptionRules.tap(mine, m.id, g.min_select, g.max_select)
                                }.padding(horizontal = 18.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            T(m.name, 15.sp, 700, if (on) V.OnText else V.Text)
                            if (m.price != 0L) T("+" + Money.format(m.price), 12.sp, 700, (if (on) V.OnText else V.Text).copy(alpha = 0.8f))
                        }
                    }
                }
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Caps("Kitchen note")
            // a restaurant with no notes to tick still has the line to type one on
            if (notes.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                notes.forEach { n ->
                    val on = said.contains(n)
                    Box(
                        Modifier.height(44.dp).clip(RoundedCornerShape(22.dp)).background(if (on) V.BlueWash else V.Key)
                            .border(1.5.dp, if (on) V.Blue else V.Key, RoundedCornerShape(22.dp)).clickable { if (on) said.remove(n) else said.add(n) }.padding(horizontal = 14.dp),
                        contentAlignment = Alignment.Center,
                    ) { T(n, 14.sp, 700, if (on) V.BlueSoft else V.Dim) }
                }
            }
            Field(other, { other = it.take(80) }, "Another note for the kitchen", Modifier.fillMaxWidth())
        }
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Stepper(qty.toString(), key = 52.dp, width = 44.dp, big = 20.sp, onDown = { qty = (qty - 1).coerceAtLeast(1) }, onUp = { qty = (qty + 1).coerceAtMost(99) })
            val each = s.item.price * qty + picks.sumOf { it.price }
            VBtn(
                if (short != null) "Pick ${short.name}" else "Add to order · ${Money.format(each)}", Modifier.weight(1f),
                if (short == null) V.Blue else V.Key, if (short == null) Color.White else V.Text3, 60.dp, size = 16.sp, weight = 800, enabled = short == null,
            ) { vm.confirm(qty, picks.map { ModPick(it.id, it.name, it.price) }, (said + listOfNotNull(other.trim().ifEmpty { null })).joinToString(" · ")) }
        }
    }
}

// What else can be done to an order: the things that are not needed on every one.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MoreSheet(ui: OrderUi, vm: OrderViewModel, onDismiss: () -> Unit, onGone: () -> Unit) {
    var page by remember { mutableStateOf("menu") }
    var discounts by remember { mutableStateOf<List<DiscountEntity>>(emptyList()) }
    var waiters by remember { mutableStateOf<List<EmployeeEntity>>(emptyList()) }
    var tables by remember { mutableStateOf<List<TableEntity>>(emptyList()) }
    // the tables that have an order of their own, which this one could join
    var seated by remember { mutableStateOf<List<OrderInfo>>(emptyList()) }
    var joining by remember { mutableStateOf<OrderInfo?>(null) }
    LaunchedEffect(Unit) { discounts = vm.discounts(); waiters = vm.waiters(); tables = vm.freeTables(); seated = vm.seatedTables() }

    if (page == "customer") {
        CustomerPicker(ui.ticket?.customer_id, onDismiss = onDismiss) { id -> vm.setCustomer(id); onDismiss() }
        return
    }
    Sheet(onDismiss = onDismiss, width = 620.dp) {
        when (page) {
            "menu" -> {
                SheetHead(ui.title, "More for this order", onDismiss)
                val keys = listOfNotNull(
                    Triple("discount", VI.Tag, L.discount + (ui.discount?.let { " · ${it.name}" } ?: "")),
                    if (ui.dine) Triple("move", VI.Swap, "Move or merge") else null,
                    Triple("waiter", VI.Person, "Change server" + (ui.waiter?.let { " · $it" } ?: "")),
                    Triple("note", VI.Note, if (ui.ticket?.note.isNullOrBlank()) "Order note" else "Order note · ${ui.ticket?.note}"),
                    Triple("customer", VI.People, "Customer" + (ui.customer?.let { " · $it" } ?: "")),
                    Triple("kitchen", VI.Print, "Print the kitchen order again"),
                )
                keys.chunked(2).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        row.forEach { (id, icon, label) ->
                            Row(
                                Modifier.weight(1f).height(64.dp).clip(RoundedCornerShape(12.dp)).background(V.Key)
                                    .clickable { if (id == "kitchen") { vm.reprintKitchen(); onDismiss() } else page = id }.padding(horizontal = 16.dp),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                VIcon(icon, 20.dp, V.Dim)
                                T(label, 15.sp, 700, lines = 2, height = 18.sp)
                            }
                        }
                        if (row.size == 1) Spacer(Modifier.weight(1f))
                    }
                }
                VBtn("Cancel this order", Modifier.fillMaxWidth(), V.RedWash, V.RedText, icon = VI.Trash) { page = "cancel" }
            }
            "discount" -> {
                SheetHead(L.discount, "Taken off when the order is paid.") { page = "menu" }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    discounts.forEach { d ->
                        val on = ui.discount?.discountId == d.id
                        VBtn(
                            d.name + " · " + (if (d.type == "percent") "${d.value}%" else Money.format(d.value)) + (if (d.requires_approval) " · manager" else ""),
                            bg = if (on) V.On else V.Key, fg = if (on) V.OnText else V.Text, height = 54.dp,
                        ) { vm.setDiscount(DiscountPick(d.id, d.type, d.value, d.name), d.requires_approval); onDismiss() }
                    }
                }
                Caps("Or type one")
                var typed by remember { mutableStateOf("") }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Field(typed, { typed = it.filter { c -> c.isDigit() }.take(6) }, "Amount", Modifier.weight(1f), height = 54.dp, number = true)
                    VBtn("% off", height = 54.dp) {
                        typed.toLongOrNull()?.takeIf { it in 1..100 }?.let { vm.setDiscount(DiscountPick(null, "percent", it, "$it%")); onDismiss() }
                    }
                    VBtn("Rs off", height = 54.dp) {
                        typed.toLongOrNull()?.takeIf { it > 0 }?.let { vm.setDiscount(DiscountPick(null, "amount", it * 100, Money.format(it * 100))); onDismiss() }
                    }
                }
                if (ui.discount != null) VBtn("Take the discount off", Modifier.fillMaxWidth(), V.RedWash, V.RedText) { vm.setDiscount(null); onDismiss() }
            }
            "move" -> {
                SheetHead("Move ${ui.title}", "A free table takes it as it is. A table with an order puts both on one bill.") { page = "menu" }
                if (tables.isEmpty()) T("Every table has an order on it.", 15.sp, 600, V.Text2)
                tables.groupBy { it.area }.forEach { (area, list) ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Caps(area)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            list.forEach { t -> VBtn("${t.name} · ${t.seats}", height = 54.dp) { vm.moveTo(t); onDismiss() } }
                        }
                    }
                }
                if (seated.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Caps("One bill with")
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            seated.forEach { o ->
                                VBtn("${o.table?.name ?: o.label} · ${o.ticket.covers ?: 0} ${L.covers} · ${Money.format(o.due)}", height = 54.dp, icon = VI.Swap) { joining = o; page = "merge" }
                            }
                        }
                    }
                }
            }
            "merge" -> {
                val o = joining
                val there = o?.table?.let { tableLabel(it.name) } ?: o?.label ?: ""
                SheetHead("Put ${ui.title} and $there on one bill?", "Everything on ${ui.title} goes onto $there, and ${ui.title} becomes free. It cannot be undone: to pay apart again, use Split check.") { page = "move" }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VBtn("Keep them apart", Modifier.weight(1f), height = 60.dp) { page = "move" }
                    VBtn("One bill, on $there", Modifier.weight(1f), V.Blue, Color.White, 60.dp, weight = 800) { o?.let { vm.mergeInto(it, there) }; onDismiss() }
                }
            }
            "waiter" -> {
                SheetHead("Change server", "Who looks after this order from now on.") { page = "menu" }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    waiters.forEach { w ->
                        val on = ui.ticket?.opened_by == w.id
                        VBtn(w.name, bg = if (on) V.On else V.Key, fg = if (on) V.OnText else V.Text, height = 54.dp) { vm.setWaiter(w.id); onDismiss() }
                    }
                }
            }
            "note" -> {
                SheetHead("Order note", "Prints on the kitchen order and the receipt.") { page = "menu" }
                var note by remember { mutableStateOf(ui.ticket?.note ?: "") }
                Field(note, { note = it.take(120) }, "e.g. Birthday, candle on the dessert", Modifier.fillMaxWidth(), height = 54.dp)
                VBtn("Save note", Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, size = 16.sp, weight = 800) { vm.setNote(note); onDismiss() }
            }
            "cancel" -> {
                SheetHead("Cancel ${ui.title}?", "Every item comes off. The kitchen is told about the ones it already has." + if (ui.dine) " The table is free again." else "") { page = "menu" }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VBtn("Keep the order", Modifier.weight(1f), height = 60.dp) { page = "menu" }
                    VBtn("Cancel the order", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800) { vm.cancel(onGone) }
                }
            }
        }
    }
}

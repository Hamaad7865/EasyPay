package com.restopos.feature.order

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.LineInfo
import com.restopos.core.data.ModPick
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.TableEntity
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.L
import com.restopos.core.ui.Pos
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.Stepper
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.feature.customers.CustomerPicker
import java.text.SimpleDateFormat
import java.util.Locale

// the colours a category gets when the back office gave it none
private val CAT_COLORS = listOf(0xFFB9521C, 0xFF2459C9, 0xFFB83A3A, 0xFF8F6A0E, 0xFFA8366F, 0xFF117785, 0xFF6243C8, 0xFF74513A).map { Color(it) }
private fun colorOf(c: CategoryEntity?, index: Int): Color = Pos.css(c?.color, CAT_COLORS[Math.floorMod(index, CAT_COLORS.size)])
private fun inkOn(bg: Color): Color = if (bg.luminance() > 0.55f) Color(0xFF0D0F13) else Color.White
private val HM = SimpleDateFormat("HH:mm", Locale.US)

// The order screen: the order down the left with what the kitchen has and
// what it has not, the menu on the right.
@Composable
fun OrderScreen(vm: OrderViewModel, onBack: (board: Boolean) -> Unit, onPay: () -> Unit, onSplit: () -> Unit, onSent: () -> Unit, onGone: (board: Boolean) -> Unit) {
    val ui by vm.ui.collectAsState()
    val sheet by vm.sheet.collectAsState()
    var more by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.open() }

    Row(Modifier.fillMaxSize()) {
        Column(Modifier.width(390.dp).fillMaxHeight().background(V.Panel).drawBehind { drawRect(V.Stroke, Offset(size.width - 1.dp.toPx(), 0f), Size(1.dp.toPx(), size.height)) }) {
            Head(ui, vm) { onBack(ui.board) }
            Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
            Lines(ui, vm, Modifier.weight(1f))
            Totals(ui)
            Column(Modifier.fillMaxWidth().background(V.PanelFoot).padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (ui.dine) Fn(L.printBill, VI.Print, V.Soft, Modifier.weight(1f)) { vm.printBill() }
                    Fn(L.split, VI.Split, V.Soft, Modifier.weight(1f)) { if (vm.mayPay()) onSplit() }
                    Fn(L.clearNew, VI.Close, if (ui.unsent > 0) V.RedText else V.Off, Modifier.weight(1f)) { vm.clearNew() }
                    Fn(L.more, VI.More, V.Soft, Modifier.weight(1f)) { more = true }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    val on = ui.unsent > 0 && !ui.busy
                    VBtn(
                        L.send + if (ui.unsent > 0) " · ${ui.unsent}" else "", Modifier.weight(1f), if (on) V.Blue else V.Key, if (on) Color.White else V.Text3,
                        66.dp, size = 16.sp, weight = 800, pad = 10.dp,
                    ) { vm.send(onSent) }
                    val due = ui.totals.total
                    VBtn(
                        "${L.pay} · ${Money.format(due)}", Modifier.weight(1f), if (!ui.empty) V.Green else V.GreenOff, if (!ui.empty) V.GreenInk else V.GreenOffText,
                        66.dp, size = 16.sp, weight = 800, pad = 10.dp,
                    ) { if (vm.mayPay()) onPay() }
                }
            }
        }
        Menu(ui, vm, Modifier.weight(1f))
    }

    sheet?.let { OptionsSheet(it, ui.notes, vm) }
    if (more) MoreSheet(ui, vm, onDismiss = { more = false }, onGone = { more = false; onGone(ui.board) })
}

// What the order is, and what can be said about it up front: how many
// guests at a table; for the others what kind of order it is and who it is for.
@Composable
private fun Head(ui: OrderUi, vm: OrderViewModel, onBack: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            IconKey(VI.Back, tint = V.Text, width = 2.2f, onClick = onBack)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
                T(ui.title, 20.sp, 800, spacing = (-0.3).sp)
                T(ui.sub, 13.sp, 600, V.Text2)
            }
            if (ui.dine) Stepper(ui.covers.toString(), L.covers, onDown = { vm.covers(-1) }, onUp = { vm.covers(1) })
        }
        if (!ui.dine && ui.modes.size > 1) {
            Seg(ui.modes.take(4).map { m -> SegOption(m.name, m.id == ui.typeId) { vm.setType(m.id) } }, Modifier.fillMaxWidth(), V.Well, 42.dp, 12.dp, fill = true, size = 14.sp)
        }
        if (ui.board) {
            // typed here, saved after a pause; another order starts them afresh
            var name by remember(ui.session) { mutableStateOf(ui.ticket?.name ?: "") }
            var phone by remember(ui.session) { mutableStateOf(ui.ticket?.phone ?: "") }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(name, { name = it.take(60); vm.contact(name = name, phone = phone) }, "Customer name", Modifier.weight(1f))
                Field(phone, { phone = it.take(24); vm.contact(name = name, phone = phone) }, "+230 5…", Modifier.weight(1f), phone = true)
            }
            if (ui.kind == "delivery") {
                var address by remember(ui.session) { mutableStateOf(ui.ticket?.address ?: "") }
                Field(address, { address = it.take(160); vm.contact(address = address) }, "Delivery address · e.g. Royal Rd, Grand Baie", Modifier.fillMaxWidth())
            }
        }
    }
}

@Composable
private fun Lines(ui: OrderUi, vm: OrderViewModel, modifier: Modifier) {
    if (ui.empty) {
        Column(modifier.fillMaxWidth().padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            VIcon(VI.Receipt, 40.dp, V.Stroke2, 1.6f)
            Spacer(Modifier.height(10.dp))
            T(L.empty, 15.sp, 600, V.Text3, lines = 2)
        }
        return
    }
    LazyColumn(modifier.fillMaxWidth()) {
        if (ui.sent.isNotEmpty()) {
            item { Caps(L.inKitchen, modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp), size = 11.sp) }
            items(ui.sent, key = { it.line.id }) { l ->
                val on = ui.selected == l.line.id
                val paid = l.line.paid
                Column(Modifier.fillMaxWidth().background(if (on) V.RowOn else Color.Transparent)) {
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = !paid) { vm.select(if (on) null else l.line.id) }.padding(horizontal = 16.dp, vertical = 9.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        T(l.units.toString(), 15.sp, 800, V.Text2, Modifier.width(26.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(l.line.name_snapshot, 15.sp, 600, V.Dim, lines = 2)
                            if (l.detail.isNotEmpty()) T(l.detail, 13.sp, 500, V.Text2, lines = 2)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                VIcon(VI.Check, 12.dp, V.GreenText, 3f)
                                val at = l.line.sent_to_kitchen_at?.let { runCatching { HM.format(java.util.Date(java.time.Instant.parse(it).toEpochMilli())) }.getOrNull() }
                                T((if (paid) "Paid" else "") + (if (paid && at != null) " · " else "") + (at?.let { "Sent $it" } ?: ""), 12.sp, 700, V.GreenText)
                            }
                        }
                        T(Money.format(l.amount), 15.sp, 700, V.Dim)
                    }
                    if (on) {
                        Row(Modifier.fillMaxWidth().padding(start = 52.dp, end = 16.dp, bottom = 12.dp)) {
                            Gap()
                            VBtn("Void · tell the kitchen", bg = V.RedWash, fg = V.RedText, height = 44.dp, radius = 10.dp, size = 14.sp) { vm.remove(l.line.id) }
                        }
                    }
                }
            }
        }
        if (ui.fresh.isNotEmpty()) {
            item { Caps(L.notSent, V.BlueText, Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 4.dp), 11.sp) }
            items(ui.fresh, key = { it.line.id }) { l ->
                val on = ui.selected == l.line.id
                Column(Modifier.fillMaxWidth().background(if (on) V.RowOn else Color.Transparent)) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 52.dp).clickable { vm.select(if (on) null else l.line.id) }.padding(horizontal = 16.dp, vertical = 11.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        T(l.units.toString(), 15.sp, 800, modifier = Modifier.width(26.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(l.line.name_snapshot, 15.sp, 700, lines = 2)
                            if (l.detail.isNotEmpty()) T(l.detail, 13.sp, 500, V.Text2, lines = 2)
                        }
                        T(Money.format(l.amount), 15.sp, 700)
                    }
                    if (on) {
                        Row(Modifier.fillMaxWidth().padding(start = 52.dp, end = 16.dp, bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
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

@Composable
private fun Totals(ui: OrderUi) {
    val t = ui.totals
    Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
    Column(Modifier.fillMaxWidth().background(V.PanelFoot).padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (t.service > 0 || t.discount > 0) Small(L.subtotal, Money.format(t.subtotal))
        if (t.discount > 0) Small("${L.discount} · ${ui.discount?.name ?: ""}", "− " + Money.format(t.discount), V.AmberText)
        if (t.service > 0) Small(L.serviceCharge, Money.format(t.service))
        if (ui.paid > 0) Small("Already paid", "− " + Money.format(ui.paid), V.GreenText, 700)
        Row(verticalAlignment = Alignment.Bottom) {
            T(L.total, 16.sp, 700)
            Gap()
            T(Money.format(t.total), 28.sp, 800, spacing = (-0.6).sp)
        }
        Row {
            T(L.t("of which tax", "dont taxes"), 13.sp, 600, V.Text3)
            Gap()
            T(Money.format(t.tax), 13.sp, 600, V.Text3)
        }
    }
}

@Composable
private fun Small(label: String, value: String, color: Color = V.Text2, weight: Int = 600) {
    Row {
        T(label, 14.sp, weight, color, Modifier.weight(1f))
        T(value, 14.sp, weight, color)
    }
}

@Composable
private fun Fn(label: String, icon: String, fg: Color, modifier: Modifier, onClick: () -> Unit) {
    Row(
        modifier.height(48.dp).clip(RoundedCornerShape(10.dp)).background(V.Key).clickable(onClick = onClick).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        VIcon(icon, 16.dp, fg)
        Spacer(Modifier.width(5.dp))
        T(label, 13.sp, 700, fg)
    }
}

// The menu: categories in their colours, a search, and the items as tiles.
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Menu(ui: OrderUi, vm: OrderViewModel, modifier: Modifier) {
    val cats by vm.cats.collectAsState()
    val cat by vm.cat.collectAsState()
    val q by vm.query.collectAsState()
    val items by vm.items.collectAsState()
    val withOptions by vm.withOptions.collectAsState()
    val searching = q.isNotBlank()
    val index = remember(cats) { cats.mapIndexed { i, c -> c.id to i }.toMap() }
    val byId = remember(cats) { cats.associateBy { it.id } }
    // how many of each item are on the order and not sent yet
    val counts = remember(ui.fresh) { ui.fresh.groupBy { it.line.item_id }.mapValues { e -> e.value.sumOf { it.units } } }

    Column(modifier.fillMaxHeight().padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth()) {
            val cols = ((maxWidth + 8.dp) / 158.dp).toInt().coerceAtLeast(2)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                cats.chunked(cols).forEach { row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        row.forEach { c ->
                            val on = !searching && c.id == cat
                            val color = colorOf(c, index[c.id] ?: 0)
                            Row(
                                Modifier.weight(1f).height(50.dp).clip(RoundedCornerShape(10.dp)).background(if (on) color else V.Key2).clickable { vm.pickCat(c.id) }.padding(horizontal = 14.dp),
                                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(if (on) inkOn(color) else color))
                                T(c.name, 15.sp, 700, if (on) inkOn(color) else V.Soft)
                            }
                        }
                        repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                T(if (searching) "Results for “${q.trim()}”" else byId[cat]?.name ?: "", 20.sp, 800, spacing = (-0.3).sp, modifier = Modifier.weight(1f, fill = false))
                T("${items.size} items", 13.sp, 600, V.Text3)
            }
            Box(Modifier.width(320.dp)) {
                Field(q, { vm.query.value = it.take(40) }, L.search, Modifier.fillMaxWidth(), bg = V.Panel, leading = { VIcon(VI.Search, 18.dp, V.Text2) })
                if (searching) {
                    Box(
                        Modifier.align(Alignment.CenterEnd).padding(end = 6.dp).size(34.dp).clip(RoundedCornerShape(8.dp)).background(V.Key).clickable { vm.query.value = "" },
                        contentAlignment = Alignment.Center,
                    ) { T("✕", 12.sp, 800, V.Dim) }
                }
            }
        }
        LazyVerticalGrid(
            GridCells.Adaptive(150.dp), Modifier.weight(1f).fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (items.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                T(if (searching) "Nothing on the menu matches that search." else "No items in this category yet. Add them in the back office, under Items.", 15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3)
            }
            items(items, key = { it.id }) { i ->
                val out = !i.is_available
                val bg = if (out) V.Key2 else Pos.css(i.tile_color, colorOf(byId[i.category_id], index[i.category_id] ?: 0))
                val fg = if (out) V.Text3 else inkOn(bg)
                val n = counts[i.id] ?: 0
                val tag = i.tags.split(',').firstOrNull { it.isNotBlank() }?.trim()
                Box(
                    Modifier.height(104.dp).clip(RoundedCornerShape(12.dp)).background(bg)
                        .drawBehind { drawRect(Color(0x2E000000), Offset(0f, size.height - 3.dp.toPx()), Size(size.width, 3.dp.toPx())) }
                        .combinedClickable(onClick = { vm.tap(i) }, onLongClick = { vm.tap(i, ask = true) }).padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 10.dp),
                ) {
                    T(i.name, 15.sp, 800, fg, Modifier.align(Alignment.TopStart).padding(end = 24.dp), lines = 3, height = 18.sp)
                    Row(Modifier.align(Alignment.BottomStart), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        T(Money.format(i.price), 14.sp, 700, fg)
                        if (!out && tag != null) Mark(tag.uppercase())
                        if (!out && withOptions.contains(i.id)) Mark("OPTIONS")
                        if (out) Mark("SOLD OUT", V.Red)
                    }
                    if (n > 0) {
                        Box(Modifier.align(Alignment.TopEnd).heightIn(min = 26.dp).widthIn(min = 26.dp).clip(RoundedCornerShape(13.dp)).background(Color.White).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
                            T(n.toString(), 13.sp, 800, Color(0xFF0D0F13))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Mark(text: String, bg: Color = Color(0x47000000)) {
    Box(Modifier.clip(RoundedCornerShape(5.dp)).background(bg).padding(horizontal = 6.dp, vertical = 3.dp)) { T(text, 10.sp, 800, Color.White, spacing = 0.4.sp) }
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
    val short = s.groups.firstOrNull { g -> picked[g.id].orEmpty().size < g.min_select }

    Sheet(onDismiss = { vm.closeSheet() }) {
        SheetHead(s.item.name, Money.format(s.item.price)) { vm.closeSheet() }
        s.groups.forEach { g ->
            val mine = picked[g.id].orEmpty()
            val max = g.max_select.coerceAtLeast(1)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Caps(g.name + if (max > 1) " · up to $max" else "")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    s.mods.filter { it.group_id == g.id }.forEach { m ->
                        val on = mine.contains(m.id)
                        Row(
                            Modifier.height(54.dp).clip(RoundedCornerShape(12.dp)).background(if (on) V.On else V.Key)
                                .border(1.5.dp, if (on) V.On else V.Stroke2, RoundedCornerShape(12.dp))
                                .clickable {
                                    picked[g.id] = when {
                                        // one pick: tapping another moves it; tapping it again clears it, unless one is needed
                                        max == 1 -> if (on && g.min_select == 0) emptyList() else listOf(m.id)
                                        on -> mine - m.id
                                        mine.size < max -> mine + m.id
                                        else -> mine
                                    }
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
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
    LaunchedEffect(Unit) { discounts = vm.discounts(); waiters = vm.waiters(); tables = vm.freeTables() }

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
                    if (ui.dine) Triple("move", VI.Swap, "Move to another table") else null,
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
                SheetHead("Move ${ui.title}", "Pick the free table the guests are moving to.") { page = "menu" }
                if (tables.isEmpty()) T("Every table has an order on it.", 15.sp, 600, V.Text2)
                tables.groupBy { it.area }.forEach { (area, list) ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Caps(area)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            list.forEach { t -> VBtn("${t.name} · ${t.seats}", height = 54.dp) { vm.moveTo(t); onDismiss() } }
                        }
                    }
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

package com.restopos.feature.retail

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.LinePrice
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.L
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.press
import com.restopos.feature.customers.CustomerPicker
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val HM = SimpleDateFormat("HH:mm", Locale.US)

// A barcode, as six bars: the mark on the search box.
private const val BARS = "M4 6v12M8 6v12M11 6v12M15 6v12M18 6v12M20 6v12"

// A shop's sell screen, after the approved "Sell" board: the sale down the
// left (its lines, what it comes to, Park, Discount, Pay), the products on
// the right (a box to scan or search into, the categories, a tile for each
// product with what is left of it).
@Composable
fun RetailSellScreen(vm: RetailViewModel, onPay: () -> Unit) {
    val ui by vm.ui.collectAsState()
    val picking by vm.picking.collectAsState()
    val asking by vm.asking.collectAsState()
    val parked by vm.parked.collectAsState()
    var sheet by remember { mutableStateOf<String?>(null) } // parked | discount | customer | clear
    var noting by remember { mutableStateOf<SaleLine?>(null) }
    LaunchedEffect(Unit) { vm.open() }
    // while this screen is open, a scanned barcode rings its product up
    LaunchedEffect(Unit) { Scanner.codes.collect { vm.scanned(it) } }

    Row(Modifier.fillMaxSize().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Sale(ui, parked.size, vm, onParked = { sheet = "parked" }, onCustomer = { sheet = "customer" }, onDiscount = { sheet = "discount" }, onClear = { sheet = "clear" }, onNote = { noting = it }, onPay = onPay)
        Products(vm, Modifier.weight(1f))
    }

    picking?.let { VariantSheet(it, vm) }
    asking?.let { NumSheet(it) { vm.closeAsk() } }
    noting?.let { l -> NoteSheet(l, onDismiss = { noting = null }) { note -> vm.setNote(l.line.id, note); noting = null } }
    when (sheet) {
        "parked" -> ParkedSheet(parked.map { ParkedRow(it.id, it.ticket.order_no ?: "Sale", it.lines.filter { l -> !l.line.paid }.size, it.due, it.openedAt) }, onDismiss = { sheet = null }) { id -> vm.resume(id); sheet = null }
        "discount" -> DiscountSheet(ui, vm) { sheet = null }
        "customer" -> CustomerPicker(ui.ticket?.customer_id, what = "sale", onDismiss = { sheet = null }) { id -> vm.setCustomer(id); sheet = null }
        "clear" -> Sheet(onDismiss = { sheet = null }, width = 520.dp) {
            SheetHead("Clear this sale?", "Every line comes off it. Nothing was paid, so nothing is refunded.") { sheet = null }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 60.dp) { sheet = null }
                VBtn("Clear the sale", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800) { sheet = null; vm.clear() }
            }
        }
    }
}

// ---------------------------------------------------------------- the sale

@Composable
private fun Sale(
    ui: SaleUi, parked: Int, vm: RetailViewModel,
    onParked: () -> Unit, onCustomer: () -> Unit, onDiscount: () -> Unit, onClear: () -> Unit, onNote: (SaleLine) -> Unit, onPay: () -> Unit,
) {
    Column(Modifier.width(440.dp).fillMaxHeight().clip(RoundedCornerShape(20.dp)).background(V.Panel)) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 10.dp, top = 12.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            T("Sale", 18.sp, 800)
            if (parked > 0) {
                Box(Modifier.height(30.dp).press { onParked() }.clip(RoundedCornerShape(15.dp)).background(V.AmberWash).padding(horizontal = 11.dp), contentAlignment = Alignment.Center) {
                    T("$parked parked", 12.sp, 700, V.AmberText)
                }
            }
            Gap()
            Box(Modifier.height(44.dp).widthIn(max = 190.dp).press { onCustomer() }.clip(RoundedCornerShape(22.dp)).background(if (ui.customer != null) V.Key else Color.Transparent).padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                T(ui.customer ?: "Add customer", 14.sp, if (ui.customer != null) 700 else 600, if (ui.customer != null) V.Text else V.Text2)
            }
            if (!ui.empty) IconKey(VI.Trash, bg = Color.Transparent, tint = V.Text3, onClick = onClear)
        }

        if (ui.empty) {
            Column(Modifier.weight(1f).fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
                T("Scan a product to start", 16.sp, 700)
                T("or tap one on the right", 14.sp, 500, V.Text2)
            }
        } else {
            LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                items(ui.lines, key = { it.line.id }) { l -> Line(l, ui.open == l.line.id, vm, onNote) }
            }
        }

        Column(Modifier.fillMaxWidth().background(V.PanelFoot).padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Small(L.subtotal, Money.format(ui.listed))
                if (ui.off != 0L) Small("Discounts" + (ui.discount?.let { " · ${it.name}" } ?: ""), Money.format(-ui.off))
                if (ui.totals.tax != 0L) Small(if (ui.taxOnTop == 0L) "VAT, included" else "VAT", Money.format(ui.totals.tax))
                if (ui.totals.rounding != 0L) Small("Rounding", Money.format(ui.totals.rounding))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Park sale", Modifier.weight(1f), height = 48.dp, radius = 14.dp, fg = if (ui.empty) V.Off else V.Text) { vm.park() }
                VBtn(if (ui.discount != null) "Discount · ${ui.discount.name}" else "Discount on sale", Modifier.weight(1f), height = 48.dp, radius = 14.dp, fg = if (ui.empty) V.Off else V.Text, onClick = onDiscount)
            }
            Row(
                Modifier.fillMaxWidth().height(64.dp).press { if (vm.mayPay()) onPay() }.clip(RoundedCornerShape(16.dp)).background(if (ui.empty) V.GreenOff else V.Green).padding(horizontal = 22.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                T(L.pay, 19.sp, 800, if (ui.empty) V.GreenOffText else V.GreenInk)
                Gap()
                T(Money.format(ui.totals.total), 19.sp, 800, if (ui.empty) V.GreenOffText else V.GreenInk)
            }
        }
    }
}

@Composable
private fun Small(label: String, value: String) {
    Row(Modifier.fillMaxWidth()) {
        T(label, 14.sp, 500, V.Text2, Modifier.weight(1f))
        T(value, 14.sp, 600, V.Text2)
    }
}

// One line: what it is, how many, what it comes to. Tapped, it shows the
// keys for what can be done to it.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Line(l: SaleLine, open: Boolean, vm: RetailViewModel, onNote: (SaleLine) -> Unit) {
    val line = l.line
    Column(Modifier.fillMaxWidth().background(if (open) V.RowOn else Color.Transparent)) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f).clickable { vm.toggle(line.id) }, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                T(l.name, 15.sp, 700, lines = 2, height = 19.sp)
                T(LinePrice.sub(l.variant, line.list_price, line.unit_price, line.price_label, l.weighed) { Money.format(it) }, 13.sp, 500, V.Text2, lines = 2, height = 17.sp)
                line.note?.takeIf { it.isNotBlank() }?.let { T("“$it”", 13.sp, 500, V.Text3, lines = 2, height = 17.sp) }
            }
            if (l.weighed) {
                // what is weighed has a weight, not a count: tap to weigh it again
                Box(Modifier.height(48.dp).press { vm.askQty(l) }.clip(RoundedCornerShape(14.dp)).background(V.Well).padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                    T(LinePrice.qty(line.qty, true), 15.sp, 800)
                }
            } else {
                Row(Modifier.clip(RoundedCornerShape(14.dp)).background(V.Well).padding(2.dp), verticalAlignment = Alignment.CenterVertically) {
                    StepKey("−") { vm.bump(l, -1) }
                    Box(Modifier.widthIn(min = 40.dp).height(44.dp).clickable { vm.askQty(l) }.padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
                        T(LinePrice.qty(line.qty, false), 16.sp, 800)
                    }
                    StepKey("+") { vm.bump(l, 1) }
                }
            }
            Column(Modifier.width(104.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T(Money.format(l.amount), 15.sp, 800)
                l.was?.let { T(Money.format(it), 12.sp, 500, V.Text2, strike = true) }
            }
        }
        if (open) {
            FlowRow(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val label = line.price_label.takeIf { line.price_kind == "discount" }
                LineKey("No discount", line.price_kind == null) { vm.noDiscount(l) }
                listOf(10, 20).forEach { pct -> LineKey("$pct% off", label == "$pct% off") { vm.percentOff(l, pct) } }
                LineKey(if (label != null && label != "10% off" && label != "20% off") label else "Other %", label != null && label != "10% off" && label != "20% off" && label.endsWith("% off")) { vm.askPercent(l) }
                LineKey("Rs off", label != null && !label.endsWith("% off")) { vm.askAmountOff(l) }
                LineKey("Change price", line.price_kind == "override", plain = true) { vm.askPrice(l) }
                LineKey(if (line.note.isNullOrBlank()) "Note" else "Change note", false, plain = true) { onNote(l) }
                Box(Modifier.height(44.dp).press { vm.remove(line.id) }.clip(RoundedCornerShape(22.dp)).background(V.RedWash).padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                    T(L.remove, 14.sp, 700, V.RedText)
                }
            }
        }
    }
}

@Composable
private fun StepKey(sign: String, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).press(0.92f, onClick).clip(RoundedCornerShape(12.dp)).background(V.Key), contentAlignment = Alignment.Center) { T(sign, 20.sp, 700) }
}

@Composable
private fun LineKey(label: String, on: Boolean, plain: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.height(44.dp).press(onClick = onClick).clip(RoundedCornerShape(22.dp)).background(if (on) V.On else if (plain) Color.Transparent else V.Key)
            .then(if (plain && !on) Modifier.border(1.dp, V.Stroke2, RoundedCornerShape(22.dp)) else Modifier).padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) { T(label, 14.sp, 700, if (on) V.OnText else V.Text) }
}

// ---------------------------------------------------------------- the products

@Composable
private fun Products(vm: RetailViewModel, modifier: Modifier) {
    val cats by vm.cats.collectAsState()
    val cat by vm.cat.collectAsState()
    val q by vm.query.collectAsState()
    val items by vm.products.collectAsState()
    val left by vm.left.collectAsState()
    val variants by vm.variantCounts.collectAsState()
    val byId = remember(cats) { cats.associateBy { it.id } }
    val searching = q.isNotBlank()

    Column(modifier.fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Box {
            Field(
                q, { vm.query.value = it.take(60) }, "Scan, or search a name, SKU or barcode", Modifier.fillMaxWidth(), height = 56.dp, bg = V.Panel, size = 16.sp,
                leading = { VIcon(BARS, 22.dp, V.BlueText) }, onDone = { vm.enter() },
            )
            if (searching) {
                Box(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp)) { IconKey(VI.Close, size = 40.dp, onClick = { vm.query.value = "" }) }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CatKey("All", !searching && cat == null) { vm.pickCat(null) }
            cats.forEach { c -> CatKey(c.name, !searching && cat == c.id) { vm.pickCat(c.id) } }
        }
        LazyVerticalGrid(GridCells.Adaptive(176.dp), Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (items.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                T(
                    if (searching) "Nothing matches “${q.trim()}”. A scanned code that no product carries adds nothing." else "No products here yet. They are added in the back office, under Products.",
                    15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3,
                )
            }
            items(items, key = { it.id }) { i -> Tile(i, byId[i.category_id], left[i.id]?.qty, variants[i.id] ?: 0) { vm.tap(i) } }
        }
    }
}

@Composable
private fun CatKey(label: String, on: Boolean, onClick: () -> Unit) {
    Box(Modifier.height(44.dp).press(onClick = onClick).clip(RoundedCornerShape(22.dp)).background(if (on) V.On else V.Panel).padding(horizontal = 18.dp), contentAlignment = Alignment.Center) {
        T(label, 14.sp, 700, if (on) V.OnText else V.Text2)
    }
}

// A product: its category, its name, its price, and what is left of it.
// "Not stocked" is a product whose stock nobody counts (a service, a bag).
@Composable
private fun Tile(i: ItemEntity, cat: CategoryEntity?, left: Long?, variants: Int, onClick: () -> Unit) {
    val counted = i.track_stock || cat?.is_stock == true
    val weighed = i.sold_by == "weight"
    val qty = left ?: 0L
    val (note, tone) = when {
        !i.is_available -> "Not on sale" to V.Text3
        variants > 0 -> (if (counted) "$variants variants, ${LinePrice.left(qty, weighed).lowercase()}" else "$variants variants") to V.Text2
        !counted -> "Not stocked" to V.Text2
        else -> LinePrice.left(qty, weighed) to when (LinePrice.stock(qty)) { LinePrice.Stock.Plenty -> V.Text2; LinePrice.Stock.Few -> V.AmberText; LinePrice.Stock.None -> V.RedText }
    }
    Column(
        Modifier.height(118.dp).press(0.97f, onClick).clip(RoundedCornerShape(18.dp)).background(V.Panel).padding(14.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            T(cat?.name ?: "", 12.sp, 600, V.Text2)
            T(i.name, 15.sp, 700, if (i.is_available) V.Text else V.Text3, lines = 2, height = 19.sp)
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            T(Money.format(i.price) + if (weighed) " /kg" else "", 16.sp, 800, if (i.is_available) V.Text else V.Text3)
            Gap()
            T(note, 12.sp, 700, tone, align = TextAlign.End, lines = 2, height = 15.sp)
        }
    }
}

// ---------------------------------------------------------------- the sheets

// Which one: its options as keys, the last of them with what is left of each.
// A product whose variants say nothing about options is a plain list.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun VariantSheet(p: VariantPick, vm: RetailViewModel) {
    val k = p.options.size
    val plain = k == 0 || p.variants.any { (p.values[it.id]?.size ?: 0) != k }
    // it opens on the first variant that has stock, else the first
    val first = remember(p) { p.variants.firstOrNull { (p.left[it.id] ?: 0) > 0 } ?: p.variants.first() }
    var chosen by remember(p) { mutableStateOf(first.id) }
    val picked = p.variants.firstOrNull { it.id == chosen } ?: first
    val sel = p.values[picked.id].orEmpty()
    val leftOf = { id: String -> (p.left[id] ?: 0).toLong() }
    val tone = { n: Long, on: Boolean -> if (on) V.OnSub else when (LinePrice.stock(n)) { LinePrice.Stock.Plenty -> V.Text2; LinePrice.Stock.Few -> V.AmberText; LinePrice.Stock.None -> V.RedText } }

    Sheet(onDismiss = { vm.closePicker() }, width = 560.dp, pad = 24.dp, gap = 18.dp) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            T(p.item.name, 22.sp, 800, modifier = Modifier.weight(1f), lines = 2)
            T(Money.format(picked.price), 18.sp, 800)
        }
        if (plain) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                p.variants.forEach { v ->
                    val on = v.id == chosen
                    Column(
                        Modifier.height(68.dp).widthIn(min = 120.dp).press { chosen = v.id }.clip(RoundedCornerShape(14.dp)).background(if (on) V.On else V.Key).padding(horizontal = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        T(v.name, 16.sp, 800, if (on) V.OnText else V.Text)
                        if (p.counted) T(LinePrice.left(leftOf(v.id), false), 12.sp, 700, tone(leftOf(v.id), on))
                    }
                }
            }
        } else {
            p.options.forEachIndexed { i, option ->
                val values = p.variants.mapNotNull { p.values[it.id]?.getOrNull(i) }.distinct()
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    T(option, 14.sp, 600, V.Text2)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        values.forEach { value ->
                            // the variant this key leads to: this value with the others as they are, else the first that has this value
                            val want = sel.toMutableList().also { if (i < it.size) it[i] = value }
                            val to = p.variants.firstOrNull { p.values[it.id] == want } ?: p.variants.firstOrNull { p.values[it.id]?.getOrNull(i) == value }
                            val on = sel.getOrNull(i) == value
                            val last = i == k - 1
                            val exact = p.variants.firstOrNull { p.values[it.id] == want }
                            Column(
                                Modifier.height(if (last && p.counted) 68.dp else 52.dp).widthIn(min = if (last) 92.dp else 0.dp)
                                    .press { to?.let { chosen = it.id } }.clip(RoundedCornerShape(14.dp)).background(if (on) V.On else V.Key).padding(horizontal = 22.dp),
                                verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally,
                            ) {
                                T(value, if (last) 17.sp else 15.sp, if (last) 800 else 700, if (on) V.OnText else if (exact == null) V.Text3 else V.Text)
                                // what is left of this one, with the other options as picked
                                if (last && p.counted) {
                                    if (exact == null) T("None", 12.sp, 700, V.Text3)
                                    else T(LinePrice.left(leftOf(exact.id), false), 12.sp, 700, tone(leftOf(exact.id), on))
                                }
                            }
                        }
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Cancel", Modifier.weight(1f), height = 56.dp, radius = 16.dp, size = 16.sp) { vm.closePicker() }
            val out = p.counted && leftOf(picked.id) <= 0
            VBtn("Add ${picked.name}" + if (out) " (shows out, still sells)" else "", Modifier.weight(2f), V.Green, V.GreenInk, 56.dp, 16.dp, 16.sp, 800) { vm.pick(p.item, picked) }
        }
    }
}

// A number typed on the till's own keys: how many, how heavy, a price, a discount.
@Composable
internal fun NumSheet(a: NumAsk, onDismiss: () -> Unit) {
    var typed by remember(a) { mutableStateOf(a.start) }
    fun press(key: String) {
        typed = when (key) {
            "C" -> ""
            "⌫" -> typed.dropLast(1)
            "." -> if (a.decimals == 0 || typed.contains('.')) typed else if (typed.isEmpty()) "0." else "$typed."
            else -> {
                val whole = typed.substringBefore('.')
                val frac = typed.substringAfter('.', "")
                when {
                    typed.contains('.') && frac.length >= a.decimals -> typed
                    !typed.contains('.') && whole.length >= 7 -> typed
                    typed == "0" -> key
                    else -> typed + key
                }
            }
        }
    }
    Sheet(onDismiss = onDismiss, width = 420.dp, pad = 22.dp, gap = 14.dp) {
        SheetHead(a.title, a.sub, onDismiss)
        Row(Modifier.fillMaxWidth().height(64.dp).clip(RoundedCornerShape(14.dp)).background(V.Well).padding(horizontal = 18.dp), verticalAlignment = Alignment.CenterVertically) {
            if (a.unit == "Rs") T("Rs", 18.sp, 700, V.Text2)
            Gap()
            T(typed.ifEmpty { "0" }, 30.sp, 800, if (typed.isEmpty()) V.Text3 else V.Text)
            if (a.unit.isNotEmpty() && a.unit != "Rs") { Spacer(Modifier.width(8.dp)); T(a.unit, 18.sp, 700, V.Text2) }
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(listOf("7", "8", "9"), listOf("4", "5", "6"), listOf("1", "2", "3"), listOf(if (a.decimals > 0) "." else "C", "0", "⌫")).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { key ->
                        Box(Modifier.weight(1f).height(60.dp).press(0.95f) { press(key) }.clip(RoundedCornerShape(14.dp)).background(V.Key), contentAlignment = Alignment.Center) {
                            T(key, 22.sp, 700, if (key == "C") V.RedText else V.Text)
                        }
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Cancel", Modifier.weight(1f), height = 56.dp, radius = 16.dp) { onDismiss() }
            VBtn("Done", Modifier.weight(2f), V.Green, V.GreenInk, 56.dp, 16.dp, 16.sp, 800) { val out = typed; onDismiss(); a.done(out) }
        }
    }
}

@Composable
private fun NoteSheet(l: SaleLine, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var note by remember(l) { mutableStateOf(l.line.note ?: "") }
    Sheet(onDismiss = onDismiss, width = 520.dp, top = true) {
        SheetHead("Note on this line", l.name + (l.variant?.let { ", $it" } ?: ""), onDismiss)
        Field(note, { note = it.take(120) }, "Gift wrapped, engraving, a serial number…", Modifier.fillMaxWidth(), height = 56.dp, onDone = { onSave(note) })
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (!l.line.note.isNullOrBlank()) VBtn("Take the note off", Modifier.weight(1f), V.RedWash, V.RedText, 56.dp) { onSave("") }
            VBtn("Save", Modifier.weight(1f), V.Green, V.GreenInk, 56.dp, weight = 800) { onSave(note) }
        }
    }
}

class ParkedRow(val id: String, val no: String, val lines: Int, val due: Long, val since: Long)

// The sales set aside. Tapping one brings it back; the sale on screen, if it
// holds anything, is parked in its place.
@Composable
private fun ParkedSheet(rows: List<ParkedRow>, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    Sheet(onDismiss = onDismiss, width = 560.dp) {
        SheetHead("Parked sales", "Tap one to bring it back. The sale on the screen is parked in its place.", onDismiss)
        if (rows.isEmpty()) T("Nothing is parked.", 15.sp, 600, V.Text2)
        rows.forEach { r ->
            Row(
                Modifier.fillMaxWidth().height(64.dp).press { onPick(r.id) }.clip(RoundedCornerShape(14.dp)).background(V.Key).padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(r.no, 16.sp, 800)
                    T("${r.lines} ${if (r.lines == 1) "line" else "lines"} · parked at ${HM.format(Date(r.since))}", 13.sp, 500, V.Text2)
                }
                T(Money.format(r.due), 16.sp, 800)
                VIcon(VI.Chevron, 18.dp, V.Text3)
            }
        }
    }
}

// A discount on the whole sale: one of the back office's, or one typed.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DiscountSheet(ui: SaleUi, vm: RetailViewModel, onDismiss: () -> Unit) {
    var discounts by remember { mutableStateOf<List<DiscountEntity>>(emptyList()) }
    LaunchedEffect(Unit) { discounts = vm.discounts() }
    Sheet(onDismiss = onDismiss, width = 620.dp) {
        SheetHead("Discount on the sale", "Taken off every line in proportion when the sale is paid. A discount on one line is on the line itself.", onDismiss)
        if (discounts.isNotEmpty()) {
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
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(5, 10, 15, 20).forEach { pct ->
                val on = ui.discount?.discountId == null && ui.discount?.type == "percent" && ui.discount.value == pct.toLong()
                VBtn("$pct%", Modifier.weight(1f), if (on) V.On else V.Key, if (on) V.OnText else V.Text, 54.dp) { vm.setDiscount(DiscountPick(null, "percent", pct.toLong(), "$pct%")); onDismiss() }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            VBtn("Another percentage", Modifier.weight(1f), height = 54.dp) { onDismiss(); vm.askSaleDiscount(percent = true) }
            VBtn("Rupees off", Modifier.weight(1f), height = 54.dp) { onDismiss(); vm.askSaleDiscount(percent = false) }
        }
        if (ui.discount != null) VBtn("Take the discount off", Modifier.fillMaxWidth(), V.RedWash, V.RedText) { vm.setDiscount(null); onDismiss() }
    }
}

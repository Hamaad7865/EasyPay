package com.restopos.feature.retail

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.data.Found
import com.restopos.core.data.LabelList
import com.restopos.core.data.RetailSales
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemLeft
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.LabelJob
import com.restopos.core.print.LabelLayout
import com.restopos.core.print.LabelPaint
import com.restopos.core.print.LabelPrinter
import com.restopos.core.print.LabelTemplate
import com.restopos.core.print.LabelTemplates
import com.restopos.core.print.LabelWords
import com.restopos.core.print.Printing
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.ScanKey
import com.restopos.core.ui.ScanPill
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.press
import com.restopos.core.ui.quietTap
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

// One line of a run of labels: a product, or one variant of it, and how many.
class LabelRow(val key: String, val item: ItemEntity, val variant: ItemVariantEntity?, val copies: Int)

// A product that comes in variants, tapped: which of them get a label.
class LabelPick(val item: ItemEntity, val variants: List<ItemVariantEntity>)

// The label as it will print, for the screen: the picture itself, and why it
// carries no bars when it should.
class LabelPreview(val picture: Bitmap, val noBars: String?)

private const val BARS = "M4 6v12M8 6v12M11 6v12M15 6v12M18 6v12M20 6v12"

// Behind Print labels, a shop's: the products to pick from, the run being
// put together (LabelList holds its limits), the ready-made label in use and
// the picture of it, and the printing. A label's price and code are read
// again from the tablet when the screen opens and when the run is printed,
// so a price changed since a line was added prints as it is now.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class LabelsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val sales: RetailSales,
    private val printing: Printing,
) : ViewModel() {
    private val store = flow { emit(session.storeId()) }
    val cats: StateFlow<List<CategoryEntity>> = db.catalog().categories().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val cat = MutableStateFlow<String?>(null)
    val query = MutableStateFlow("")
    val products: StateFlow<List<ItemEntity>> = combine(cat, query) { c, q -> (if (q.isBlank()) c else null) to q.trim() }
        .distinctUntilChanged()
        .flatMapLatest { (c, q) -> db.retail().products(c, q) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val left: StateFlow<Map<String, ItemLeft>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else db.retail().leftByItem(s) }
        .map { rows -> rows.associateBy { it.item_id } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())
    val variantCounts: StateFlow<Map<String, Int>> = db.retail().variantCounts().map { rows -> rows.associate { it.item_id to it.n } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())
    val scanMode: StateFlow<Boolean> = session.scanMode.stateIn(viewModelScope, SharingStarted.Eagerly, false)
    fun setScanMode(on: Boolean) = viewModelScope.launch { session.setScanMode(on); if (on) query.value = "" }
    fun pickCat(id: String?) { cat.value = id; query.value = "" }

    private val _rows = MutableStateFlow<List<LabelRow>>(emptyList())
    val rows: StateFlow<List<LabelRow>> = _rows
    val selected = MutableStateFlow<String?>(null)
    val picking = MutableStateFlow<LabelPick?>(null)
    val asking = MutableStateFlow<NumAsk?>(null)
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    val template: StateFlow<LabelTemplate> = session.labelTemplate.map { LabelTemplates.byId(it) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, LabelTemplates.byId(null))
    val printer: StateFlow<LabelPrinter?> = session.labelPrinter.stateIn(viewModelScope, SharingStarted.Eagerly, null)
    fun setTemplate(id: String) = viewModelScope.launch { session.setLabelTemplate(id) }

    private val shop = MutableStateFlow("")
    init { viewModelScope.launch { shop.value = runCatching { printing.shop().name }.getOrDefault("") } }

    // ---- the label's words ----
    fun words(r: LabelRow): LabelWords {
        val i = r.item
        val v = r.variant
        return LabelWords(
            shop = shop.value,
            name = i.name,
            variant = v?.name.orEmpty(),
            // a price typed at the sale is not a price to put on a label
            price = if (i.open_price) "" else Money.format(v?.price ?: i.price) + if (i.sold_by == "weight") " /kg" else "",
            code = if (v != null) LabelList.code(v.barcode, v.sku) else LabelList.code(i.barcode, i.sku),
        )
    }
    // what the label looks like before anything is on the list
    private fun sample() = LabelWords(shop.value.ifBlank { "Shop name" }, "Product name", "Variant", Money.format(12500), "2000000000008")
    private fun dots(): Int = printer.value?.dots ?: 203

    // The picture of the line that is selected, else of the first, else of a
    // sample; drawn off the main thread, at the dots it will print at.
    val preview: StateFlow<LabelPreview?> = combine(_rows, selected, template, printer, shop) { rows, sel, t, p, _ ->
        val of = rows.firstOrNull { it.key == sel } ?: rows.firstOrNull()
        val placed = LabelLayout.place(t, of?.let { words(it) } ?: sample(), p?.dots ?: 203)
        LabelPreview(LabelPaint.bitmap(placed), if (of == null) null else placed.noBars)
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    // Why each line that should have bars on this label will not, by its key.
    val notes: StateFlow<Map<String, String>> = combine(_rows, template, printer, shop) { rows, t, p, _ ->
        rows.mapNotNull { r -> LabelLayout.place(t, words(r), p?.dots ?: 203).noBars?.let { r.key to it } }.toMap()
    }.flowOn(Dispatchers.Default).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    // one of the ready-made labels with the selected line's words, for picking among them
    fun picture(t: LabelTemplate): Bitmap {
        val of = _rows.value.firstOrNull { it.key == selected.value } ?: _rows.value.firstOrNull()
        return LabelPaint.bitmap(LabelLayout.place(t, of?.let { words(it) } ?: sample(), dots()))
    }

    // ---- the run ----
    private fun keyOf(item: ItemEntity, variant: ItemVariantEntity?) = item.id + ":" + (variant?.id ?: "")
    private fun list() = _rows.value.map { LabelList.Row(it.key, it.copies) }
    private fun put(next: List<LabelList.Row>, fresh: LabelRow? = null) {
        val by = _rows.value.associateBy { it.key }
        _rows.value = next.mapNotNull { r -> (by[r.key] ?: fresh?.takeIf { it.key == r.key })?.let { LabelRow(r.key, it.item, it.variant, r.copies) } }
    }
    private fun add(item: ItemEntity, variant: ItemVariantEntity?, by: Int = 1): Boolean {
        val key = keyOf(item, variant)
        val was = list()
        val next = LabelList.add(was, key, by)
        if (next === was) {
            Toaster.say(
                if (LabelList.total(was) >= LabelList.MOST_RUN) "One run prints ${LabelList.MOST_RUN} labels. Print these, then go on."
                else "One run prints ${LabelList.MOST_EACH} labels of one product.",
            )
            return false
        }
        put(next, LabelRow(key, item, variant, 0))
        selected.value = key
        return true
    }

    // A tile was tapped: one more label of it. A product with variants asks which.
    fun tap(item: ItemEntity) = viewModelScope.launch {
        val variants = db.retail().variantsOf(item.id)
        if (variants.isNotEmpty()) picking.value = LabelPick(item, variants) else add(item, null)
    }
    fun closePicker() { picking.value = null }
    fun pick(item: ItemEntity, chosen: List<ItemVariantEntity>) {
        picking.value = null
        for (v in chosen) if (!add(item, v)) break
    }

    // A barcode read by the scanner: one more label of what carries it.
    fun scanned(code: String) = viewModelScope.launch {
        query.value = ""
        when (val f = sales.find(code)) {
            is Found.Product -> if (add(f.item, f.variant)) Scanner.say(true, "Label · ${sales.nameOf(f.item, f.variant)}")
            is Found.Pick -> { tap(f.item); Scanner.say(true, "Pick which · ${f.item.name}") }
            is Found.Several -> { Toaster.say("Two products carry the code ${f.code}. Find it by its name."); Scanner.say(false, "Two products carry ${f.code}") }
            is Found.Nothing -> { Toaster.say("No product has the code ${f.code}. Nothing was added."); Scanner.say(false, "No match · ${f.code}") }
        }
    }
    // Enter in the search box: a whole code adds its product; anything else stays a search.
    fun enter() = viewModelScope.launch {
        val q = query.value.trim()
        if (q.isEmpty()) return@launch
        when (val f = sales.find(q)) {
            is Found.Product -> { query.value = ""; add(f.item, f.variant) }
            is Found.Pick -> { query.value = ""; tap(f.item) }
            else -> products.value.singleOrNull()?.let { query.value = ""; tap(it) }
        }
    }

    fun more(r: LabelRow) { add(r.item, r.variant) }
    fun fewer(r: LabelRow) = put(LabelList.set(list(), r.key, r.copies - 1))
    fun remove(key: String) = put(LabelList.set(list(), key, 0))
    fun clear() { _rows.value = emptyList(); selected.value = null }
    fun askCopies(r: LabelRow) {
        asking.value = NumAsk("How many labels?", sales.nameOf(r.item, r.variant), "", 0, "") { typed ->
            val n = typed.toIntOrNull() ?: return@NumAsk
            val next = LabelList.set(list(), r.key, n)
            put(next)
            val now = next.firstOrNull { it.key == r.key }?.copies ?: 0
            if (now < n) Toaster.say("One run prints ${LabelList.MOST_EACH} labels of one product, ${LabelList.MOST_RUN} in all: $now it is.")
        }
    }
    fun closeAsk() { asking.value = null }

    // Every line read again from the tablet: a price, a name or a code changed
    // since it was added is as it is now, and a product removed since is gone.
    suspend fun refresh() {
        _rows.value = _rows.value.mapNotNull { r ->
            val item = db.catalog().item(r.item.id)?.takeIf { it.deleted_at == null } ?: return@mapNotNull null
            val variant = if (r.variant == null) null else db.retail().variant(r.variant.id)?.takeIf { it.deleted_at == null } ?: return@mapNotNull null
            LabelRow(r.key, item, variant, r.copies)
        }
        shop.value = runCatching { printing.shop().name }.getOrDefault(shop.value)
    }

    // The run goes to the label printer and the screen waits for it. Sent,
    // the list is emptied; not sent, it stays and the reason is said, so that
    // Print can be pressed again once the printer is put right.
    fun print() = viewModelScope.launch {
        val p = printer.value ?: return@launch
        if (_busy.value) return@launch
        _busy.value = true
        refresh()
        val run = _rows.value
        val t = template.value
        val n = run.sumOf { it.copies }
        if (n == 0) { _busy.value = false; return@launch }
        val labels = withContext(Dispatchers.Default) {
            run.map { r -> LabelJob.Label(LabelPaint.raster(LabelLayout.place(t, words(r), p.dots)), r.copies) }
        }
        val out = LabelJob.bytes(p, labels, t).fold({ printing.sendLabels(p, it, "Labels ($n)") }, { Result.failure(it) })
        _busy.value = false
        out.fold(
            { clear(); Toaster.say("$n ${if (n == 1) "label" else "labels"} sent to ${p.name}.") },
            { Toaster.say(it.message ?: "The labels could not be sent.") },
        )
    }
}

// Print labels: on the left the run and the label it prints on, on the right
// the products to tap or scan onto it.
@Composable
fun LabelsScreen(vm: LabelsViewModel) {
    val printers: LabelPrinterViewModel = hiltViewModel()
    val picking by vm.picking.collectAsState()
    val asking by vm.asking.collectAsState()
    var sheet by remember { mutableStateOf<String?>(null) } // label | printer | clear
    LaunchedEffect(Unit) { vm.refresh(); printers.check() }
    // while this screen is open, a scanned barcode is one more label of its product
    LaunchedEffect(Unit) { Scanner.codes.collect { vm.scanned(it) } }

    Row(Modifier.fillMaxSize().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Run(vm, printers, onLabel = { sheet = "label" }, onPrinter = { sheet = "printer" }, onClear = { sheet = "clear" })
        Products(vm, Modifier.weight(1f))
    }

    picking?.let { WhichSheet(it, vm) }
    asking?.let { NumSheet(it) { vm.closeAsk() } }
    when (sheet) {
        "label" -> TemplateSheet(vm) { sheet = null }
        "printer" -> LabelPrinterSheet(printers) { sheet = null; printers.check() }
        "clear" -> Sheet(onDismiss = { sheet = null }, width = 520.dp) {
            SheetHead("Clear the list?", "Every line comes off it. Nothing was printed.") { sheet = null }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 60.dp) { sheet = null }
                VBtn("Clear the list", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800) { sheet = null; vm.clear() }
            }
        }
    }
}

// ---------------------------------------------------------------- the run

@Composable
private fun Run(vm: LabelsViewModel, printers: LabelPrinterViewModel, onLabel: () -> Unit, onPrinter: () -> Unit, onClear: () -> Unit) {
    val rows by vm.rows.collectAsState()
    val selected by vm.selected.collectAsState()
    val notes by vm.notes.collectAsState()
    val template by vm.template.collectAsState()
    val preview by vm.preview.collectAsState()
    val printer by vm.printer.collectAsState()
    val there by printers.there.collectAsState()
    val busy by vm.busy.collectAsState()
    val total = rows.sumOf { it.copies }
    val shown = rows.firstOrNull { it.key == selected } ?: rows.firstOrNull()

    Column(Modifier.width(430.dp).fillMaxHeight().clip(RoundedCornerShape(20.dp)).background(V.Panel).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.height(44.dp), verticalAlignment = Alignment.CenterVertically) {
            T("Print labels", 20.sp, 800, spacing = (-0.3).sp)
            Gap()
            if (rows.isNotEmpty()) IconKey(VI.Trash, onClick = onClear)
        }
        if (rows.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                T("Tap a product on the right, or scan it.\nEach tap is one more label of it.", 15.sp, 500, V.Text2, lines = 3, align = androidx.compose.ui.text.style.TextAlign.Center, height = 22.sp)
            }
        } else {
            // a line just added, or tapped, is brought into view: the list is short and a run can be long
            val list = rememberLazyListState()
            LaunchedEffect(shown?.key, rows.size) {
                val at = rows.indexOfFirst { it.key == shown?.key }
                if (at >= 0) list.animateScrollToItem(at)
            }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), list, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(rows, key = { it.key }) { r -> RunLine(r, r.key == shown?.key, notes[r.key], vm) }
            }
        }
        // the label in use, drawn as it will print: tap it to pick another
        Row(
            Modifier.fillMaxWidth().press(0.99f, onLabel).clip(RoundedCornerShape(16.dp)).background(V.Well).padding(12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Picture(preview?.picture, template, Modifier.width(170.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Caps("Label")
                T("${template.size} mm", 17.sp, 800)
                T(template.name, 13.sp, 500, V.Text2, lines = 2, height = 17.sp)
                T("Tap to pick another", 12.sp, 600, V.BlueText)
            }
        }
        val p = printer
        if (p == null) {
            T("No label printer is set up on this tablet yet.", 13.sp, 500, V.Text2, lines = 2)
            VBtn("Set up the label printer", Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, 16.dp, 16.sp, 800, onClick = onPrinter)
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f).quietTap(onPrinter), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T(if (total == 1) "1 label" else "$total labels", 18.sp, 800)
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(when (there) { true -> V.Ok; false -> V.Red; else -> V.Text3 }))
                        T(p.name, 13.sp, 600, V.Text2, Modifier.widthIn(max = 170.dp))
                    }
                }
                VBtn(
                    if (busy) "Printing…" else "Print", Modifier.width(190.dp), if (total > 0) V.Green else V.Key, if (total > 0) V.GreenInk else V.Text3,
                    60.dp, 16.dp, 17.sp, 800, enabled = total > 0 && !busy, icon = VI.Print,
                ) { vm.print() }
            }
        }
    }
}

// One line of the run: what it is, and how many. Tapping it shows its label.
@Composable
private fun RunLine(r: LabelRow, on: Boolean, note: String?, vm: LabelsViewModel) {
    val w = vm.words(r)
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(if (on) V.RowOn else V.Well).quietTap { vm.selected.value = r.key }.padding(start = 14.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(r.item.name + (r.variant?.let { ", ${it.name}" } ?: ""), 15.sp, 700, lines = 2, height = 19.sp)
            T(listOfNotNull(w.price.ifEmpty { null }, w.code).joinToString(" · ").ifEmpty { "No price, no code" }, 12.sp, 500, V.Text2)
            if (note != null) T(note, 12.sp, 600, V.AmberText, lines = 2, height = 15.sp)
        }
        StepKey("−") { vm.fewer(r) }
        Box(Modifier.width(44.dp).height(44.dp).quietTap { vm.askCopies(r) }, contentAlignment = Alignment.Center) { T("${r.copies}", 18.sp, 800) }
        StepKey("+") { vm.more(r) }
        IconKey(VI.Close, size = 36.dp, bg = Color.Transparent, tint = V.Text3, onClick = { vm.remove(r.key) })
    }
}

// A label's picture on white, in the label's own shape, its dots left sharp.
@Composable
private fun Picture(b: Bitmap?, t: LabelTemplate, modifier: Modifier) {
    Box(
        modifier.aspectRatio(t.widthMm / t.heightMm).clip(RoundedCornerShape(6.dp)).background(Color.White).border(1.dp, V.Stroke, RoundedCornerShape(6.dp)),
        contentAlignment = Alignment.Center,
    ) {
        if (b != null) Image(b.asImageBitmap(), contentDescription = "The label as it will print", Modifier.fillMaxSize(), contentScale = ContentScale.Fit, filterQuality = FilterQuality.Medium)
    }
}

// ---------------------------------------------------------------- the products

@Composable
private fun Products(vm: LabelsViewModel, modifier: Modifier) {
    val cats by vm.cats.collectAsState()
    val cat by vm.cat.collectAsState()
    val q by vm.query.collectAsState()
    val items by vm.products.collectAsState()
    val left by vm.left.collectAsState()
    val variants by vm.variantCounts.collectAsState()
    val byId = remember(cats) { cats.associateBy { it.id } }
    val searching = q.isNotBlank()
    val scan by vm.scanMode.collectAsState()

    Column(modifier.fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ScanKey(scan) { vm.setScanMode(it) }
            // scan mode: nothing to type into, so nothing brings the keyboard up
            if (scan) ScanPill(Modifier.weight(1f))
            else Box(Modifier.weight(1f)) {
                Field(
                    q, { vm.query.value = it.take(60) }, "Scan, or search a name, SKU or barcode", Modifier.fillMaxWidth(), height = 56.dp, bg = V.Panel, size = 16.sp,
                    leading = { VIcon(BARS, 22.dp, V.BlueText) }, onDone = { vm.enter() },
                )
                if (searching) {
                    Box(Modifier.align(Alignment.CenterEnd).padding(end = 8.dp)) { IconKey(VI.Close, size = 40.dp, onClick = { vm.query.value = "" }) }
                }
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CatKey("All", !searching && cat == null) { vm.pickCat(null) }
            cats.forEach { c -> CatKey(c.name, !searching && cat == c.id) { vm.pickCat(c.id) } }
        }
        LazyVerticalGrid(GridCells.Adaptive(176.dp), Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (items.isEmpty()) item(span = { GridItemSpan(maxLineSpan) }) {
                T(
                    if (searching) "Nothing matches “${q.trim()}”." else "No products here yet. They are added on Products & stock, or in the back office.",
                    15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3,
                )
            }
            items(items, key = { it.id }) { i -> Tile(i, byId[i.category_id], left[i.id]?.qty, variants[i.id] ?: 0) { vm.tap(i) } }
        }
    }
}

// ---------------------------------------------------------------- the sheets

// A product that comes in variants: which of them get a label. Each is a key
// that is in or out; All of them is one tap for a delivery of every size.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WhichSheet(p: LabelPick, vm: LabelsViewModel) {
    var chosen by remember(p) { mutableStateOf(emptySet<String>()) }
    Sheet(onDismiss = { vm.closePicker() }, width = 600.dp, pad = 24.dp, gap = 18.dp) {
        SheetHead(p.item.name, "Which ones get a label? One of each is added: change how many on the list.") { vm.closePicker() }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            p.variants.forEach { v ->
                val on = v.id in chosen
                Column(
                    Modifier.height(64.dp).widthIn(min = 110.dp).press { chosen = if (on) chosen - v.id else chosen + v.id }.clip(RoundedCornerShape(14.dp)).background(if (on) V.On else V.Key).padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(3.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    T(v.name, 16.sp, 800, if (on) V.OnText else V.Text)
                    T(Money.format(v.price), 12.sp, 700, if (on) V.OnSub else V.Text2)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("All of them", Modifier.weight(1f), height = 56.dp, radius = 16.dp, size = 16.sp) { vm.pick(p.item, p.variants) }
            val n = chosen.size
            VBtn(
                if (n == 0) "Tap the ones to label" else if (n == 1) "Add 1 label" else "Add $n labels", Modifier.weight(2f),
                if (n > 0) V.Green else V.Key, if (n > 0) V.GreenInk else V.Text3, 56.dp, 16.dp, 16.sp, 800, enabled = n > 0,
            ) { vm.pick(p.item, p.variants.filter { it.id in chosen }) }
        }
    }
}

// The ready-made labels, by the size of sticker they are for, each drawn with
// the selected line's own words. The sizes that have one label share a row.
@Composable
private fun TemplateSheet(vm: LabelsViewModel, onDismiss: () -> Unit) {
    val current by vm.template.collectAsState()
    val groups = remember { LabelTemplates.all.groupBy { it.size }.toList() }
    val pick = { t: LabelTemplate -> vm.setTemplate(t.id); onDismiss() }
    Sheet(onDismiss = onDismiss, width = 760.dp, pad = 24.dp, gap = 14.dp) {
        SheetHead("Which label?", "Pick one in the size of the stickers that are in the printer.", onDismiss)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            groups.filter { it.second.size == 1 }.forEach { (size, group) ->
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Caps("$size mm stickers")
                    TemplateCard(group[0], group[0].id == current.id, vm, Modifier.fillMaxWidth(), pick)
                }
            }
        }
        groups.filter { it.second.size > 1 }.forEach { (size, group) ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Caps("$size mm stickers")
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    group.forEach { t -> TemplateCard(t, t.id == current.id, vm, Modifier.weight(1f), pick) }
                }
            }
        }
    }
}

@Composable
private fun TemplateCard(t: LabelTemplate, on: Boolean, vm: LabelsViewModel, modifier: Modifier, onPick: (LabelTemplate) -> Unit) {
    val picture = remember(t.id) { vm.picture(t) }
    Column(
        modifier.press(0.98f) { onPick(t) }.clip(RoundedCornerShape(16.dp)).background(if (on) V.RowOn else V.Well)
            .border(1.5.dp, if (on) V.Green else Color.Transparent, RoundedCornerShape(16.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        // a small sticker is drawn a little larger for its size, so that its words can be read here
        Box(Modifier.height(100.dp).fillMaxWidth(), contentAlignment = Alignment.Center) {
            Picture(picture, t, Modifier.height((t.heightMm * if (t.heightMm < 20f) 4.4f else 3.2f).dp))
        }
        T(t.name, 14.sp, 700, lines = 1)
    }
}

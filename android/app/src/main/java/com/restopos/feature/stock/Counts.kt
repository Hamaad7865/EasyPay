package com.restopos.feature.stock

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Scanner
import com.restopos.core.data.CountBook
import com.restopos.core.data.DocLines
import com.restopos.core.data.RetailSales
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StockRepository
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.StockCountEntity
import com.restopos.core.database.StockCountLineEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.SupplierEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Gap
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.panel
import com.restopos.core.ui.press
import com.restopos.feature.retail.NumAsk
import com.restopos.feature.retail.NumSheet
import com.restopos.feature.retail.ProductPane
import com.restopos.feature.retail.ProductPick
import com.restopos.feature.retail.WhichSheet
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// Something a count can be of, on the sheet that starts one: its words, and how many lines of stock it would count.
class CountChoice(val kind: String, val scopeId: String?, val brand: String?, val label: String, val lines: Int)

// Behind the Counts tab: the shop's counts, and the one this tablet is
// counting. A count is kept on the tablet from its first tap, every figure
// written as it is given (StockRepository, CountBook), and goes nowhere until
// it is completed: an afternoon's counting does not hang on a connection.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class CountsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val sales: RetailSales,
    private val stock: StockRepository,
) : ViewModel() {
    private val store = flow { emit(session.storeId()) }
    private fun <T> kept(of: kotlinx.coroutines.flow.Flow<T>, first: T): StateFlow<T> = of.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), first)

    val counts: StateFlow<List<StockCountEntity>> = kept(store.flatMapLatest { s -> if (s == null) emptyFlow() else db.stock().counts(s) }, emptyList())
    // the count this tablet is counting, if any
    val own: StateFlow<StockCountEntity?> = store.flatMapLatest { s -> if (s == null) flowOf(null) else db.stock().openOwnCountFlow(s) }.stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val lines: StateFlow<List<CountBook.Line>> = own.flatMapLatest { c ->
        if (c == null) flowOf(emptyList()) else db.stock().countLines(c.id).map { rows -> rows.map { CountBook.Line(it.item_id, it.variant_id, it.counted, it.counted_at, it.expected, it.left_out) } }
    }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val items: StateFlow<Map<String, ItemEntity>> = db.stock().everyItem().map { rows -> rows.associateBy { it.id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    val variants: StateFlow<Map<String, ItemVariantEntity>> = db.stock().everyVariant().map { rows -> rows.associateBy { it.id } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    private val levels: StateFlow<Map<CountBook.Stock, StockLevelEntity>> = store.flatMapLatest { s -> if (s == null) emptyFlow() else db.retail().levels(s) }
        .map { rows -> rows.associateBy { CountBook.Stock(it.item_id, it.variant_id) } }.stateIn(viewModelScope, SharingStarted.Eagerly, emptyMap())
    private val suppliers: StateFlow<List<SupplierEntity>> = db.stock().suppliers().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val staffNames: StateFlow<Map<String, String>> = kept(db.stock().staffNames().map { rows -> rows.associate { it.id to it.name } }, emptyMap())

    // the counting screen is open; the sheet that starts a count; the review; the choice for what nobody counted
    val counting = MutableStateFlow(false)
    val starting = MutableStateFlow(false)
    val reviewing = MutableStateFlow(false)
    val uncounted = MutableStateFlow("leave")
    val throwing = MutableStateFlow(false)
    // a line's own sheet: not counted, or left out
    val about = MutableStateFlow<CountBook.Stock?>(null)
    // a finished count opened to look at, and its lines
    val open = MutableStateFlow<String?>(null)
    val record: StateFlow<List<StockCountLineEntity>> = open.flatMapLatest { id -> if (id == null) flowOf(emptyList()) else db.stock().countLines(id) }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val asking = MutableStateFlow<NumAsk?>(null)
    val busy = MutableStateFlow(false)
    val problem = MutableStateFlow<String?>(null)

    val pane = ProductPick(viewModelScope, db, session, sales, said = { i, v -> "Counted · ${sales.nameOf(i, v)}" }, onAdd = { i, v -> tapped(i, v) })

    private fun counted(item: ItemEntity): Boolean = item.track_stock || pane.cats.value.firstOrNull { it.id == item.category_id }?.is_stock == true
    fun name(s: CountBook.Stock): String = items.value[s.item]?.let { sales.nameOf(it, variants.value[s.variant]) } ?: "A product that is no longer there"
    fun weighed(item: String): Boolean = items.value[item]?.sold_by == "weight"
    fun holds(s: CountBook.Stock): Int = levels.value[s]?.qty ?: 0
    fun costOf(s: CountBook.Stock): Double = levels.value[s]?.avg_cost ?: 0.0

    // ---- starting one ----
    // What a count can be of, with how many lines each would count; what would count nothing is not offered.
    fun choices(): List<CountChoice> {
        val all = items.value.values.toList()
        val vars = variants.value.values.toList()
        fun n(kind: String, id: String? = null, brand: String? = null) = CountBook.scope(kind, id, brand, all, ::counted, vars).size
        val out = ArrayList<CountChoice>()
        out += CountChoice("all", null, null, "The whole shop", n("all"))
        pane.cats.value.forEach { c -> out += CountChoice("category", c.id, null, "Category: ${c.name}", n("category", c.id)) }
        suppliers.value.forEach { s -> out += CountChoice("supplier", s.id, null, "Supplier: ${s.name}", n("supplier", s.id)) }
        all.mapNotNull { it.brand?.trim()?.ifEmpty { null } }.distinctBy { it.lowercase() }.sortedBy { it.lowercase() }
            .forEach { b -> out += CountChoice("brand", null, b, "Brand: $b", n("brand", brand = b)) }
        return out.filter { it.lines > 0 }
    }
    fun start(c: CountChoice, approver: StaffMember?) = viewModelScope.launch {
        if (busy.value) return@launch
        busy.value = true
        val out = stock.startCount(c.kind, c.scopeId, c.brand, approver)
        busy.value = false
        out.fold({ starting.value = false; problem.value = null; uncounted.value = "leave"; counting.value = true }, { problem.value = it.message ?: "That did not work. Try again." })
    }

    // ---- counting ----
    private suspend fun tapped(item: ItemEntity, variant: ItemVariantEntity?): Boolean {
        val c = own.value ?: return false
        if (!counted(item)) {
            Toaster.say("${item.name}: its stock is not counted, so it is not in a count. Switch on \"Count its stock\" for it on Products & stock.")
            return false
        }
        stock.counted(c.id, CountBook.Stock(item.id, variant?.id ?: ""), 1000)
        return true
    }
    fun scanned(code: String) { if (counting.value && !reviewing.value && own.value != null) pane.scanned(code) }
    fun askFigure(s: CountBook.Stock) {
        val c = own.value ?: return
        val w = weighed(s.item)
        asking.value = NumAsk(name(s), "How much is on the shelf", if (w) "kg" else "", if (w) 3 else 0, "") { typed ->
            val units = DocLines.typed(typed)
            if (units == null) Toaster.say("That is not a quantity.") else viewModelScope.launch { stock.typed(c.id, s, units) }
        }
    }
    fun closeAsk() { asking.value = null }
    fun notCounted(s: CountBook.Stock) = viewModelScope.launch { own.value?.let { stock.uncount(it.id, s) }; about.value = null }
    fun leaveOut(s: CountBook.Stock, out: Boolean) = viewModelScope.launch { own.value?.let { stock.leaveOut(it.id, s, out) }; about.value = null }
    fun throwAway() = viewModelScope.launch {
        own.value?.let { stock.dropCount(it.id) }
        throwing.value = false; reviewing.value = false; counting.value = false; problem.value = null
        Toaster.say("The count was thrown away. Nothing of the stock changed.")
    }

    // ---- the review ----
    fun rows(): List<CountBook.Row> = CountBook.review(lines.value) { holds(it) }
    // the lines the count would be refused for: a product removed, or no longer counted, since it began
    fun gone(): List<CountBook.Line> = CountBook.gone(lines.value, items.value, ::counted) { item -> variants.value.values.filter { it.item_id == item && it.deleted_at == null } }
    fun leaveOutGone() = viewModelScope.launch {
        val c = own.value ?: return@launch
        gone().forEach { stock.leaveOut(c.id, it.stock, true) }
        problem.value = null
    }
    fun complete(approver: StaffMember?) = viewModelScope.launch {
        val c = own.value ?: return@launch
        if (busy.value) return@launch
        busy.value = true
        val out = stock.completeCount(c.id, uncounted.value, approver)
        busy.value = false
        out.fold(
            { reviewing.value = false; counting.value = false; problem.value = null; Toaster.say("The count is completed: the stock is what was counted.") },
            { problem.value = it.message ?: "That did not work. Try again." },
        )
    }
}

private val WHEN = SimpleDateFormat("d MMM yyyy, HH:mm", Locale.ENGLISH)

// Counts: the list, or the count this tablet is counting.
// approver: who gave their word for this tab. costs: rupees of cost may be shown.
@Composable
fun CountsTab(vm: CountsViewModel, approver: StaffMember?, costs: Boolean) {
    val counting by vm.counting.collectAsState()
    val own by vm.own.collectAsState()
    val asking by vm.asking.collectAsState()
    val picking by vm.pane.picking.collectAsState()
    val open by vm.open.collectAsState()
    // while a count is open on the screen, a scanned barcode is one more of its product
    LaunchedEffect(Unit) { Scanner.codes.collect { vm.scanned(it) } }

    val c = own
    if (counting && c != null) Counting(vm, c, approver, costs) else CountList(vm, approver)

    open?.let { id -> CountRecord(vm, id, costs) }
    picking?.let { WhichSheet(vm.pane, it, "Which ones were counted? One of each is added: type the figure on the list.", none = "Tap the ones counted") { n -> if (n == 1) "Count 1 more" else "Count $n more" } }
    asking?.let { NumSheet(it) { vm.closeAsk() } }
}

@Composable
private fun CountList(vm: CountsViewModel, approver: StaffMember?) {
    val counts by vm.counts.collectAsState()
    val own by vm.own.collectAsState()
    val starting by vm.starting.collectAsState()
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    val staff by vm.staffNames.collectAsState()
    // read so that the sheet's choices follow the products
    val items by vm.items.collectAsState()

    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            T(if (counts.size == 1) "1 count" else "${counts.size} counts", 15.sp, 600, V.Text2)
            Gap()
            if (own != null) VBtn("Carry on counting", bg = V.Blue, fg = Color.White, height = 48.dp, pad = 20.dp) { vm.counting.value = true }
            else VBtn("Start a count", bg = V.Blue, fg = Color.White, height = 48.dp, pad = 20.dp, icon = VI.Plus) { vm.problem.value = null; vm.starting.value = true }
        }
        if (counts.isEmpty()) {
            T("No count yet. A count is of the whole shop, or of one category, supplier or brand: what is on the shelves is counted, and the stock is set to it.", 15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3)
        } else LazyColumn(Modifier.fillMaxWidth().weight(1f).panel(), contentPadding = PaddingValues(vertical = 6.dp)) {
            items(counts, key = { it.id }) { c ->
                val mine = c.id == own?.id
                // an open count that is not this tablet's is being counted somewhere else
                val elsewhere = c.status == "open" && !mine
                Row(
                    Modifier.fillMaxWidth().press(0.99f) { if (mine) vm.counting.value = true else if (!elsewhere) vm.open.value = c.id }.padding(horizontal = 18.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        T("${c.number ?: "On this tablet"} · ${c.title}", 16.sp, 700)
                        T(listOfNotNull(WHEN.format(Date(c.completed_at ?: c.created_at)), (c.completed_by ?: c.started_by)?.let { staff[it] }, if (elsewhere) "open in the back office" else null).joinToString(" · "), 13.sp, 500, V.Text2)
                    }
                    when (c.status) {
                        "open" -> Chip(if (mine) "Being counted" else "Open", V.Amber.copy(alpha = 0.18f), V.AmberText)
                        "completed" -> Chip("Completed", V.Green.copy(alpha = 0.18f), V.GreenText)
                        else -> Chip(c.status.replaceFirstChar { it.uppercase() }, V.Key, V.Text2)
                    }
                }
            }
        }
    }

    if (starting) Sheet(onDismiss = { if (!busy) vm.starting.value = false }, width = 560.dp, gap = 10.dp) {
        SheetHead("What is counted?", "Only products whose stock is counted are in a count.") { if (!busy) vm.starting.value = false }
        val choices = remember(items, starting) { vm.choices() }
        if (choices.isEmpty()) T("No product has its stock counted yet. Switch on \"Count its stock\" for the products to count, on Products & stock.", 15.sp, 500, V.Text2, lines = 3)
        else LazyColumn(Modifier.heightIn(max = 380.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            items(choices, key = { it.kind + (it.scopeId ?: it.brand ?: "") }) { c ->
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Key).press(0.99f) { vm.start(c, approver) }.padding(horizontal = 16.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    T(c.label, 15.sp, 700, modifier = Modifier.weight(1f))
                    T(if (c.lines == 1) "1 line" else "${c.lines} lines", 13.sp, 500, V.Text2)
                }
            }
        }
        problem?.let { T(it, 14.sp, 600, V.Red, lines = 3) }
    }
}

// The count on the screen: on the left what is in it, counted first; on the right the products to tap or scan.
@Composable
private fun Counting(vm: CountsViewModel, c: StockCountEntity, approver: StaffMember?, costs: Boolean) {
    val lines by vm.lines.collectAsState()
    val items by vm.items.collectAsState()
    val reviewing by vm.reviewing.collectAsState()
    val throwing by vm.throwing.collectAsState()
    val about by vm.about.collectAsState()
    val (done, of) = CountBook.progress(lines)
    // counted first, the last counted on top; then what is still to count; what was left out last
    val shown = lines.filter { !it.leftOut && it.counted != null }.sortedByDescending { it.countedAt ?: 0 } +
        lines.filter { !it.leftOut && it.counted == null } + lines.filter { it.leftOut }

    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.width(460.dp).fillMaxHeight().panel().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T("Counting: ${c.title}", 18.sp, 800, spacing = (-0.4).sp)
                    T("$done of $of counted", 14.sp, 600, V.Text2)
                }
                VBtn("Back to the list", height = 40.dp, pad = 14.dp, size = 14.sp) { vm.counting.value = false }
            }
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                items(shown, key = { it.item + "/" + it.variant }) { l ->
                    val counted = l.counted
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Well).padding(start = 12.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(if (items.isEmpty()) "" else vm.name(l.stock), 14.sp, 700, if (l.leftOut) V.Text3 else V.Text, lines = 2, height = 17.sp)
                            T(if (l.leftOut) "Left out of this count" else if (counted == null) "Not counted yet" else "Counted", 12.sp, 500, if (counted != null && !l.leftOut) V.GreenText else V.Text3)
                        }
                        if (!l.leftOut) VBtn(if (counted == null) "Count" else DocLines.shown(counted, vm.weighed(l.item)), height = 44.dp, pad = 14.dp, size = 15.sp, weight = 800, bg = if (counted == null) V.Key else V.On, fg = if (counted == null) V.Text else V.OnText) { vm.askFigure(l.stock) }
                        VBtn("…", height = 44.dp, pad = 14.dp, size = 16.sp) { vm.about.value = l.stock }
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                VBtn("Throw away", Modifier.weight(1f), height = 48.dp, size = 14.sp, fg = V.Red) { vm.throwing.value = true }
                VBtn("Review", Modifier.weight(2f), V.Green, V.GreenInk, 48.dp, weight = 800) { vm.problem.value = null; vm.reviewing.value = true }
            }
        }
        ProductPane(vm.pane, Modifier.weight(1f))
    }

    about?.let { s ->
        val l = lines.firstOrNull { it.item == s.item && it.variant == s.variant }
        Sheet(onDismiss = { vm.about.value = null }, width = 520.dp, gap = 10.dp) {
            SheetHead(vm.name(s)) { vm.about.value = null }
            if (l?.counted != null) VBtn("Not counted after all", Modifier.fillMaxWidth()) { vm.notCounted(s) }
            if (l?.leftOut == true) VBtn("Put it back in the count", Modifier.fillMaxWidth()) { vm.leaveOut(s, false) }
            else VBtn("Leave it out of this count", Modifier.fillMaxWidth()) { vm.leaveOut(s, true) }
            T("What is left out is neither counted nor set to anything: its stock stays as it is.", 13.sp, 500, V.Text3, lines = 2)
        }
    }
    if (throwing) Sheet(onDismiss = { vm.throwing.value = false }, width = 520.dp) {
        SheetHead("Throw this count away?") { vm.throwing.value = false }
        T("Every figure counted so far is forgotten, and nothing of the stock changes.", 15.sp, 500, V.Text2, lines = 3)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Keep counting", Modifier.weight(1f)) { vm.throwing.value = false }
            VBtn("Throw it away", Modifier.weight(1f), V.Red, Color.White, weight = 800) { vm.throwAway() }
        }
    }
    if (reviewing) Review(vm, approver, costs)
}

// The review: what differs, what matches, what nobody counted, and the key that sets the stock to the count.
@Composable
private fun Review(vm: CountsViewModel, approver: StaffMember?, costs: Boolean) {
    val lines by vm.lines.collectAsState()
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    val uncounted by vm.uncounted.collectAsState()
    val rows = remember(lines) { vm.rows() }
    val differ = rows.filter { it.diff != null && it.diff != 0 }
    val match = rows.count { it.diff == 0 }
    val open = rows.count { it.diff == null }
    val (n, over, short) = CountBook.totals(rows)
    val gone = remember(lines) { vm.gone() }

    Sheet(onDismiss = { if (!busy) vm.reviewing.value = false }, width = 720.dp, gap = 10.dp) {
        SheetHead(
            "Review the count",
            if (n == 0) "Nothing differs from what the tablet held." else "$n ${if (n == 1) "line differs" else "lines differ"}: ${DocLines.shown(over)} over, ${DocLines.shown(short)} short.",
        ) { if (!busy) vm.reviewing.value = false }
        if (differ.isNotEmpty()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                Caps("Product", modifier = Modifier.weight(1f))
                Caps("Held", modifier = Modifier.width(80.dp))
                Caps("Counted", modifier = Modifier.width(80.dp))
                Caps("Difference", modifier = Modifier.width(if (costs) 170.dp else 90.dp))
            }
            LazyColumn(Modifier.heightIn(max = 230.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(differ, key = { it.line.item + "/" + it.line.variant }) { r ->
                    val w = vm.weighed(r.line.item)
                    val diff = r.diff ?: 0
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(V.Well).padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                        T(vm.name(r.line.stock), 14.sp, 700, modifier = Modifier.weight(1f), lines = 2)
                        T(DocLines.shown(r.expected, w), 14.sp, 600, V.Text2, Modifier.width(80.dp))
                        T(DocLines.shown(r.line.counted ?: 0, w), 14.sp, 700, modifier = Modifier.width(80.dp))
                        T(
                            (if (diff > 0) "+" else "−") + DocLines.shown(kotlin.math.abs(diff), w) + if (costs) "  " + Money.format(Math.round(diff * vm.costOf(r.line.stock) / 1000.0)) else "",
                            14.sp, 700, if (diff > 0) V.GreenText else V.RedText, Modifier.width(if (costs) 170.dp else 90.dp),
                        )
                    }
                }
            }
        }
        T("$match ${if (match == 1) "line matches" else "lines match"}." + if (open > 0) " $open ${if (open == 1) "line was" else "lines were"} not counted:" else "", 14.sp, 600, V.Text2)
        if (open > 0) Seg(
            listOf(SegOption("Leave them as they are", uncounted == "leave") { vm.uncounted.value = "leave" }, SegOption("Set them to nothing", uncounted == "zero") { vm.uncounted.value = "zero" }),
            fill = true,
        )
        if (gone.isNotEmpty()) {
            T("${gone.size} ${if (gone.size == 1) "line is" else "lines are"} of a product that was removed, or is no longer counted, since the count began: ${gone.take(3).joinToString(", ") { vm.name(it.stock) }}${if (gone.size > 3) " and more" else ""}.", 14.sp, 600, V.AmberText, lines = 3)
            VBtn("Leave these out", Modifier.fillMaxWidth(), height = 44.dp, size = 14.sp, enabled = !busy) { vm.leaveOutGone() }
        }
        problem?.let {
            T(it, 14.sp, 600, V.Red, Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(V.Red.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 8.dp), lines = 4)
        }
        T("Completing sets the stock of every counted line to its figure. What was sold after a line was counted stays sold.", 13.sp, 500, V.Text3, lines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Back to counting", Modifier.weight(1f), enabled = !busy) { vm.reviewing.value = false }
            VBtn(if (busy) "Completing…" else "Complete the count", Modifier.weight(1f), V.Green, V.GreenInk, weight = 800, enabled = !busy) { vm.complete(approver) }
        }
    }
}

// A finished count, to look at: each line as it was written when the count was completed.
@Composable
private fun CountRecord(vm: CountsViewModel, id: String, costs: Boolean) {
    val counts by vm.counts.collectAsState()
    val lines by vm.record.collectAsState()
    val items by vm.items.collectAsState()
    val c = counts.firstOrNull { it.id == id } ?: return
    val shown = lines.filter { !it.left_out }.sortedByDescending { kotlin.math.abs(it.diff ?: 0) }

    Sheet(onDismiss = { vm.open.value = null }, width = 700.dp, gap = 10.dp) {
        SheetHead("${c.number ?: "Count"} · ${c.title}", listOfNotNull(c.completed_at?.let { "completed ${WHEN.format(Date(it))}" }, if (c.uncounted == "zero") "what was not counted was set to nothing" else null).joinToString(" · ")) { vm.open.value = null }
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
            Caps("Product", modifier = Modifier.weight(1f))
            Caps("Held", modifier = Modifier.width(80.dp))
            Caps("Counted", modifier = Modifier.width(80.dp))
            Caps("Difference", modifier = Modifier.width(if (costs) 170.dp else 90.dp))
        }
        LazyColumn(Modifier.heightIn(max = 340.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(shown, key = { it.item_id + "/" + it.variant_id }) { l ->
                val w = vm.weighed(l.item_id)
                val diff = l.diff
                Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(V.Well).padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.CenterVertically) {
                    T(if (items.isEmpty()) "" else vm.name(CountBook.Stock(l.item_id, l.variant_id)), 14.sp, 700, modifier = Modifier.weight(1f), lines = 2)
                    T(l.expected?.let { DocLines.shown(it, w) } ?: "—", 14.sp, 600, V.Text2, Modifier.width(80.dp))
                    T(l.counted?.let { DocLines.shown(it, w) } ?: "not counted", 14.sp, 700, if (l.counted == null) V.Text3 else V.Text, Modifier.width(80.dp))
                    T(
                        when {
                            diff == null || diff == 0 -> "—"
                            else -> (if (diff > 0) "+" else "−") + DocLines.shown(kotlin.math.abs(diff), w) + if (costs && l.unit_cost != null) "  " + Money.format(Math.round(diff * l.unit_cost / 1000.0)) else ""
                        },
                        14.sp, 700, if (diff == null || diff == 0) V.Text3 else if (diff > 0) V.GreenText else V.RedText, Modifier.width(if (costs) 170.dp else 90.dp),
                    )
                }
            }
        }
        VBtn("Done", Modifier.fillMaxWidth()) { vm.open.value = null }
    }
}

package com.restopos.feature.retail

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.PosSettings
import com.restopos.core.data.PromoLine
import com.restopos.core.data.PromotionRules
import com.restopos.core.data.Promotions
import com.restopos.core.data.RetailSales
import com.restopos.core.data.StaffMember
import com.restopos.core.database.TillDatabase
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import javax.inject.Inject

// What the Promotions screen shows: the three lists, each line with its words.
data class PromoRow(val line: PromoLine, val name: String, val daysIdle: Int)
data class PromoLists(val slow: List<PromoRow> = emptyList(), val active: List<PromoRow> = emptyList(), val stale: List<PromoRow> = emptyList(), val slowDays: Int = 30, val stillDays: Int = 14, val loaded: Boolean = false)

// The sheet a promotion is set or reduced on: the lines of one product, a price typed for each.
data class PromoSheet(val name: String, val lines: List<PromoRow>, val typed: Map<String, String>, val reducing: Boolean)

// Promotions, on the tablet (server 0110): slow movers marked down, never
// below cost, reduced again when they still do not sell, and lifted. The
// lists are as this tablet knows them (its own sales and the shop's it was
// sent): on a shop with one till, the shop's.
@HiltViewModel
class PromotionsViewModel @Inject constructor(
    private val db: TillDatabase,
    private val promotions: Promotions,
    private val sales: RetailSales,
    private val approvals: Approvals,
) : ViewModel() {
    private val _lists = MutableStateFlow(PromoLists())
    val lists: StateFlow<PromoLists> = _lists
    val sheet = MutableStateFlow<PromoSheet?>(null)
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy

    fun refresh() = viewModelScope.launch {
        val s = PosSettings.parse(db.ops().settings())
        val now = System.currentTimeMillis()
        val all = promotions.lines()
        val row = { l: PromoLine, r: PromotionRules.Line -> PromoRow(l, sales.nameOf(l.item, l.variant), PromotionRules.daysIdle(r, now)) }
        val byKey = all.associate { (l, r) -> (l.item.id to l.variantId) to (l to r) }
        val slow = PromotionRules.slowMovers(all.map { it.second }, now, s.slowMoverDays).map { r -> byKey[r.itemId to r.variantId]!!.let { row(it.first, it.second) } }
        val active = all.filter { it.first.promotion != null }.sortedByDescending { it.first.promotion!!.applied_at }.map { row(it.first, it.second) }
        val stale = PromotionRules.stale(all.map { it.second }, now, s.promoStillDays).map { r -> byKey[r.itemId to r.variantId]!!.let { row(it.first, it.second) } }
        _lists.value = PromoLists(slow, active, stale, s.slowMoverDays, s.promoStillDays, loaded = true)
    }

    // Set promotion: every line of the product (its variants, or the product alone), seeded with the current prices
    fun open(r: PromoRow, reducing: Boolean = false) = viewModelScope.launch {
        val all = promotions.lines()
        val lines = if (reducing) listOf(r) else all.filter { it.first.item.id == r.line.item.id && it.first.promotion == null }.map { (l, rr) -> PromoRow(l, sales.nameOf(l.item, l.variant), PromotionRules.daysIdle(rr, System.currentTimeMillis())) }
        sheet.value = PromoSheet(r.line.item.name, lines, lines.associate { it.line.variantId to Money.plain(it.line.price).replace(",", "") }, reducing)
    }

    fun type(variantId: String, text: String) { sheet.value = sheet.value?.let { it.copy(typed = it.typed + (variantId to text.filter { c -> c.isDigit() || c == '.' }.take(10))) } }

    // what the typed price means for a line: a sentence that blocks, or nothing
    fun problem(s: PromoSheet, r: PromoRow): String? {
        val asked = cents(s.typed[r.line.variantId]) ?: return "Type a price"
        return if (s.reducing) PromotionRules.reduceCheck(r.line.cost, r.line.promotion?.promo_price ?: r.line.price, asked) else PromotionRules.check(r.line.cost, r.line.price, asked)
    }

    // a line left at its price is not touched; the ones lowered are applied
    fun submit() = viewModelScope.launch {
        val s = sheet.value ?: return@launch
        val todo = s.lines.filter { r -> cents(s.typed[r.line.variantId])?.let { it < (if (s.reducing) r.line.promotion?.promo_price ?: r.line.price else r.line.price) } == true }
        if (todo.isEmpty()) { Toaster.say("Type a lower price for at least one line"); return@launch }
        todo.firstNotNullOfOrNull { problem(s, it) }?.let { Toaster.say(it); return@launch }
        run(if (s.reducing) "Reduced. The price changes on every till at its next sync." else "On promotion. The price changes on every till at its next sync.") { by ->
            var out: Result<Unit> = Result.success(Unit)
            for (r in todo) {
                val price = cents(s.typed[r.line.variantId])!!
                out = if (s.reducing) promotions.reduce(r.line.item.id, r.line.variant?.id, price, "", by) else promotions.apply(r.line.item.id, r.line.variant?.id, price, "", by)
                if (out.isFailure) break
            }
            out
        }
    }

    fun lift(r: PromoRow) {
        val p = r.line.promotion ?: return
        run("Lifted: the price is back") { by -> promotions.lift(p.id, by).map { restored -> if (!restored) Toaster.say("The price had been changed by hand since: it is left as it stands.") } }
    }

    private fun run(done: String, by: StaffMember? = null, block: suspend (StaffMember?) -> Result<*>): kotlinx.coroutines.Job = viewModelScope.launch {
        if (_busy.value) return@launch
        _busy.value = true
        val out = block(by)
        _busy.value = false
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) approvals.ask(need.permission, need.what) { approver -> run(done, approver, block) }
        else {
            out.fold({ sheet.value = null; Toaster.say(done) }, { Toaster.say(it.message ?: "That did not work") })
            refresh()
        }
    }

    private fun cents(text: String?): Long? = text?.trim()?.takeIf { it.isNotEmpty() }?.toDoubleOrNull()?.let { Math.round(it * 100) }
}

@Composable
fun PromotionsScreen(vm: PromotionsViewModel, onBack: () -> Unit) {
    val lists by vm.lists.collectAsState()
    val sheet by vm.sheet.collectAsState()
    val busy by vm.busy.collectAsState()
    LaunchedEffect(Unit) { vm.refresh() }
    val date = DateFormat.getDateInstance(DateFormat.MEDIUM)

    Column(Modifier.fillMaxSize().padding(start = 20.dp, end = 20.dp, top = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IconKey(VI.Back, tint = V.Text, onClick = onBack)
            ScreenHead("Products that have stopped selling, and the promotions running now. A promotion lowers the price to shift stock, never below cost.", "Promotions", Modifier.weight(1f))
        }
        T("Flag a product with no sale in the last ${lists.slowDays} days, and a promotion still unsold after ${lists.stillDays} days on it. Both numbers are set in the back office, under POS settings. The lists are as this till knows the sales.", 13.sp, 500, V.Text2, lines = 3)
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item { Head("Slow movers", lists.slow.size) }
            if (lists.loaded && lists.slow.isEmpty()) item { Note("Nothing has gone quiet: every product with stock has sold within the last ${lists.slowDays} days.") }
            items(lists.slow, key = { "s" + it.line.item.id + it.line.variantId }) { r ->
                Line(r, "${r.daysIdle} ${if (r.daysIdle == 1) "day" else "days"} idle · ${r.line.qty / 1000} left · ${Money.format(r.line.price)}" + (r.line.cost?.let { " · cost ${Money.format(it)}" } ?: " · no cost known")) {
                    VBtn("Set promotion", height = 40.dp, radius = 10.dp, pad = 12.dp, size = 13.sp, enabled = !busy) { vm.open(r) }
                }
            }
            item { Head("On promotion", lists.active.size) }
            if (lists.loaded && lists.active.isEmpty()) item { Note("No promotions are running. Set one from the slow movers above.") }
            items(lists.active, key = { "a" + it.line.item.id + it.line.variantId }) { r ->
                val p = r.line.promotion!!
                Line(r, "was ${Money.format(p.original_price)} · now ${Money.format(p.promo_price)} · ${Money.format(p.original_price - p.promo_price)} off · since ${date.format(Date(p.applied_at))}", strike = p.original_price) {
                    VBtn("Lift", height = 40.dp, radius = 10.dp, pad = 12.dp, size = 13.sp, enabled = !busy) { vm.lift(r) }
                }
            }
            if (lists.stale.isNotEmpty()) {
                item { Head("Still not selling", lists.stale.size) }
                items(lists.stale, key = { "t" + it.line.item.id + it.line.variantId }) { r ->
                    val p = r.line.promotion!!
                    Line(r, "was ${Money.format(p.original_price)} · now ${Money.format(p.promo_price)} · ${r.daysIdle} days on promotion with no sale", strike = p.original_price) {
                        VBtn("Reduce again", height = 40.dp, radius = 10.dp, pad = 12.dp, size = 13.sp, enabled = !busy) { vm.open(r, reducing = true) }
                        VBtn("Lift", height = 40.dp, radius = 10.dp, pad = 12.dp, size = 13.sp, enabled = !busy) { vm.lift(r) }
                    }
                }
            }
            item { Box(Modifier.height(24.dp)) }
        }
    }

    sheet?.let { s ->
        Sheet(onDismiss = { vm.sheet.value = null }, width = 620.dp, gap = 14.dp) {
            SheetHead(if (s.reducing) "Reduce “${s.name}” again" else "Put “${s.name}” on promotion", if (s.reducing) "Lower than its promotion price, and never below cost. The original price is remembered, so lifting later still puts it all back." else "Lower the price to shift it. It can never go below cost: that would be a loss. A line left at its price is not touched.", onClose = { vm.sheet.value = null })
            s.lines.forEach { r ->
                val why = vm.problem(s, r)
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Well).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            T(r.line.variant?.name ?: r.name, 15.sp, 700)
                            T((r.line.cost?.let { "Cost ${Money.format(it)} · " } ?: "No cost known · ") + "now ${Money.format(r.line.price)} · ${r.line.qty / 1000} in stock", 12.sp, 600, V.Text2)
                        }
                        T("Rs", 14.sp, 700, V.Text2)
                        Field(s.typed[r.line.variantId] ?: "", { vm.type(r.line.variantId, it) }, "0.00", Modifier.width(130.dp), number = true)
                    }
                    // a price left as it is says nothing; a lowered one says what is wrong with it, if anything
                    val typed = s.typed[r.line.variantId]?.trim()?.toDoubleOrNull()?.let { Math.round(it * 100) }
                    if (typed != null && typed < (if (s.reducing) r.line.promotion?.promo_price ?: r.line.price else r.line.price) && why != null) T(why, 12.sp, 600, V.RedText, lines = 2)
                }
            }
            VBtn(if (s.reducing) "Reduce" else "Apply promotion", Modifier.fillMaxWidth(), V.Blue, Color.White, 58.dp, weight = 800, enabled = !busy) { vm.submit() }
        }
    }
}

@Composable
private fun Head(title: String, n: Int) {
    Row(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 2.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        T(title.uppercase(), 12.sp, 800, V.Text3, spacing = 1.sp)
        if (n > 0) T("($n)", 12.sp, 700, V.Text3)
    }
}

@Composable
private fun Note(text: String) {
    T(text, 14.sp, 500, V.Text2, Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.Panel).padding(16.dp), lines = 3)
}

@Composable
private fun Line(r: PromoRow, sub: String, strike: Long? = null, keys: @Composable () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Panel).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(r.name, 15.sp, 700)
            T(sub, 12.sp, 600, V.Text2, lines = 2)
        }
        keys()
    }
}

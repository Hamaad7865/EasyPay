package com.restopos.feature.cash

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.CashOps
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffRepository
import com.restopos.core.data.StaffSession
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.ShiftDoc
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.panel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// Mauritian notes and coins, in rupees.
private val NOTES = listOf(2000, 1000, 500, 200, 100, 50, 25)
private val COINS = listOf(20, 10, 5, 1)

// What the day came to once it is closed.
data class Closed(val expected: Long, val counted: Long, val day: String)

data class CashUi(
    val loaded: Boolean = false,
    val shift: ShiftEntity? = null,
    val doc: ShiftDoc? = null,
    val info: String = "",
    val figures: Boolean = false, // whether this person may see what the drawer should hold
    val counts: Map<Int, Int> = emptyMap(),
    val closed: Closed? = null,
    val busy: Boolean = false,
    val cashNames: Set<String> = emptySet(), // what the cash payment types are called
    val unclosed: Boolean = false, // sales from before, with no day open, that no closing covers
) {
    val counted: Long get() = (NOTES + COINS).sumOf { it.toLong() * (counts[it] ?: 0) } * 100
}

// The cash drawer: count it by note and coin, see what it should hold, and
// close the day from the count.
@HiltViewModel
class CashViewModel @Inject constructor(
    private val cash: CashOps,
    private val repo: StaffRepository,
    private val staff: StaffSession,
    private val db: TillDatabase,
    private val approvals: Approvals,
) : ViewModel() {
    private val _ui = MutableStateFlow(CashUi())
    val ui: StateFlow<CashUi> = _ui
    private val hm = SimpleDateFormat("HH:mm", Locale.US)

    fun load() = viewModelScope.launch {
        val shift = cash.currentShift()
        val cur = _ui.value
        if (shift == null) { _ui.value = cur.copy(loaded = true, shift = null, doc = null, closed = null, info = "The day is not open on this till", unclosed = cash.unclosed()); return@launch }
        val doc = cash.shiftDoc(shift)
        _ui.value = cur.copy(
            loaded = true, shift = shift, doc = doc, figures = cur.figures || staff.can("shift.view_report"),
            cashNames = db.ops().allPaymentTypes().filter { it.kind == "cash" }.map { it.name }.toSet(),
            info = "${doc.till} · opened ${hm.format(Date(shift.opened_at))}" + (doc.openedBy?.let { " by $it" } ?: ""),
            // another day: start the count again
            counts = if (cur.shift?.id == shift.id) cur.counts else emptyMap(), closed = null,
        )
    }

    fun step(denomination: Int, by: Int) {
        val c = _ui.value.counts
        _ui.value = _ui.value.copy(counts = c + (denomination to ((c[denomination] ?: 0) + by).coerceIn(0, 9999)))
    }

    // Someone who may not see the figures asks someone who may, for this visit.
    fun unlock() = approvals.ask("shift.view_report", "see the day's figures") { _ui.value = _ui.value.copy(figures = true) }

    private suspend fun approved(done: String?, by: StaffMember? = null, block: suspend (StaffMember?) -> Result<*>) {
        val out = block(by)
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) approvals.ask(need.permission, need.what) { approver -> viewModelScope.launch { approved(done, approver, block) } }
        else { out.fold({ done?.let { Toaster.say(it) } }, { Toaster.say(it.message) }); load() }
    }

    fun xReport() = viewModelScope.launch {
        val s = _ui.value.shift ?: return@launch
        cash.printShift(s).fold({ Toaster.say("X report printed") }, { Toaster.say(it.message) })
    }

    fun openDrawer() = viewModelScope.launch { approved("Drawer opened") { by -> cash.openDrawer(by) } }

    fun move(type: String, rupees: Long, reason: String) = viewModelScope.launch {
        if (rupees <= 0) { Toaster.say("Type the amount"); return@launch }
        if (reason.isBlank()) { Toaster.say("Say what it is for"); return@launch }
        approved(if (type == "in") "Cash in recorded" else "Cash out recorded") { by -> cash.move(type, rupees * 100, reason.trim(), by) }
    }

    // A count for a handover: recorded, and the day stays open.
    fun saveCount() = viewModelScope.launch {
        val counted = _ui.value.counted
        approved("Count recorded · ${Money.format(counted)}") { by -> repo.count(counted, by) }
    }

    // Before the count is asked to be final: every order has to be paid.
    fun askClose(then: () -> Unit) = viewModelScope.launch {
        val n = cash.unpaidOrders()
        if (n > 0) Toaster.say(cash.unpaid(n)) else then()
    }

    // Closes the day from the count: the drawer and the Z report in one step.
    fun close(by: StaffMember? = null) {
        val s = _ui.value
        if (s.busy) return
        viewModelScope.launch {
            _ui.value = s.copy(busy = true)
            val out = cash.closeDay(s.counted, by)
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                _ui.value = s.copy(busy = false)
                approvals.ask(need.permission, need.what) { approver -> close(approver) }
                return@launch
            }
            out.fold(
                onSuccess = { (z, problem) ->
                    val day = "Day closing no. ${z.number} done. " + (problem ?: "Z report printed.")
                    _ui.value = _ui.value.copy(busy = false, shift = null, closed = Closed(z.expected ?: 0, s.counted, day))
                },
                onFailure = { _ui.value = s.copy(busy = false); Toaster.say(it.message) },
            )
        }
    }

    // With no day open: the sales from before that no closing covers.
    fun closeUnclosed() = viewModelScope.launch {
        approved(null) { by ->
            cash.closeUnclosed(by).onSuccess { (z, printed) -> Toaster.say("Day closing no. ${z.number} done." + (printed?.let { " $it" } ?: " Z report printed.")) }
        }
    }
}

@Composable
fun CashScreen(vm: CashViewModel, onOpenPeriod: () -> Unit, onClosed: () -> Unit) {
    val ui by vm.ui.collectAsState()
    var moving by remember { mutableStateOf<String?>(null) }
    var closing by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.load() }

    ui.closed?.let { c -> ClosedCard(c, onClosed); return }
    if (ui.loaded && ui.shift == null) {
        Column(Modifier.fillMaxSize().padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically)) {
            T("The day is not open", 26.sp, 700, spacing = (-0.6).sp)
            T(
                if (ui.unclosed) "The sales since the last closing are not closed yet. Closing them prints their Z report, and the next day starts clean."
                else "Open it to take cash: the cash in the drawer is counted first.",
                15.sp, 500, V.Text2, lines = 3,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Open the day", bg = V.Blue, fg = Color.White, height = 60.dp, weight = 800, pad = 24.dp, onClick = onOpenPeriod)
                if (ui.unclosed) VBtn("Close these sales · Z report", height = 60.dp, pad = 24.dp) { vm.closeUnclosed() }
            }
        }
        return
    }
    val doc = ui.doc
    Row(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxHeight().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ScreenHead(ui.info, "Count the drawer", Modifier.weight(1f))
                VBtn("Open drawer", height = 52.dp, radius = 14.dp) { vm.openDrawer() }
                VBtn("Cash in", height = 52.dp, radius = 14.dp) { moving = "in" }
                VBtn("Cash out", height = 52.dp, radius = 14.dp) { moving = "out" }
                VBtn("Print X report", height = 52.dp, radius = 14.dp, pad = 20.dp) { vm.xReport() }
            }
            Caps("Notes", V.Text2)
            Grid(NOTES, ui, vm)
            Caps("Coins", V.Text2, Modifier.padding(top = 4.dp))
            Grid(COINS, ui, vm)
        }
        Column(Modifier.width(380.dp).fillMaxHeight().background(V.Panel).drawBehind { drawRect(V.Stroke, size = Size(1.dp.toPx(), size.height)) }) {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Caps("Cash", V.Text2)
                if (doc != null && ui.figures) {
                    Line("Opening float", Money.format(doc.float))
                    Line("Cash sales", Money.format(doc.cashTaken))
                    if (doc.cashIn > 0) Line("Cash put in", Money.format(doc.cashIn))
                    Line("Pay-outs", "− " + Money.format(doc.cashOut))
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
                    Line("Expected in drawer", Money.format(doc.expected), bold = true)
                    Line("Counted", Money.format(ui.counted), bold = true)
                    val diff = ui.counted - doc.expected
                    val small = kotlin.math.abs(diff) <= 20_000
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(if (diff == 0L) V.GreenWash else if (small) V.AmberWash else V.RedWash).padding(horizontal = 18.dp, vertical = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        val fg = if (diff == 0L) V.GreenText else if (small) V.AmberText else V.RedText
                        T(if (diff == 0L) "Drawer balanced" else if (diff > 0) "Over" else "Short", 16.sp, 700, fg)
                        Gap()
                        T(if (diff == 0L) Money.format(0) else (if (diff > 0) "+ " else "− ") + Money.format(kotlin.math.abs(diff)), 24.sp, 700, fg)
                    }
                    Caps("Other tenders", V.Text2, Modifier.padding(top = 14.dp))
                    doc.payments.filter { !ui.cashNames.contains(it.name) }.forEach { Line(it.name, Money.format(it.amount)) }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
                    Line("Total takings", Money.format(doc.payments.sumOf { it.amount }), bold = true)
                } else {
                    Line("Counted", Money.format(ui.counted), bold = true)
                    T("The drawer is counted without seeing what it should hold. Someone who may see the figures can show them.", 13.sp, 500, V.Text2, lines = 4, height = 19.sp)
                    VBtn("Show the figures", Modifier.fillMaxWidth()) { vm.unlock() }
                }
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(V.Stroke))
            Column(Modifier.padding(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 22.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Record this count · handover", Modifier.fillMaxWidth(), height = 48.dp, size = 14.sp) { vm.saveCount() }
                VBtn("Close the day & print Z report", Modifier.fillMaxWidth(), V.Blue, Color.White, 66.dp, 16.dp, 16.sp) { vm.askClose { closing = true } }
            }
        }
    }

    moving?.let { type ->
        var amount by remember(type) { mutableStateOf("") }
        var reason by remember(type) { mutableStateOf("") }
        Sheet(onDismiss = { moving = null }, width = 520.dp) {
            SheetHead(if (type == "in") "Cash in" else "Cash out", if (type == "in") "Cash put into the drawer that is not a sale." else "Cash taken from the drawer: a supplier, ice, a gas refill.") { moving = null }
            Field(amount, { amount = it.filter { c -> c.isDigit() }.take(7) }, "Amount in rupees", Modifier.fillMaxWidth(), height = 54.dp, number = true)
            Field(reason, { reason = it.take(80) }, "What it is for", Modifier.fillMaxWidth(), height = 54.dp)
            VBtn("Record and print a slip", Modifier.fillMaxWidth(), V.Blue, Color.White, 60.dp, size = 16.sp, weight = 800) {
                vm.move(type, amount.toLongOrNull() ?: 0, reason)
                if ((amount.toLongOrNull() ?: 0) > 0 && reason.isNotBlank()) moving = null
            }
        }
    }
    if (closing) {
        Sheet(onDismiss = { closing = false }, width = 560.dp) {
            SheetHead("Close the day?", "Counted ${Money.format(ui.counted)}. The count is final once the day is closed: its figures are fixed, the Z report prints, and the till goes back to the start screen.") { closing = false }
            VBtn("Close the day & print Z report", Modifier.fillMaxWidth(), V.Blue, Color.White, 64.dp, size = 16.sp, weight = 800) { closing = false; vm.close() }
            VBtn("Not yet", Modifier.fillMaxWidth(), height = 56.dp) { closing = false }
        }
    }
}

@Composable
private fun Grid(values: List<Int>, ui: CashUi, vm: CashViewModel) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cols = ((maxWidth + 10.dp) / 300.dp).toInt().coerceAtLeast(1)
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            values.chunked(cols).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    row.forEach { d ->
                        val n = ui.counts[d] ?: 0
                        Row(Modifier.weight(1f).panel(16.dp).padding(start = 18.dp, end = 10.dp, top = 10.dp, bottom = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                T("Rs %,d".format(Locale.US, d), 17.sp, 700)
                                T(Money.format(d.toLong() * n * 100), 13.sp, 500, V.Text2)
                            }
                            Box(Modifier.size(52.dp).clip(RoundedCornerShape(12.dp)).background(V.Key).clickable { vm.step(d, -1) }, contentAlignment = Alignment.Center) { T("−", 22.sp, 500) }
                            T(n.toString(), 20.sp, 700, modifier = Modifier.width(40.dp), align = androidx.compose.ui.text.style.TextAlign.Center)
                            Box(Modifier.size(52.dp).clip(RoundedCornerShape(12.dp)).background(V.Key).clickable { vm.step(d, 1) }, contentAlignment = Alignment.Center) { T("+", 22.sp, 500) }
                        }
                    }
                    repeat(cols - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

@Composable
private fun Line(label: String, value: String, bold: Boolean = false) {
    Row {
        T(label, if (bold) 16.sp else 15.sp, if (bold) 700 else 500, if (bold) V.Text else V.Dim, Modifier.weight(1f))
        T(value, if (bold) 16.sp else 15.sp, if (bold) 700 else 500)
    }
}

// The day is closed: what the count came to, and back to the start screen.
@Composable
private fun ClosedCard(c: Closed, onClosed: () -> Unit) {
    val diff = c.counted - c.expected
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.width(520.dp).panel(22.dp).padding(32.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            T("Day closed", 26.sp, 800, spacing = (-0.5).sp)
            Line("Expected in drawer", Money.format(c.expected))
            Line("Counted", Money.format(c.counted))
            Line(if (diff == 0L) "Drawer balanced" else if (diff > 0) "Over" else "Short", if (diff == 0L) Money.format(0) else Money.format(kotlin.math.abs(diff)), bold = true)
            T(c.day, 14.sp, 500, V.Text2, lines = 4, height = 20.sp)
            VBtn("Back to the start screen", Modifier.fillMaxWidth(), V.Blue, Color.White, 64.dp, 14.dp, 17.sp, 800, onClick = onClosed)
        }
    }
}

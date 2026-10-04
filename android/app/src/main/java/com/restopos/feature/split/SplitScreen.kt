package com.restopos.feature.split

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Calc
import com.restopos.core.data.DiscountPick
import com.restopos.core.data.OrderOps
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.CardShape
import com.restopos.core.ui.Hairline
import com.restopos.core.ui.Pos
import com.restopos.core.ui.card
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

// One unpaid line of the order, and the check it is on. A line of two or more
// can be divided between checks, unless it has an add-on with a price (an
// add-on is charged once per line, so two lines would charge it twice).
data class SplitLine(val id: String, val name: String, val units: Int, val amount: Long, val check: Int, val divisible: Boolean)

data class SplitUi(
    val title: String = "",
    val lines: List<SplitLine> = emptyList(),
    val checks: Int = 2,
    val totals: Map<Int, Long> = emptyMap(), // what each check comes to, discount included
    val selected: String? = null,
    val asking: Pair<String, Int>? = null, // a line of several being moved to a check: how many?
    val message: String? = null,
    val ready: Boolean = false,
)

// The split check: the order's unpaid lines laid out on separate checks, each
// of which prints its own bill and is paid on its own receipt.
@HiltViewModel
class SplitViewModel @Inject constructor(
    private val tickets: TicketRepository,
    private val orders: OrderOps,
    private val db: TillDatabase,
    private val session: SessionStore,
) : ViewModel() {
    private val _ui = MutableStateFlow(SplitUi())
    val ui: StateFlow<SplitUi> = _ui
    private var discount: DiscountPick? = null

    fun load() = viewModelScope.launch { reload() }

    private suspend fun reload(message: String? = _ui.value.message) {
        val t = tickets.activeTicket()
        if (t == null) { _ui.value = SplitUi(ready = true); return }
        discount = tickets.pendingDiscount()
        val rows = db.tickets().lines(t.id).first().filter { !it.paid }
        val lines = rows.map { l ->
            val mods = db.tickets().modSum(l.id)
            SplitLine(l.id, l.name_snapshot, l.qty / 1000, Calc.lineAmount(l.unit_price, l.qty) + mods, l.check_no, l.qty % 1000 == 0 && l.qty >= 2000 && mods == 0L)
        }
        val checks = maxOf(2, _ui.value.checks, lines.maxOfOrNull { it.check } ?: 1)
        val totals = HashMap<Int, Long>()
        // a percentage comes off every check; an amount comes off the first check that has something on it
        val first = lines.minOfOrNull { it.check }
        for (n in 1..checks) {
            val mine = rows.filter { it.check_no == n }
            val d = discount?.takeIf { it.type == "percent" || n == first }
            val calc = mine.map { l ->
                Calc.Line(Calc.lineAmount(l.unit_price, l.qty) + db.tickets().modSum(l.id), db.catalog().lineTaxes(l.id).map { Calc.TaxRate(it.rate_bp, it.type) })
            }
            totals[n] = Calc.totalsRounded(calc, listOfNotNull(d?.let { Calc.Discount(if (it.type == "percent") it.value.toInt() else null, it.value) })).total
        }
        val name = t.name ?: t.table_id?.let { db.tables().table(it)?.name }?.let { tableLabel(it) } ?: "Direct sale"
        _ui.value = _ui.value.copy(
            title = name, lines = lines, checks = checks, totals = totals,
            selected = _ui.value.selected?.takeIf { id -> lines.any { it.id == id } }, asking = null, message = message, ready = true,
        )
    }

    fun select(id: String) { _ui.value = _ui.value.copy(selected = if (_ui.value.selected == id) null else id, message = null) }
    fun addCheck() { if (_ui.value.checks < 8) { _ui.value = _ui.value.copy(checks = _ui.value.checks + 1); load() } }
    fun messageShown() { _ui.value = _ui.value.copy(message = null) }
    fun stopAsking() { _ui.value = _ui.value.copy(asking = null) }

    // Tapping a check with a line selected moves the line there. A line of
    // several asks how many go.
    fun moveTo(check: Int) = viewModelScope.launch {
        val line = _ui.value.lines.firstOrNull { it.id == _ui.value.selected } ?: run {
            _ui.value = _ui.value.copy(message = "Tap an item first, then the check it goes on.")
            return@launch
        }
        if (line.check == check) return@launch
        if (line.units >= 2 && line.divisible) { _ui.value = _ui.value.copy(asking = line.id to check); return@launch }
        db.tickets().setCheck(line.id, check)
        _ui.value = _ui.value.copy(selected = null)
        reload(if (line.units >= 2) "${line.name} has an add-on that is charged once, so it moved whole." else null)
    }

    // units = how many of the line go to the check; all of them moves the line itself.
    fun move(lineId: String, check: Int, units: Int) = viewModelScope.launch {
        val line = _ui.value.lines.firstOrNull { it.id == lineId } ?: return@launch
        if (units >= line.units) {
            db.tickets().setCheck(lineId, check)
            _ui.value = _ui.value.copy(selected = null)
            reload(null)
        } else {
            tickets.splitLine(lineId, units, check).fold(
                onSuccess = { _ui.value = _ui.value.copy(selected = null); reload(null) },
                onFailure = { reload(it.message) },
            )
        }
    }

    // Everything back on one check.
    fun merge() = viewModelScope.launch {
        _ui.value.lines.forEach { if (it.check != 1) db.tickets().setCheck(it.id, 1) }
        _ui.value = _ui.value.copy(checks = 2, selected = null)
        reload("All items are back on check 1.")
    }

    private fun discountFor(check: Int): DiscountPick? =
        discount?.takeIf { it.type == "percent" || check == _ui.value.lines.minOfOrNull { l -> l.check } }

    fun printBill(check: Int) = viewModelScope.launch {
        val ids = _ui.value.lines.filter { it.check == check }.map { it.id }
        _ui.value = _ui.value.copy(message = orders.printCheck(ids, check, discountFor(check)).fold({ "Check $check sent to the printer." }, { it.message }))
    }

    // Opens the payment screen on one check: only its lines are ticked there.
    fun pay(check: Int, then: () -> Unit) = viewModelScope.launch {
        if (_ui.value.lines.none { it.check == check }) return@launch
        session.setPayCheck(check)
        then()
    }
}

@Composable
fun SplitScreen(vm: SplitViewModel = hiltViewModel(), onBack: () -> Unit, onPay: () -> Unit) {
    val ui by vm.ui.collectAsState()
    // back from paying a check: show what is left
    LaunchedEffect(Unit) { vm.load() }
    ui.message?.let { m -> LaunchedEffect(m) { delay(4500); vm.messageShown() } }
    // the last check was paid from here: nothing left to split
    if (ui.ready && ui.lines.isEmpty()) LaunchedEffect(Unit) { onBack() }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxWidth().height(48.dp).background(Pos.Panel)) {
                Text("Done", Modifier.align(Alignment.CenterStart).clickable(onClick = onBack).padding(horizontal = 16.dp, vertical = 12.dp), color = Pos.Link, fontSize = 15.sp)
                Text(
                    "Split check · ${ui.title}", Modifier.align(Alignment.Center).padding(horizontal = 160.dp),
                    color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Text("Put all back on check 1", Modifier.align(Alignment.CenterEnd).clickable { vm.merge() }.padding(horizontal = 16.dp, vertical = 12.dp), color = Pos.Link, fontSize = 15.sp)
            }
            Text(
                if (ui.selected == null) "Tap an item, then tap the check it goes on. Each check prints its own bill and is paid on its own receipt."
                else "Now tap the check this item goes on.",
                Modifier.padding(horizontal = 16.dp, vertical = 10.dp), color = if (ui.selected == null) Pos.Text3 else Pos.Link, fontSize = 13.sp,
            )
            Row(
                Modifier.weight(1f).fillMaxWidth().horizontalScroll(rememberScrollState()).padding(start = 14.dp, end = 14.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                for (n in 1..ui.checks) {
                    val mine = ui.lines.filter { it.check == n }
                    val target = ui.selected != null && mine.none { it.id == ui.selected }
                    Column(
                        Modifier.width(300.dp).fillMaxHeight().card()
                            .then(if (target) Modifier.border(2.dp, Pos.Link, CardShape) else Modifier)
                            .clickable(enabled = target) { vm.moveTo(n) },
                    ) {
                        Row(Modifier.fillMaxWidth().background(Pos.PanelDeep).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text("Check $n", Modifier.weight(1f), color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                            Text(Money.format(ui.totals[n] ?: 0), color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        }
                        Hairline()
                        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                            if (mine.isEmpty()) {
                                Text(
                                    if (target) "Tap to move it here" else "Nothing on this check yet",
                                    Modifier.padding(16.dp), color = if (target) Pos.Link else Pos.Text3, fontSize = 14.sp,
                                )
                            }
                            mine.forEach { l ->
                                val on = l.id == ui.selected
                                Row(
                                    Modifier.fillMaxWidth().background(if (on) Pos.Selected else Color.Transparent)
                                        .then(if (target) Modifier else Modifier.clickable { vm.select(l.id) })
                                        .padding(horizontal = 16.dp, vertical = 13.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text("${l.units}", Modifier.width(26.dp), color = Pos.Text2, fontSize = 15.sp)
                                    Text(l.name, Modifier.weight(1f), color = Pos.Text, fontSize = 15.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                    Text(Money.format(l.amount), color = Pos.Text2, fontSize = 14.sp)
                                }
                                Hairline(Modifier.padding(horizontal = 16.dp))
                            }
                        }
                        Hairline()
                        Row(Modifier.fillMaxWidth().padding(10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Key("Print bill", Pos.Key, Pos.Text, Modifier.weight(1f), mine.isNotEmpty()) { vm.printBill(n) }
                            Key("Pay", Pos.Green, Color.White, Modifier.weight(1f), mine.isNotEmpty()) { vm.pay(n, onPay) }
                        }
                    }
                }
                if (ui.checks < 8) {
                    Box(
                        Modifier.width(150.dp).fillMaxHeight().clip(CardShape).border(1.dp, Pos.Stroke, CardShape).clickable { vm.addCheck() },
                        contentAlignment = Alignment.Center,
                    ) { Text("+  Add a check", color = Pos.Link, fontSize = 15.sp, fontWeight = FontWeight.Medium) }
                }
            }
        }
        ui.message?.let { m ->
            Text(
                m, Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp)).background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    ui.asking?.let { (lineId, check) ->
        val line = ui.lines.firstOrNull { it.id == lineId }
        if (line != null) {
            AlertDialog(
                onDismissRequest = { vm.stopAsking() },
                title = { Text("How many go on check $check?") },
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("${line.units} × ${line.name}", color = Pos.Text2, fontSize = 14.sp)
                        (1..line.units).chunked(4).forEach { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                row.forEach { u ->
                                    Key(if (u == line.units) "All $u" else "$u", if (u == line.units) Pos.TabOn else Pos.Key, Color.White, Modifier.weight(1f), true) { vm.move(lineId, check, u) }
                                }
                                repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
                            }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { OutlinedButton(onClick = { vm.stopAsking() }) { Text("Cancel") } },
            )
        }
    }
}

@Composable
private fun Key(label: String, color: Color, text: Color, modifier: Modifier, enabled: Boolean, onClick: () -> Unit) {
    Box(
        modifier.height(44.dp).clip(RoundedCornerShape(8.dp)).background(if (enabled) color else Pos.Key).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (enabled) text else Pos.Text3, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1) }
}

package com.restopos.feature.today

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.Approvals
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffSession
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Gap
import com.restopos.core.ui.L
import com.restopos.core.ui.ScreenHead
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.panel
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.mapLatest
import kotlinx.coroutines.flow.stateIn
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.TextStyle
import java.util.Locale
import javax.inject.Inject

data class Share(val label: String, val amount: Long, val pct: Int)

data class TodayUi(
    val loaded: Boolean = false,
    val sales: Long = 0,
    val versus: String = "", // against the same day last week, when this till has that day
    val up: Boolean = true,
    val covers: Int = 0,
    val checks: Int = 0,
    val openDue: Long = 0,
    val openCount: Int = 0,
    val hours: List<Pair<Int, Long>> = emptyList(),
    val mix: List<Share> = emptyList(),
    val channels: List<Share> = emptyList(),
    val top: List<Pair<String, Long>> = emptyList(),
)

// Today's sales on this till, worked out from its own receipts: nothing here
// is a sample. Refunds come off the day they are made.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class TodayViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val service: ServiceRepository,
    private val staff: StaffSession,
    private val approvals: Approvals,
) : ViewModel() {
    // someone who may not see the figures can be shown them by someone who may
    private val shown = MutableStateFlow(false)
    val allowed: StateFlow<Boolean> = combine(staff.current, shown) { _, s -> s || staff.can("shift.view_report") }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), staff.can("shift.view_report"))
    fun unlock() = approvals.ask("shift.view_report", "see today's sales") { shown.value = true }

    val ui: StateFlow<TodayUi> = flow { emit(session.deviceId() to session.storeId()) }.flatMapLatest { (device, store) ->
        if (device == null || store == null) flowOf(TodayUi(loaded = true))
        else {
            val zone = ZoneId.systemDefault()
            val start = LocalDate.now().atStartOfDay(zone).toInstant().toEpochMilli()
            combine(db.service().receiptsSince(device, start - 7 * 24 * 3_600_000L), service.orders(store)) { receipts, orders -> receipts to orders }.mapLatest { (all, orders) ->
                val now = System.currentTimeMillis()
                val today = all.filter { it.device_time >= start }
                fun signed(type: String, total: Long) = if (type == "refund") -total else total
                val sales = today.sumOf { signed(it.type, it.total) }
                // the same hours of the same weekday, a week ago
                val before = all.filter { it.device_time >= start - 7 * 24 * 3_600_000L && it.device_time <= now - 7 * 24 * 3_600_000L }.sumOf { signed(it.type, it.total) }
                val day = LocalDate.now().minusDays(7).dayOfWeek.getDisplayName(TextStyle.FULL, Locale.UK)
                val tickets = today.filter { it.type == "sale" }.map { it.ticket_id }.distinct()
                val byTicket = tickets.chunked(800).flatMap { db.service().ticketsById(it) }.associateBy { it.id }
                val types = db.catalog().diningOptions().associateBy { it.id }
                val pay = db.ops().allPaymentTypes().associateBy { it.id }
                val paid = db.ops().paidBetween(device, start, now + 60_000)
                val mix = paid.groupBy { pay[it.payment_type_id]?.name ?: "Other" }.mapValues { e -> e.value.sumOf { signed(it.type, it.amount) } }.filter { it.value != 0L }
                val channels = today.groupBy { r -> byTicket[r.ticket_id]?.dining_option_id?.let { types[it]?.name } ?: "Other" }.mapValues { e -> e.value.sumOf { signed(it.type, it.total) } }.filter { it.value != 0L }
                fun shares(m: Map<String, Long>): List<Share> {
                    val total = m.values.sum().coerceAtLeast(1)
                    return m.entries.sortedByDescending { it.value }.map { Share(it.key, it.value, Math.round(it.value * 100.0 / total).toInt()) }
                }
                val hours = today.groupBy { Instant.ofEpochMilli(it.device_time).atZone(zone).hour }.mapValues { e -> e.value.sumOf { signed(it.type, it.total) } }
                val nowHour = Instant.ofEpochMilli(now).atZone(zone).hour
                val first = minOf(hours.keys.minOrNull() ?: nowHour, (nowHour - 9).coerceAtLeast(0))
                val open = orders.filter { it.open && it.lines.isNotEmpty() }
                TodayUi(
                    loaded = true, sales = sales,
                    versus = if (before > 0) "${if (sales >= before) "+" else "−"}${Math.abs(Math.round((sales - before) * 100.0 / before))}% vs last $day" else "${today.count { it.type == "sale" }} receipts so far",
                    up = sales >= before,
                    covers = byTicket.values.sumOf { it.covers ?: 0 }, checks = tickets.size,
                    openDue = open.sumOf { it.due }, openCount = open.size,
                    hours = (first..nowHour).map { it to (hours[it] ?: 0L) },
                    mix = shares(mix), channels = shares(channels),
                    top = db.service().bestSellers(device, start).map { it.name to (it.qty + 500) / 1000 },
                )
            }
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), TodayUi())
}

private val MIX = listOf(0xFFF2F4F7, 0xFF5FB56A, 0xFFE5484D, 0xFF3B82C4, 0xFF7C5CFA, 0xFFF5A524, 0xFF22C8F5).map { Color(it) }
private fun short(cents: Long): String = if (cents >= 100_000) "Rs %.1fk".format(Locale.US, cents / 100_000.0) else Money.format(cents)

@Composable
fun TodayScreen(vm: TodayViewModel, serviceLine: String) {
    val ui by vm.ui.collectAsState()
    val allowed by vm.allowed.collectAsState()
    if (!allowed) {
        Column(Modifier.fillMaxSize().padding(40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically)) {
            T(L.today, 26.sp, 700, spacing = (-0.6).sp)
            T("The day's figures are for those allowed to see them. Someone who is can show them with their PIN.", 15.sp, 500, V.Text2, lines = 3)
            VBtn("Show the figures", bg = V.Blue, fg = Color.White, height = 56.dp, pad = 24.dp) { vm.unlock() }
        }
        return
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 20.dp, bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        ScreenHead("$serviceLine · this till", L.todayTitle)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Kpi("Net sales", Money.format(ui.sales), ui.versus, if (ui.up) V.GreenText else V.RedText, Modifier.weight(1f))
            Kpi("Covers", ui.covers.toString(), if (ui.covers > 0) "${Money.format(ui.sales / ui.covers)} per head" else "No table served yet", V.Text2, Modifier.weight(1f))
            Kpi("Average check", Money.format(if (ui.checks > 0) ui.sales / ui.checks else 0), "${ui.checks} checks closed", V.Text2, Modifier.weight(1f))
            Kpi("Still open", Money.format(ui.openDue), "${ui.openCount} orders in progress", V.Text2, Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1.6f).panel().padding(horizontal = 22.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                T("Sales by hour", 17.sp, 700)
                val max = ui.hours.maxOfOrNull { it.second }?.coerceAtLeast(1) ?: 1
                Row(Modifier.fillMaxWidth().height(240.dp), verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    ui.hours.forEachIndexed { i, (h, v) ->
                        Column(Modifier.weight(1f).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.Bottom)) {
                            T(if (v > 0) short(v) else "", 11.sp, 500, V.Text2)
                            Box(
                                Modifier.fillMaxWidth().heightIn(min = 4.dp).height((190 * (v.coerceAtLeast(0).toFloat() / max)).dp)
                                    .clip(RoundedCornerShape(8.dp, 8.dp, 4.dp, 4.dp))
                                    .background(if (i == ui.hours.lastIndex) Brush.verticalGradient(listOf(V.Cyan, V.Blue)) else Brush.verticalGradient(listOf(V.Hover, V.Hover))),
                            )
                            T("$h:00", 12.sp, 500, V.Dim)
                        }
                    }
                }
            }
            Column(Modifier.weight(1f).panel().padding(horizontal = 22.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                T("Payment mix", 17.sp, 700)
                if (ui.mix.isEmpty()) T("No payments yet today.", 14.sp, 500, V.Text3)
                else {
                    Row(Modifier.fillMaxWidth().height(14.dp).clip(RoundedCornerShape(7.dp)), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                        ui.mix.forEachIndexed { i, m -> if (m.amount > 0) Box(Modifier.weight(m.amount.toFloat()).fillMaxHeight().background(MIX[i % MIX.size])) }
                    }
                    Column {
                        ui.mix.forEachIndexed { i, m ->
                            Row(Modifier.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(MIX[i % MIX.size]))
                                T(m.label, 15.sp, 500, modifier = Modifier.weight(1f))
                                T(Money.format(m.amount), 15.sp, 500)
                                T("${m.pct}%", 15.sp, 500, V.Text2, Modifier.width(44.dp), align = androidx.compose.ui.text.style.TextAlign.End)
                            }
                            Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                        }
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(Modifier.weight(1f).panel().padding(horizontal = 22.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                T("Best sellers", 17.sp, 700, modifier = Modifier.padding(bottom = 6.dp))
                if (ui.top.isEmpty()) T("Nothing sold yet today.", 14.sp, 500, V.Text3)
                ui.top.forEachIndexed { i, (name, qty) ->
                    Row(Modifier.padding(vertical = 9.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Box(Modifier.size(28.dp).clip(RoundedCornerShape(8.dp)).background(V.Key), contentAlignment = Alignment.Center) { T((i + 1).toString(), 13.sp, 700) }
                        T(name, 15.sp, 500, modifier = Modifier.weight(1f))
                        T("$qty sold", 15.sp, 500, V.Dim)
                    }
                    Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                }
            }
            Column(Modifier.weight(1f).panel().padding(horizontal = 22.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                T("Sales by channel", 17.sp, 700)
                if (ui.channels.isEmpty()) T("No sales yet today.", 14.sp, 500, V.Text3)
                ui.channels.forEach { c ->
                    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                        Row { T(c.label, 15.sp, 500); Gap(); T("${Money.format(c.amount)} · ${c.pct}%", 15.sp, 500) }
                        Box(Modifier.fillMaxWidth().height(10.dp).clip(RoundedCornerShape(5.dp)).background(V.Stroke)) {
                            Box(Modifier.fillMaxWidth(c.pct.coerceIn(0, 100) / 100f).fillMaxHeight().clip(RoundedCornerShape(5.dp)).background(V.Blue))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Kpi(label: String, value: String, sub: String, subColor: Color, modifier: Modifier) {
    Column(modifier.panel().padding(horizontal = 20.dp, vertical = 18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        T(label, 14.sp, 500, V.Text2)
        T(value, 30.sp, 700, spacing = (-1).sp)
        T(sub, 13.sp, 500, subColor)
    }
}

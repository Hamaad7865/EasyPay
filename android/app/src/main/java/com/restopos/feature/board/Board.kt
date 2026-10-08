package com.restopos.feature.board

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.OrderInfo
import com.restopos.core.data.OrderOps
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Gap
import com.restopos.core.ui.L
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// The takeaway and delivery board: every such order from the moment it is
// rung up until it has left, in three columns.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class BoardViewModel @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val service: ServiceRepository,
    private val tickets: TicketRepository,
    private val orderOps: OrderOps,
) : ViewModel() {
    private val store = flow { emit(session.storeId()) }
    val orders: StateFlow<List<OrderInfo>> = store.flatMapLatest { s -> if (s == null) flowOf(emptyList()) else service.orders(s).map { all -> all.filter { it.ticket.stage != null && it.ticket.stage != "done" } } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    val doneToday: StateFlow<Int> = store.flatMapLatest { s ->
        if (s == null) emptyFlow() else db.service().boardDone(s, LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli())
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)

    // A new takeaway or delivery: the order screen opens empty, and the order
    // is made when the first item or the customer's name goes on it.
    fun start(kind: String, then: () -> Unit) = viewModelScope.launch {
        val type: DiningOptionEntity? = db.catalog().diningOptions().firstOrNull { it.kind == kind }
        if (type == null) { Toaster.say("There is no ${if (kind == "delivery") "delivery" else "takeaway"} order type. Add one in the back office, under Settings."); return@launch }
        tickets.startOrder(type.id)
        then()
    }

    fun open(o: OrderInfo, then: () -> Unit) = viewModelScope.launch {
        if (!o.open) { Toaster.say("${o.label} is paid. It only has to be handed over."); return@launch }
        tickets.select(o.id)
        then()
    }

    // The key on a card: on to the next column, or to the payment when it is
    // collected unpaid.
    fun act(o: OrderInfo, toPay: () -> Unit, toOrder: () -> Unit) = viewModelScope.launch {
        when (o.ticket.stage) {
            "new" -> {
                if (o.lines.isEmpty()) { tickets.select(o.id); toOrder(); return@launch }
                tickets.select(o.id)
                orderOps.save().fold(
                    onSuccess = { r ->
                        // nothing left to send still means the kitchen has it all
                        if (db.tickets().ticket(o.id)?.stage == "new") tickets.setStage(o.id, "kitchen")
                        Toaster.say(r.trouble(o.label, again = false) ?: "${o.label} · sent to kitchen")
                    },
                    onFailure = { Toaster.say(it.message) },
                )
            }
            "kitchen" -> { tickets.setStage(o.id, "ready"); Toaster.say("${o.label} · ready") }
            "ready" -> {
                if (!o.paid && o.open) { tickets.select(o.id); toPay() }
                else { tickets.setStage(o.id, "done"); Toaster.say("${o.label} · " + if (o.kind == "delivery") "out for delivery" else "collected") }
            }
        }
    }

    suspend fun riders(): List<EmployeeEntity> = session.storeId()?.let { db.staff().staff(it).first() } ?: emptyList()
    fun rider(o: OrderInfo, name: String) = viewModelScope.launch { tickets.setRider(o.id, name) }
    fun later(o: OrderInfo, minutes: Int) = viewModelScope.launch { tickets.setDue(o.id, (o.ticket.due_at ?: System.currentTimeMillis()) + minutes * 60_000L) }
}

private val HM = SimpleDateFormat("HH:mm", Locale.US)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun BoardScreen(vm: BoardViewModel, onOrder: () -> Unit, onPay: () -> Unit) {
    val orders by vm.orders.collectAsState()
    val done by vm.doneToday.collectAsState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { now = System.currentTimeMillis(); delay(15_000) } }
    var details by remember { mutableStateOf<OrderInfo?>(null) }

    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T("$done collected today", 13.sp, 500, V.Text2)
                T("${L.takeaway} & ${L.delivery}", 26.sp, 700, spacing = (-0.6).sp)
            }
            Gap()
            VBtn(L.newDelivery, height = 52.dp, radius = 14.dp, pad = 20.dp) { vm.start("delivery", onOrder) }
            VBtn(L.newTakeaway, Modifier.shadow(8.dp, RoundedCornerShape(14.dp), spotColor = V.Blue), V.Blue, Color.White, 52.dp, 14.dp, pad = 22.dp) { vm.start("takeaway", onOrder) }
        }
        Row(Modifier.weight(1f).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            listOf(Triple("new", "New", V.Blue), Triple("kitchen", "In the kitchen", Color(0xFFFFB020)), Triple("ready", "Ready", V.Ok)).forEach { (stage, label, color) ->
                val list = orders.filter { it.ticket.stage == stage }.sortedBy { it.ticket.due_at ?: Long.MAX_VALUE }
                Column(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(22.dp)).background(V.Panel).padding(start = 12.dp, end = 12.dp, top = 14.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(Modifier.padding(horizontal = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(10.dp).clip(CircleShape).background(color))
                        T(label, 16.sp, 700)
                        T(list.size.toString(), 13.sp, 500, V.Text2)
                    }
                    LazyColumn(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (list.isEmpty()) item { T("Nothing here right now", 14.sp, 500, V.Text2, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 40.dp), align = androidx.compose.ui.text.style.TextAlign.Center) }
                        items(list, key = { it.id }) { o -> Card(o, now, onOpen = { vm.open(o, onOrder) }, onDetails = { details = o }) { vm.act(o, onPay, onOrder) } }
                    }
                }
            }
        }
    }

    details?.let { o ->
        var riders by remember { mutableStateOf<List<String>>(emptyList()) }
        LaunchedEffect(o.id) { riders = vm.riders().map { it.name } }
        Sheet(onDismiss = { details = null }, width = 560.dp) {
            SheetHead("${o.label} · ${o.ticket.name ?: "Walk-in"}", "When it is wanted" + if (o.kind == "delivery") ", and who brings it." else ".") { details = null }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                T("Due ${o.ticket.due_at?.let { HM.format(Date(it)) } ?: "—"}", 17.sp, 800, modifier = Modifier.weight(1f))
                VBtn("− 5 min", height = 48.dp) { vm.later(o, -5); details = null }
                VBtn("+ 5 min", height = 48.dp) { vm.later(o, 5); details = null }
                VBtn("+ 15 min", height = 48.dp) { vm.later(o, 15); details = null }
            }
            if (o.kind == "delivery") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    riders.forEach { r ->
                        val on = o.ticket.rider == r
                        VBtn(r, bg = if (on) V.On else V.Key, fg = if (on) V.OnText else V.Text, height = 54.dp) { vm.rider(o, r); details = null }
                    }
                    if (o.ticket.rider != null) VBtn("No rider", bg = V.RedWash, fg = V.RedText, height = 54.dp) { vm.rider(o, ""); details = null }
                }
            }
        }
    }
}

@Composable
private fun Card(o: OrderInfo, now: Long, onOpen: () -> Unit, onDetails: () -> Unit, onAct: () -> Unit) {
    val delivery = o.kind == "delivery"
    val paid = o.paid
    val due = o.ticket.due_at
    val d = due?.let { Math.round((it - now) / 60_000.0).toInt() }
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Key).clickable(onClick = onOpen).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            T(o.ticket.order_no ?: "—", 14.sp, 700)
            Chip(o.typeName, if (delivery) V.VioletWash else V.TealWash, if (delivery) V.VioletText else V.TealText)
            T(o.ticket.source ?: "", 12.sp, 500, V.Text2)
            Gap()
            Chip(if (paid) "Paid" else "To pay", if (paid) V.GreenWash else V.AmberWash, if (paid) V.GreenText else V.AmberText)
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            T(o.ticket.name ?: "Walk-in", 18.sp, 700, modifier = Modifier.weight(1f), spacing = (-0.3).sp)
            T(o.ticket.phone ?: "", 13.sp, 500, V.Text2)
        }
        Row(Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onDetails), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            VIcon(VI.Clock, 16.dp, V.Text2)
            T(due?.let { HM.format(Date(it)) } ?: "—", 14.sp, 700)
            if (d != null) T(if (d > 0) "in $d min" else if (d == 0) "due now" else "${-d} min late", 14.sp, 700, if (d < 0) V.RedText else if (d <= 5) V.AmberText else V.Dim)
        }
        if (delivery) {
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(V.VioletWash).clickable(onClick = onDetails).padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T(o.ticket.address ?: "Address to confirm", 14.sp, 700, lines = 2)
                T(o.ticket.rider?.let { "Rider · $it" } ?: "No rider yet · tap to pick one", 13.sp, 500, V.VioletText)
            }
        }
        T(
            if (o.lines.isEmpty()) "Nothing rung up yet" else o.lines.joinToString(", ") { "${it.units}× ${it.line.name_snapshot}" },
            14.sp, 500, V.Dim, lines = 3, height = 20.sp,
        )
        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            T(Money.format(if (paid) o.total else o.due), 17.sp, 700, modifier = Modifier.weight(1f))
            VBtn(
                when (o.ticket.stage) {
                    "new" -> if (o.lines.isEmpty()) "Add items" else L.send
                    "kitchen" -> "Mark ready"
                    else -> if (!paid && o.open) "Collect & pay" else if (delivery) "Out for delivery" else "Collected"
                },
                bg = V.On, fg = V.OnText, height = 48.dp, size = 14.sp, pad = 18.dp, onClick = onAct,
            )
        }
    }
}

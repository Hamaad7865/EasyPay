package com.restopos.feature.orders

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Uuid7
import com.restopos.core.common.tableLabel
import com.restopos.core.data.Calc
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Avatar
import com.restopos.core.ui.Hairline
import com.restopos.core.ui.HeadCell
import com.restopos.core.ui.Pos
import com.restopos.core.ui.PosIcons
import com.restopos.core.ui.Tag
import com.restopos.core.ui.card
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import javax.inject.Inject

data class OrderRow(
    val id: String,
    val label: String,
    val floor: String?,
    val user: String?,
    val covers: Int?,
    val created: Long?,
    val lastEdit: Long,
    val course: Int?,
    val total: Long,
    val partPaid: Boolean,
    val dining: String?, // the dining option the order counts under
    val onRegister: Boolean,
    val badge: String = "", // what its little square shows: the table's number, a tab's first letter
)

data class OrdersUi(val options: List<DiningOptionEntity> = emptyList(), val rows: List<OrderRow> = emptyList())

// Orders opened on this tablet and not fully paid yet. Everything here is read
// from Room, so the list works with no connection.
@HiltViewModel
class OrdersViewModel @Inject constructor(
    private val tickets: TicketRepository,
    private val db: TillDatabase,
    private val session: SessionStore,
) : ViewModel() {
    private val _ui = MutableStateFlow(OrdersUi())
    val ui: StateFlow<OrdersUi> = _ui

    fun load() = viewModelScope.launch {
        val store = session.storeId() ?: return@launch
        val active = session.activeTicket()
        val tables = db.tables().tablesNow(store).associateBy { it.id }
        val options = db.catalog().diningOptions()
        // an order with no dining option, or one that is gone, counts under the default
        val fallback = (options.firstOrNull { it.is_default } ?: options.firstOrNull())?.id
        val known = options.map { it.id }.toSet()
        val names = HashMap<String, String?>()
        val rows = tickets.openTickets(store).first().mapNotNull { t ->
            val lines = db.tickets().lines(t.id).first()
            val unpaid = lines.filter { !it.paid }
            // an order with nothing on it and no name is only an empty register
            if (unpaid.isEmpty() && t.name == null && t.id != active) return@mapNotNull null
            val created = Uuid7.millis(t.id)
            val table = t.table_id?.let { tables[it] }
            OrderRow(
                id = t.id,
                // a sale with no name, table or customer is told from the next by its number
                label = t.name ?: table?.let { tableLabel(it.name) } ?: t.customer_id?.let { db.customers().customer(it)?.name } ?: listOfNotNull("Direct sale", t.order_no).joinToString(" "),
                floor = table?.area,
                user = t.opened_by?.let { id -> names.getOrPut(id) { db.staff().employee(id)?.name } },
                covers = t.covers,
                created = created,
                // adding an item does not touch the order itself, so its newest line counts too
                lastEdit = maxOf(t.updated_at, lines.maxOfOrNull { Uuid7.millis(it.id) ?: 0L } ?: 0L, created ?: 0L),
                course = unpaid.mapNotNull { it.course }.maxOrNull(),
                total = unpaid.sumOf { Calc.lineAmount(it.unit_price, it.qty) + db.tickets().modSum(it.id) },
                partPaid = lines.any { it.paid },
                dining = t.dining_option_id?.takeIf { known.contains(it) } ?: fallback,
                onRegister = t.id == active,
                badge = if (t.name != null) t.name.trim().take(1).uppercase() else table?.name?.trim()?.take(3) ?: "",
            )
        }
        _ui.value = OrdersUi(options, rows)
    }

    // Puts an order back on the register. A discount picked for the order
    // that was there does not follow to this one.
    fun open(id: String, then: () -> Unit) = viewModelScope.launch {
        if (id != session.activeTicket()) session.setPendingDiscount(null)
        tickets.select(id)
        then()
    }
}

private enum class Col(val label: String, val weight: Float, val end: Boolean = false) {
    Order("Order", 1.7f), Floor("Floor", 1.1f), User("Waiter", 1.5f), Covers("Covers", 0.8f), Created("Created", 1f),
    LastEdit("Last edit", 1.2f), Course("Course", 0.9f), Total("Total", 1.2f, end = true), Payment("Payment", 1f),
}

private fun sorted(rows: List<OrderRow>, by: Col, desc: Boolean): List<OrderRow> {
    val text = String.CASE_INSENSITIVE_ORDER
    val cmp: Comparator<OrderRow> = when (by) {
        Col.Order -> compareBy<OrderRow, String>(text) { it.label }
        Col.Floor -> compareBy<OrderRow, String>(text) { it.floor ?: "" }
        Col.User -> compareBy<OrderRow, String>(text) { it.user ?: "" }
        Col.Covers -> compareBy { it.covers ?: 0 }
        Col.Created -> compareBy { it.created ?: 0L }
        Col.LastEdit -> compareBy { it.lastEdit }
        Col.Course -> compareBy { it.course ?: 0 }
        Col.Total -> compareBy { it.total }
        Col.Payment -> compareBy { it.partPaid }
    }
    return rows.sortedWith(if (desc) cmp.reversed() else cmp)
}

// The open orders: a switch between the order types, a search, and a table
// with a row per order. Tapping a heading sorts by it; tapping an order
// opens it.
@Composable
fun OrdersScreen(vm: OrdersViewModel = hiltViewModel(), onOpen: () -> Unit) {
    val ui by vm.ui.collectAsState()
    LaunchedEffect(Unit) { vm.load() }
    var picked by rememberSaveable { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var sort by rememberSaveable { mutableStateOf(Col.Created) }
    var desc by rememberSaveable { mutableStateOf(true) }
    // the ages in the Last edit column move on while the screen is open
    val now by produceState(System.currentTimeMillis()) {
        while (true) { delay(30_000); value = System.currentTimeMillis() }
    }
    val option = picked?.takeIf { id -> ui.options.any { it.id == id } } ?: ui.options.firstOrNull()?.id
    val q = query.trim()
    val shown = remember(ui, option, q, sort, desc) {
        sorted(
            ui.rows.filter { it.dining == option }.filter { r ->
                q.isEmpty() || listOfNotNull(r.label, r.floor, r.user).any { it.contains(q, ignoreCase = true) }
            },
            sort, desc,
        )
    }
    val time = remember { DateFormat.getTimeInstance(DateFormat.SHORT) }

    Column(Modifier.fillMaxSize().background(Pos.Bg).padding(start = 14.dp, end = 14.dp, top = 2.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (ui.options.size > 1) {
                // one segment per order type, with how many orders it has
                Row(Modifier.clip(RoundedCornerShape(12.dp)).background(Pos.Panel).border(1.dp, Pos.Stroke, RoundedCornerShape(12.dp)).padding(4.dp)) {
                    ui.options.forEach { o ->
                        val on = o.id == option
                        val n = ui.rows.count { it.dining == o.id }
                        Row(
                            Modifier.height(36.dp).clip(RoundedCornerShape(9.dp)).background(if (on) Pos.TabOn else Color.Transparent)
                                .clickable { picked = o.id }.padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(o.name, color = if (on) Color.White else Pos.Text2, fontSize = 14.sp, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Medium, maxLines = 1)
                            Text(
                                "$n",
                                Modifier.padding(start = 8.dp).clip(RoundedCornerShape(9.dp)).background(if (on) Color.White.copy(alpha = 0.2f) else Pos.Key)
                                    .padding(horizontal = 7.dp, vertical = 1.dp),
                                color = if (on) Color.White else Pos.Text2, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
                            )
                        }
                    }
                }
            }
            Row(
                Modifier.weight(1f).height(46.dp).clip(RoundedCornerShape(12.dp)).background(Pos.Panel).border(1.dp, Pos.Stroke, RoundedCornerShape(12.dp))
                    .padding(horizontal = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Filled.Search, contentDescription = null, tint = Pos.Text3, modifier = Modifier.size(20.dp))
                BasicTextField(
                    value = query,
                    onValueChange = { query = it },
                    modifier = Modifier.weight(1f).padding(start = 12.dp),
                    singleLine = true,
                    textStyle = TextStyle(color = Pos.Text, fontSize = 15.sp),
                    cursorBrush = SolidColor(Pos.Text),
                    decorationBox = { inner ->
                        if (query.isEmpty()) Text("Search by table, name or waiter", color = Pos.Text3, fontSize = 15.sp)
                        inner()
                    },
                )
                if (query.isNotEmpty()) Text("Clear", Modifier.clickable { query = "" }.padding(8.dp), color = Pos.Link, fontSize = 13.sp)
            }
        }
        Column(Modifier.weight(1f, fill = false).fillMaxWidth().card()) {
            Row(Modifier.fillMaxWidth().background(Pos.PanelDeep).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Col.entries.forEach { c ->
                    val on = c == sort
                    HeadCell(c.label, c.weight, sorted = on, descending = desc, end = c.end) {
                        if (on) desc = !desc else { sort = c; desc = c == Col.Created || c == Col.LastEdit }
                    }
                }
            }
            Hairline()
            if (shown.isEmpty()) {
                Column(Modifier.fillMaxWidth().padding(vertical = 44.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(PosIcons.Receipt, contentDescription = null, tint = Pos.Text3, modifier = Modifier.size(30.dp))
                    Text(if (q.isEmpty()) "No open orders" else "No open order matches that search", Modifier.padding(top = 10.dp), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                    Text(if (q.isEmpty()) "Quick sale, or a free table, starts one." else "Try the table's number or the waiter's name.", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp)
                }
            } else {
                LazyColumn(Modifier.weight(1f, fill = false)) {
                    items(shown, key = { it.id }) { r ->
                        Row(
                            Modifier.fillMaxWidth().background(if (r.onRegister) Pos.Selected.copy(alpha = 0.55f) else Color.Transparent)
                                .clickable { vm.open(r.id, onOpen) }.padding(horizontal = 12.dp).height(58.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Row(Modifier.weight(Col.Order.weight).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    Modifier.size(32.dp).clip(RoundedCornerShape(9.dp)).background(Pos.TabOn.copy(alpha = 0.22f)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (r.badge.isEmpty()) Icon(PosIcons.Receipt, contentDescription = null, tint = Pos.Link, modifier = Modifier.size(16.dp))
                                    else Text(r.badge, color = Pos.Link, fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1)
                                }
                                Text(r.label, Modifier.padding(start = 10.dp), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Cell(Col.Floor, r.floor)
                            Row(Modifier.weight(Col.User.weight).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                if (r.user == null) Text("—", color = Pos.Text3, fontSize = 15.sp)
                                else {
                                    Avatar(r.user)
                                    Text(r.user, Modifier.padding(start = 8.dp), color = Pos.Text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                            Cell(Col.Covers, r.covers?.toString())
                            Cell(Col.Created, r.created?.let { time.format(Date(it)) })
                            Box(Modifier.weight(Col.LastEdit.weight).padding(horizontal = 8.dp)) { Age(now - r.lastEdit) }
                            Cell(Col.Course, r.course?.let { "Course $it" })
                            Text(
                                Money.format(r.total), Modifier.weight(Col.Total.weight).padding(horizontal = 8.dp),
                                color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.End, maxLines = 1,
                            )
                            Box(Modifier.weight(Col.Payment.weight).padding(start = 20.dp, end = 8.dp)) {
                                Tag(if (r.partPaid) "Part paid" else "Open", if (r.partPaid) Pos.Warn else Pos.Link)
                            }
                        }
                        Hairline(Modifier.padding(horizontal = 20.dp))
                    }
                }
                // what the orders on show add up to
                Row(Modifier.fillMaxWidth().background(Pos.PanelDeep).padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("${shown.size} ${if (shown.size == 1) "order" else "orders"} open", Modifier.weight(1f), color = Pos.Text2, fontSize = 13.sp)
                    Text("Total  ", color = Pos.Text3, fontSize = 13.sp)
                    Text(Money.format(shown.sumOf { it.total }), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
        Text(
            "Orders opened on this tablet that are not fully paid. Totals are before any discount.",
            Modifier.padding(horizontal = 6.dp), color = Pos.Text3, fontSize = 12.sp,
        )
    }
}

@Composable
private fun RowScope.Cell(col: Col, text: String?) {
    Text(
        text ?: "—", Modifier.weight(col.weight).padding(horizontal = 8.dp),
        color = if (text == null) Pos.Text3 else Pos.Text, fontSize = 15.sp,
        maxLines = 1, overflow = TextOverflow.Ellipsis,
    )
}

// How long since the order was last touched: green, amber from half an hour,
// red from an hour.
@Composable
private fun Age(ms: Long) {
    val min = (ms / 60_000).coerceAtLeast(0)
    Tag(
        if (min < 60) "$min min" else "${min / 60} h ${min % 60} min",
        when {
            min < 30 -> Pos.Ok
            min < 60 -> Pos.Warn
            else -> Pos.Pink
        },
        dot = true,
    )
}

package com.restopos.feature.orders

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.Uuid7
import com.restopos.core.data.Calc
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Pos
import dagger.hilt.android.lifecycle.HiltViewModel
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
    val detail: String,
    val total: Long,
    val onRegister: Boolean,
)

// Orders opened on this tablet and not fully paid yet. Everything here is read
// from Room, so the list works with no connection.
@HiltViewModel
class OrdersViewModel @Inject constructor(
    private val tickets: TicketRepository,
    private val db: TillDatabase,
    private val session: SessionStore,
) : ViewModel() {
    private val _rows = MutableStateFlow<List<OrderRow>>(emptyList())
    val rows: StateFlow<List<OrderRow>> = _rows

    fun load() = viewModelScope.launch {
        val store = session.storeId() ?: return@launch
        val active = session.activeTicket()
        val time = DateFormat.getTimeInstance(DateFormat.SHORT)
        _rows.value = tickets.openTickets(store).first().mapNotNull { t ->
            val unpaid = db.tickets().lines(t.id).first().filter { !it.paid }
            // an order with nothing on it and no name is only an empty register
            if (unpaid.isEmpty() && t.name == null && t.id != active) return@mapNotNull null
            val total = unpaid.sumOf { Calc.lineAmount(it.unit_price, it.qty) + db.tickets().modSum(it.id) }
            val opened = Uuid7.millis(t.id)?.let { time.format(Date(it)) }
            val count = unpaid.sumOf { it.qty } / 1000
            OrderRow(
                id = t.id,
                label = t.name ?: opened?.let { "Order $it" } ?: "Order",
                detail = listOfNotNull(
                    opened?.takeIf { t.name != null }?.let { "Opened $it" },
                    if (count == 1) "1 item" else "$count items",
                    t.covers?.let { if (it == 1) "1 guest" else "$it guests" },
                ).joinToString(" · "),
                total = total,
                onRegister = t.id == active,
            )
        }
    }

    // Puts an order back on the register. A discount picked for the order
    // that was there does not follow to this one.
    fun open(id: String, then: () -> Unit) = viewModelScope.launch {
        if (id != session.activeTicket()) session.setPendingDiscount(null)
        tickets.select(id)
        then()
    }

    fun startNew(then: () -> Unit) = viewModelScope.launch {
        tickets.newTicket()
        session.setPendingDiscount(null)
        then()
    }
}

@Composable
fun OrdersScreen(vm: OrdersViewModel = hiltViewModel(), onOpen: () -> Unit) {
    val rows by vm.rows.collectAsState()
    LaunchedEffect(Unit) { vm.load() }
    Column(Modifier.fillMaxSize().background(Pos.Bg).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Open orders", color = Pos.Text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Text("Orders opened on this tablet that are not fully paid. Amounts are before any discount.", color = Pos.Text3, fontSize = 12.sp)
            }
            Button(onClick = { vm.startNew(onOpen) }) { Text("New order") }
        }
        if (rows.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No open orders.", color = Pos.Text3, fontSize = 14.sp)
            }
        } else {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(rows, key = { it.id }) { r ->
                    Row(
                        Modifier.fillMaxWidth().background(if (r.onRegister) Pos.Selected else Pos.Panel)
                            .clickable { vm.open(r.id, onOpen) }.padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(r.label, color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Medium)
                            Text(r.detail, color = Pos.Text2, fontSize = 13.sp)
                        }
                        if (r.onRegister) Text("On the register", Modifier.padding(end = 16.dp), color = Pos.NavOn, fontSize = 12.sp)
                        Text(Money.format(r.total), color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }
}

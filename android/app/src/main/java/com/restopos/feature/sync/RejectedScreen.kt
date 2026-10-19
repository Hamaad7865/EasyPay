package com.restopos.feature.sync

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.Refused
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date
import javax.inject.Inject

// Changes the server refused (spec 5.4: dead-letter, badge for the manager,
// local data kept). The order or receipt itself is still on this tablet; what
// is listed here is the one change that did not go through, and why. Once
// what made the server refuse it is put right (a setting, an update), it is
// sent again from here (core/sync/Refused). Removing one removes the only copy
// that could reach the server: the sale then stays on this tablet alone, so
// it is asked first.
@HiltViewModel
class RejectedViewModel @Inject constructor(
    private val db: TillDatabase,
    @ApplicationContext private val context: android.content.Context,
) : ViewModel() {
    val rows: StateFlow<List<OutboxEntity>> = db.outbox().deadFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun again(rows: List<OutboxEntity>) = viewModelScope.launch {
        db.withTransaction {
            Refused.allAgain(rows, Uuid7::next).forEach { (was, row) -> db.outbox().revive(was, row.op_id, row.attempts) }
        }
        pushNow(context)
    }

    fun dismiss(opId: String) = viewModelScope.launch { db.outbox().remove(opId) }
}

private fun what(type: String): String = when (type) {
    "ticket.create" -> "New order"
    "ticket.add_line" -> "Item added to an order"
    "ticket.void_line" -> "Line voided"
    "ticket.update_meta" -> "Order details changed"
    "ticket.move_lines" -> "Lines moved to another order"
    "ticket.merge" -> "Orders merged"
    "receipt.create" -> "Payment"
    "refund.create" -> "Refund"
    "ticket.send" -> "Order sent to the kitchen"
    "ticket.split_line" -> "Line divided between checks"
    "ticket.place_lines" -> "Items moved to a seat or a course"
    "ticket.stage" -> "Takeaway moved along the board"
    "ticket.cancel" -> "Order cancelled"
    "kitchen.mark" -> "Kitchen display: a line ticked or a ticket bumped"
    "booking.upsert" -> "Booking"
    "item.set_available" -> "Item marked sold out or back on sale"
    "item.set_price" -> "Item price changed"
    "customer.upsert" -> "Customer"
    "payment.correct" -> "Payment type corrected"
    "shift.open" -> "Day opened"
    "shift.close" -> "Day closed (the drawer's count)"
    "day.close" -> "Day closing"
    "cash.move" -> "Cash in or out"
    "deposit.create" -> "Deposit taken"
    "deposit.pay" -> "Payment on a deposit"
    "deposit.cancel" -> "Deposit cancelled"
    "deposit.give_back" -> "Money given back on a deposit"
    "account.pay" -> "Payment on a customer account"
    "drawer.count" -> "Drawer count"
    "timeclock.punch" -> "Clock in or out"
    else -> type
}

private fun why(code: String?): String = when (code) {
    "forbidden" -> "This login is not allowed to do that."
    "refund-policy" -> "This shop does not give money back: it exchanges. Check Returns on POS settings in the back office."
    "not-entitled" -> "Deposits are an extra this shop does not have yet. Ask EasyPay to add them. Money already taken was kept."
    "bad-deposit" -> "That deposit does not exist on the server: the operation that took it may have been refused first."
    "bad-account" -> "The server did not take this account payment: its customer, or how it was split over the bills, did not add up."
    "ticket-closed" -> "The order was already closed."
    "bad-ticket" -> "The order does not exist on the server."
    "unknown-item" -> "The item no longer exists."
    "unknown-variant" -> "That size or variant no longer exists."
    "bad-modifier" -> "An option on the item no longer exists."
    "bad-line", "paid-line" -> "The line was already paid or removed."
    "bad-payment", "bad-change" -> "The payment details were not valid."
    "bad-discount", "approval-required" -> "The discount was not allowed."
    "bad-qty" -> "More was refunded than was sold."
    "bad-device" -> "This till is not registered for the store."
    "conflict" -> "The server already has a different record with the same number."
    "already-refunded" -> "The receipt was already refunded."
    "shift-closed" -> "The day was already closed."
    "bad-shift" -> "The day does not exist on the server."
    "bad-employee" -> "That member of staff is not known to the server."
    "bad-store" -> "This till's store is not known to the server."
    "bad-payload" -> "The server did not understand it. Check that the till is up to date."
    "unknown-op" -> "The server is older than this till and does not know this kind of change yet. Contact EasyPay."
    "error", null -> "The server could not process it."
    else -> code
}

@Composable
fun RejectedScreen(vm: RejectedViewModel = hiltViewModel(), onBack: () -> Unit) {
    val rows by vm.rows.collectAsStateWithLifecycle()
    var removing by remember { mutableStateOf<OutboxEntity?>(null) }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Rejected changes", style = MaterialTheme.typography.headlineSmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (rows.size > 1) OutlinedButton(onClick = { vm.again(rows) }) { Text("Send all again") }
                Button(onClick = onBack) { Text("Back") }
            }
        }
        Text("The server refused these. Once what is said is put right, send them again: they go up in the order they were made. Tell a manager before removing one.")
        if (rows.isEmpty()) Text("Nothing here.")
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(rows, key = { it.op_id }) { row ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column(Modifier.weight(1f)) {
                            Text(what(row.type))
                            Text(why(row.last_error), color = MaterialTheme.colorScheme.error)
                            Text(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(row.created_at)))
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Button(onClick = { vm.again(listOf(row)) }) { Text("Send again") }
                            OutlinedButton(onClick = { removing = row }) { Text("Remove") }
                        }
                    }
                }
            }
        }
    }
    removing?.let { row ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove for good?") },
            text = { Text("${what(row.type)} will then never reach the server: it stays on this tablet only, and the back office and its reports will not have it. Send it again instead once what was refused is put right.") },
            confirmButton = { Button(onClick = { vm.dismiss(row.op_id); removing = null }) { Text("Remove") } },
            dismissButton = { OutlinedButton(onClick = { removing = null }) { Text("Keep it") } },
        )
    }
}

package com.restopos.feature.customers

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.CustomerEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.ui.Avatar
import com.restopos.core.ui.HeadCell
import com.restopos.core.ui.Hairline
import com.restopos.core.ui.Pos
import com.restopos.core.ui.card
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// The restaurant's customers, on this tablet: found by name, phone or email,
// and made or changed here. They are the same on every till.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class CustomersViewModel @Inject constructor(
    private val db: TillDatabase,
    private val tickets: TicketRepository,
) : ViewModel() {
    private val query = MutableStateFlow("")
    val rows: StateFlow<List<CustomerEntity>> = query
        .flatMapLatest { db.customers().search(it.trim()) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun messageShown() { _message.value = null }

    fun search(text: String) { query.value = text }

    fun save(id: String?, name: String, phone: String, email: String, note: String, then: (CustomerEntity) -> Unit) = viewModelScope.launch {
        tickets.saveCustomer(id, name, phone, email, note).fold(
            onSuccess = { then(it) },
            onFailure = { _message.value = it.message },
        )
    }
}

// The Customers tab: everyone the restaurant knows, with a search and New
// customer. Tap one to change their details.
@Composable
fun CustomersScreen(vm: CustomersViewModel = hiltViewModel()) {
    val rows by vm.rows.collectAsState()
    val message by vm.message.collectAsState()
    var typed by remember { mutableStateOf("") }
    // the customer being made (blank) or changed
    var form by remember { mutableStateOf<CustomerEntity?>(null) }
    var adding by remember { mutableStateOf(false) }
    message?.let { m -> LaunchedEffect(m) { delay(4000); vm.messageShown() } }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize().padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    typed, { typed = it.take(60); vm.search(typed) }, Modifier.weight(1f),
                    placeholder = { Text("Search by name, phone or email") }, singleLine = true,
                )
                Box(
                    Modifier.height(48.dp).clip(RoundedCornerShape(24.dp)).background(Pos.TabOn).clickable { adding = true }.padding(horizontal = 22.dp),
                    contentAlignment = Alignment.Center,
                ) { Text("New customer", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold) }
            }
            Column(Modifier.weight(1f, fill = false).fillMaxWidth().card()) {
                Row(Modifier.fillMaxWidth().background(Pos.PanelDeep).padding(horizontal = 12.dp)) {
                    HeadCell("Name", 1.6f)
                    HeadCell("Phone", 1f)
                    HeadCell("Email", 1.4f)
                    HeadCell("Note", 1.6f)
                }
                Hairline()
                if (rows.isEmpty()) {
                    Column(Modifier.fillMaxWidth().padding(vertical = 44.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (typed.isBlank()) "No customers yet" else "No customer matches that", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        Text("Tap New customer to add one. They can also be added in the back office.", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 13.sp)
                    }
                }
                LazyColumn {
                    items(rows, key = { it.id }) { c ->
                        Row(Modifier.fillMaxWidth().clickable { form = c }.padding(horizontal = 12.dp).height(56.dp), verticalAlignment = Alignment.CenterVertically) {
                            Row(Modifier.weight(1.6f).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                                Avatar(c.name, 28.dp)
                                Text(c.name, Modifier.padding(start = 10.dp), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Text(c.phone ?: "", Modifier.weight(1f).padding(horizontal = 8.dp), color = Pos.Text, fontSize = 15.sp, maxLines = 1)
                            Text(c.email ?: "", Modifier.weight(1.4f).padding(horizontal = 8.dp), color = Pos.Text, fontSize = 15.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(c.note ?: "", Modifier.weight(1.6f).padding(horizontal = 8.dp), color = Pos.Text2, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Hairline(Modifier.padding(horizontal = 20.dp))
                    }
                }
            }
            Text("To put a customer on an order, tap Assign customer on the register.", Modifier.padding(horizontal = 6.dp), color = Pos.Text3, fontSize = 12.sp)
        }
        message?.let {
            Text(
                it, Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp)).background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }

    if (adding || form != null) {
        CustomerForm(form, onDismiss = { adding = false; form = null }) { name, phone, email, note ->
            vm.save(form?.id, name, phone, email, note) { adding = false; form = null }
        }
    }
}

// Assign customer, on the register: find one, or make one, and the order is
// for them. `current` is the customer already on the order.
@Composable
fun CustomerPicker(current: String?, vm: CustomersViewModel = hiltViewModel(), onDismiss: () -> Unit, onPick: (String?) -> Unit) {
    val rows by vm.rows.collectAsState()
    val message by vm.message.collectAsState()
    var typed by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { vm.search("") }
    if (adding) {
        CustomerForm(null, startName = typed, onDismiss = { adding = false }) { name, phone, email, note ->
            vm.save(null, name, phone, email, note) { made -> adding = false; onPick(made.id) }
        }
        return
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Who is this order for?") },
        text = {
            Column(Modifier.width(460.dp)) {
                OutlinedTextField(
                    typed, { typed = it.take(60); vm.search(typed) }, Modifier.fillMaxWidth(),
                    placeholder = { Text("Search by name, phone or email") }, singleLine = true,
                )
                message?.let { Text(it, Modifier.padding(top = 6.dp), color = Pos.Pink, fontSize = 13.sp) }
                LazyColumn(Modifier.fillMaxWidth().padding(top = 8.dp).heightIn(max = 300.dp)) {
                    items(rows, key = { it.id }) { c ->
                        Row(Modifier.fillMaxWidth().clickable { onPick(c.id) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(c.name, 28.dp)
                            Column(Modifier.weight(1f).padding(start = 10.dp)) {
                                Text(c.name + if (c.id == current) "  ✓" else "", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                val sub = listOfNotNull(c.phone, c.email).joinToString(" · ")
                                if (sub.isNotBlank()) Text(sub, color = Pos.Text3, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                        }
                        Hairline()
                    }
                }
                if (rows.isEmpty()) Text(if (typed.isBlank()) "No customers yet." else "Nobody matches that.", Modifier.padding(top = 8.dp), color = Pos.Text3, fontSize = 14.sp)
            }
        },
        confirmButton = { Button(onClick = { adding = true }) { Text("New customer") } },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (current != null) OutlinedButton(onClick = { onPick(null) }) { Text("Take off the order", color = Pos.Pink) }
                OutlinedButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
    )
}

@Composable
private fun CustomerForm(initial: CustomerEntity?, startName: String = "", onDismiss: () -> Unit, onSave: (String, String, String, String) -> Unit) {
    var name by remember { mutableStateOf(initial?.name ?: startName) }
    var phone by remember { mutableStateOf(initial?.phone ?: "") }
    var email by remember { mutableStateOf(initial?.email ?: "") }
    var note by remember { mutableStateOf(initial?.note ?: "") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (initial == null) "New customer" else "Customer") },
        text = {
            Column(Modifier.width(420.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it.take(120) }, Modifier.fillMaxWidth(), label = { Text("Name") }, singleLine = true)
                OutlinedTextField(phone, { phone = it.take(40) }, Modifier.fillMaxWidth(), label = { Text("Phone") }, singleLine = true)
                OutlinedTextField(email, { email = it.take(120) }, Modifier.fillMaxWidth(), label = { Text("Email") }, singleLine = true)
                OutlinedTextField(note, { note = it.take(200) }, Modifier.fillMaxWidth(), label = { Text("Note (allergies, what they like)") })
            }
        },
        confirmButton = { Button(enabled = name.isNotBlank(), onClick = { onSave(name, phone, email, note) }) { Text("Save") } },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

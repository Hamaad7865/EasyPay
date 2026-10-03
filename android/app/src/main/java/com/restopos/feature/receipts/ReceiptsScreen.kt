package com.restopos.feature.receipts

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class ReceiptsViewModel @Inject constructor(
    private val tickets: TicketRepository,
    private val session: SessionStore,
) : ViewModel() {
    private val _rows = MutableStateFlow<List<ReceiptEntity>>(emptyList())
    val rows: StateFlow<List<ReceiptEntity>> = _rows

    init {
        viewModelScope.launch {
            val store = session.storeId() ?: return@launch
            tickets.receipts(store).collect { _rows.value = it }
        }
    }
}

@Composable
fun ReceiptsScreen(vm: ReceiptsViewModel = hiltViewModel(), onBack: () -> Unit) {
    val rows by vm.rows.collectAsState()
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Receipts")
            Button(onClick = onBack) { Text("Back") }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(rows, key = { it.id }) { r ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(r.number)
                            Text(Money.format(r.total))
                        }
                        if (r.type == "refund") Text("Refund")
                        if (r.needs_review) Text("Needs review")
                    }
                }
            }
        }
    }
}

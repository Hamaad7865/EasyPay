package com.restopos.feature.receipts

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.ReceiptEntity
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Pos
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
fun ReceiptsScreen(vm: ReceiptsViewModel = hiltViewModel()) {
    val rows by vm.rows.collectAsState()
    Column(Modifier.fillMaxSize().background(Pos.Bg).padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Receipts", color = Pos.Text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        Text("Receipts issued on this tablet, newest first.", color = Pos.Text3, fontSize = 12.sp)
        if (rows.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("No receipts yet.", color = Pos.Text3, fontSize = 14.sp)
            }
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(rows, key = { it.id }) { r ->
                Row(
                    Modifier.fillMaxWidth().background(Pos.Panel).padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(r.number, color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
                        if (r.type == "refund") Text("Refund", color = Pos.Text2, fontSize = 12.sp)
                        if (r.needs_review) Text("Needs review", color = Pos.Pink, fontSize = 12.sp)
                    }
                    Text(Money.format(r.total), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

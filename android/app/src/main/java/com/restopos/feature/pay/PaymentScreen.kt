package com.restopos.feature.pay

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restopos.core.common.Money

@Composable
fun PaymentScreen(vm: PaymentViewModel = hiltViewModel(), onDone: (String, Long, Long) -> Unit, onBack: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    when (val s = state) {
        PayUiState.Loading -> CircularProgressIndicator(Modifier.padding(24.dp))
        is PayUiState.Done -> {
            LaunchedEffect(s.receipt.id) { onDone(s.receipt.id, s.change, s.receipt.total) }
            CircularProgressIndicator(Modifier.padding(24.dp))
        }
        is PayUiState.Ready -> Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            s.notice?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
            // Splitting the bill: untick what another guest will pay.
            if (s.lines.size > 1) {
                Text("Tick the lines this payment covers")
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState())) {
                    s.lines.forEach { line ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(checked = line.selected, onCheckedChange = { vm.toggle(line.id) })
                            Text(line.name, Modifier.weight(1f))
                            Text(Money.format(line.amount))
                        }
                    }
                }
            }
            Text("Due ${Money.format(s.due)}", style = MaterialTheme.typography.headlineSmall)
            s.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(s.methods, key = { it.id }) { m ->
                    if (m.id == s.selected?.id) Button(onClick = { vm.select(m) }) { Text(m.name) }
                    else OutlinedButton(onClick = { vm.select(m) }) { Text(m.name) }
                }
            }
            val m = s.selected
            if (m != null && m.kind == "cash") {
                OutlinedTextField(s.tenderedRs, { vm.tendered(it) }, label = { Text("Tendered Rs") }, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("Exact", "500", "1000", "2000").forEach { q ->
                        OutlinedButton(onClick = { vm.tendered(if (q == "Exact") "" else q) }) { Text(q) }
                    }
                }
                Button(onClick = { vm.takeCash() }, Modifier.fillMaxWidth()) { Text("Take cash") }
            } else if (m != null) {
                OutlinedTextField(s.reference, { vm.reference(it) }, Modifier.fillMaxWidth(), label = { Text("Reference (optional)") }, singleLine = true)
                Button(onClick = { vm.takeMethod() }, Modifier.fillMaxWidth()) {
                    Text("Charge ${Money.format(s.due)}")
                }
            }
            OutlinedButton(onClick = onBack) { Text("Back to order") }
        }
    }
}

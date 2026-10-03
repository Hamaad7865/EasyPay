package com.restopos.feature.pay

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.restopos.core.common.Money

// Result screen (spec 7.5): change due, print/email (Phase 3/ later), new sale.
@Composable
fun ReceiptDoneScreen(change: Long, total: Long, onPrint: () -> Unit, onNewSale: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Paid ${Money.format(total)}")
        if (change > 0) Text("Change due ${Money.format(change)}")
        Button(onClick = onPrint, Modifier.fillMaxWidth()) { Text("Print receipt (Phase 3)") }
        OutlinedButton(onClick = onNewSale, Modifier.fillMaxWidth()) { Text("New sale") }
    }
}

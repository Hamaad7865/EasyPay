package com.restopos.feature.pay

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.ui.Pos

// Result screen (spec 7.5): what was paid and the change to hand back.
// Printing arrives with the printer work; the button is there but off.
@Composable
fun ReceiptDoneScreen(change: Long, total: Long, onPrint: () -> Unit, onNewSale: () -> Unit) {
    Column(
        Modifier.fillMaxSize().background(Pos.Bg).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Paid ${Money.format(total)}", color = Pos.Text2, fontSize = 20.sp)
        if (change > 0) {
            Text("Change due", color = Pos.Text2, fontSize = 16.sp)
            Text(Money.format(change), color = Pos.Text, fontSize = 56.sp, fontWeight = FontWeight.Bold)
        } else {
            Text("No change due", color = Pos.Text, fontSize = 32.sp, fontWeight = FontWeight.Bold)
        }
        Button(onClick = onNewSale, Modifier.padding(top = 16.dp).width(320.dp).height(56.dp)) { Text("New sale", fontSize = 18.sp) }
        OutlinedButton(onClick = onPrint, Modifier.width(320.dp), enabled = false) { Text("Print receipt (not available yet)") }
    }
}

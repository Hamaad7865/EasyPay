package com.restopos.feature.staff

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.restopos.core.common.Money
import com.restopos.core.ui.Pos
import com.restopos.feature.more.MoreViewModel
import kotlinx.coroutines.delay
import java.text.DateFormat
import java.util.Date

private val GREEN = Color(0xFF3FBF7F)

// The cash count. Opening a shift: confirm what is in the drawer.
// Closing one: enter what was counted (the expected amount is not shown until
// after, so the count is honest), then see how it compares. Counting during a
// shift (a handover) is the same count, and the shift stays open.
@Composable
fun CashCountScreen(closing: Boolean, counting: Boolean = false, vm: StaffViewModel = hiltViewModel(), onBack: () -> Unit, onDone: () -> Unit) {
    // closing and counting are both counted blind
    val suggested by vm.suggested.collectAsState()
    val shift by vm.shift.collectAsState()
    val current by vm.current.collectAsState()
    val message by vm.message.collectAsState()
    val result by vm.closing.collectAsState()
    val openOrders by vm.openOrders.collectAsState()
    // closing the day comes after closing the shift, on the same screen
    val more: MoreViewModel = hiltViewModel()
    val dayNote by more.message.collectAsState()
    val dayBusy by more.busy.collectAsState()
    var dayClosed by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf<String?>(null) } // null = nothing typed yet
    message?.let { m -> LaunchedEffect(m) { delay(4000); vm.messageShown() } }
    // once the period is closed there is no register to go back to
    BackHandler(enabled = result != null) { onDone() }

    // opening offers what the drawer was left with last time; closing starts empty
    val blind = closing || counting
    val shown = typed ?: if (blind || suggested == 0L) "" else (suggested / 100).toString() + if (suggested % 100 == 0L) "" else ".%02d".format(suggested % 100)
    val amount = if (shown.isEmpty()) 0L else Money.parseRs(shown)
    val now = remember { DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT) }

    Box(Modifier.fillMaxSize().background(Pos.Bg)) {
        Column(Modifier.fillMaxSize()) {
            StaffTopBar(if (counting) "Count the drawer" else if (closing) "Close sales period" else "Cash count for cash drawer", if (result == null) onBack else null)
            Row(Modifier.fillMaxSize().padding(horizontal = 48.dp, vertical = 28.dp), horizontalArrangement = Arrangement.spacedBy(64.dp)) {
                Column(Modifier.weight(1f).fillMaxHeight()) {
                    val done = result
                    if (done != null) {
                        Text(if (counting) "Drawer counted. The sales period stays open." else "Sales period closed.", color = Pos.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                        Text("How the drawer compares with what it should hold.", Modifier.padding(top = 10.dp, bottom = 18.dp), color = Pos.Text, fontSize = 14.sp)
                        Line("Opening amount", Money.format(done.float))
                        Line("Cash taken, with cash in and out", Money.format(done.cash))
                        Line("Expected in the drawer", Money.format(done.expected))
                        Line("Counted", Money.format(done.counted))
                        val diff = done.counted - done.expected
                        Line(
                            "Difference",
                            when {
                                diff == 0L -> "None"
                                diff > 0 -> "${Money.format(diff)} over"
                                else -> "${Money.format(-diff)} short"
                            },
                            color = if (diff == 0L) GREEN else Pos.Pink,
                        )
                        Spacer(Modifier.weight(1f))
                        // Last shift of the day: the day closing (Z) is done from here,
                        // because the next sign-in opens a new shift.
                        if (!counting) {
                            Text(
                                dayNote ?: "Is this the last sales period of the day? Closing the day fixes the day's figures and prints the closing report.",
                                Modifier.padding(bottom = 10.dp), color = if (dayNote != null) Pos.Text else Pos.Text3, fontSize = 13.sp,
                            )
                            if (!dayClosed) {
                                Box(
                                    Modifier.fillMaxWidth().height(50.dp).padding(bottom = 8.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Key)
                                        .clickable(enabled = !dayBusy) { more.closeDay { dayClosed = true } },
                                    contentAlignment = Alignment.Center,
                                ) { Text("Close the day and print", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium) }
                            }
                        }
                        Confirm("Done", enabled = true, onDone)
                    } else {
                        Text(if (blind) "Count the cash." else "Confirm cash amount.", color = Pos.Text, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                        Text(
                            if (counting) "Count the cash in this till's drawer and enter the amount. You will see how it compares after you confirm. A slip prints for the handover, and the sales period stays open."
                            else if (closing) "Count the cash in this till's drawer and enter the amount. You will see how it compares after you confirm."
                            else "Enter the cash that is in this till's drawer now. Each till has its own amount.",
                            Modifier.padding(top = 10.dp, bottom = 18.dp), color = Pos.Text, fontSize = 14.sp,
                        )
                        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(3.dp)).background(Pos.Panel).padding(14.dp), contentAlignment = Alignment.Center) {
                            Text(
                                if (blind) "Open since ${shift?.let { now.format(Date(it.opened_at)) } ?: "—"}" else "Sales period starts ${now.format(Date())}",
                                color = GREEN, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                            )
                        }
                        Row(Modifier.fillMaxWidth().padding(top = 4.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Panel).padding(14.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text("Payment method", color = Pos.Text3, fontSize = 12.sp)
                                Text("Cash", color = Pos.Text, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                            }
                            Column(Modifier.weight(1f)) {
                                Text(if (blind) "Counted" else "Total", color = Pos.Text3, fontSize = 12.sp)
                                Text(
                                    if (shown.isEmpty()) "Rs 0" else "Rs $shown",
                                    color = if (amount == null) Pos.Pink else Pos.Text, fontSize = 18.sp, fontWeight = FontWeight.Bold,
                                )
                            }
                        }
                        if (closing && openOrders > 0) {
                            Text(
                                "$openOrders ${if (openOrders == 1L) "order is" else "orders are"} still open. They stay open for the next sales period.",
                                Modifier.padding(top = 14.dp), color = Pos.Pink, fontSize = 13.sp,
                            )
                        }
                        current?.let {
                            Text("Signed in: ${it.employee.name}", Modifier.padding(top = 14.dp), color = Pos.Text3, fontSize = 13.sp)
                        }
                        Spacer(Modifier.weight(1f))
                        Confirm(if (blind) "Confirm counted cash" else "Confirm cash amount", enabled = amount != null) {
                            val value = amount ?: return@Confirm
                            if (counting) vm.count(value) else if (closing) vm.close(value) else vm.open(value, onDone)
                        }
                    }
                }
                BoxWithConstraints(Modifier.weight(1f).fillMaxHeight()) {
                    if (result == null) {
                        val keyHeight = (maxHeight / 5).coerceIn(40.dp, 72.dp)
                        AmountPad(shown, keyHeight, Modifier.fillMaxWidth().align(Alignment.Center)) { typed = it }
                    }
                }
            }
        }
        message?.let { m ->
            Text(
                m,
                Modifier.align(Alignment.BottomCenter).padding(16.dp).clip(RoundedCornerShape(6.dp))
                    .background(Pos.Text).padding(horizontal = 16.dp, vertical = 10.dp),
                color = Pos.Bg, fontSize = 14.sp,
            )
        }
    }
}

@Composable
private fun Line(label: String, value: String, color: Color = Pos.Text) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Panel).padding(horizontal = 14.dp, vertical = 12.dp)) {
        Text(label, Modifier.weight(1f), color = Pos.Text2, fontSize = 15.sp)
        Text(value, color = color, fontSize = 16.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun Confirm(label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().height(58.dp).clip(RoundedCornerShape(3.dp)).background(if (enabled) Pos.Blue else Pos.Key)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Text(label, color = if (enabled) Color.White else Pos.Text3, fontSize = 16.sp, fontWeight = FontWeight.Bold) }
}

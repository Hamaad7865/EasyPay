package com.restopos.feature.pay

import android.os.SystemClock
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.restopos.core.common.Money
import com.restopos.core.database.PaymentTypeEntity
import com.restopos.core.ui.Pos
import com.restopos.feature.staff.AmountPad

// What Pay on the register opens: the order on the left, the payment types in
// the middle, and on the right what is being paid, what was received, the
// change and the Pay button.
@Composable
fun PaymentScreen(vm: PaymentViewModel = hiltViewModel(), onDone: (String, Long, Long) -> Unit, onBack: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val ready = state as? PayUiState.Ready
    // one check of a split check was paid and others remain: back to the checks
    val checkPaid by vm.checkPaid.collectAsStateWithLifecycle()
    if (checkPaid) LaunchedEffect(Unit) { onBack() }
    // Leaving with shares taken: the money is in hand but nothing is recorded
    // yet, so the cashier is asked first.
    var leaving by remember { mutableStateOf(false) }
    val taken = ready?.shares.orEmpty()
    val leave = { if (taken.isEmpty()) onBack() else leaving = true }
    BackHandler(enabled = taken.isNotEmpty()) { leaving = true }
    if (leaving) {
        AlertDialog(
            onDismissRequest = { leaving = false },
            title = { Text("Give the money back?") },
            text = { Text("${Money.format(taken.sumOf { it.input.amount })} has been taken for this bill and is not recorded yet. If you leave now, give it back: the bill stays unpaid.") },
            confirmButton = { Button(onClick = { leaving = false; vm.dropShares(); onBack() }) { Text("Leave, bill unpaid") } },
            dismissButton = { OutlinedButton(onClick = { leaving = false }) { Text("Stay and finish") } },
        )
    }
    Column(Modifier.fillMaxSize().background(Pos.Bg)) {
        Box(Modifier.fillMaxWidth().height(48.dp).background(Pos.Panel)) {
            Text(
                "Cancel", Modifier.align(Alignment.CenterStart).clickable(onClick = leave).padding(horizontal = 16.dp, vertical = 12.dp),
                color = Pos.Pink, fontSize = 15.sp,
            )
            if (ready != null) {
                Text(
                    "${ready.title} (${Money.format(ready.due)})", Modifier.align(Alignment.Center).padding(horizontal = 120.dp),
                    color = Pos.Text, fontSize = 16.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        when (val s = state) {
            PayUiState.Loading -> Busy()
            is PayUiState.Done -> {
                LaunchedEffect(s.receipt.id) { onDone(s.receipt.id, s.change, s.receipt.total) }
                Busy()
            }
            is PayUiState.Ready -> Ready(s, vm)
        }
    }
}

@Composable
private fun Busy() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}

@Composable
private fun Ready(s: PayUiState.Ready, vm: PaymentViewModel) {
    val cash = s.selected?.kind == "cash"
    val now = s.now // what this payment is for: the whole bill, or a share of it
    val received = if (cash) s.tendered ?: now else now
    var custom by remember { mutableStateOf(false) }
    var part by remember { mutableStateOf(false) } // typing an amount for this payment
    // Pay here sits where Pay on the register was: a double tap there must not
    // take the payment, so the button ignores the first moment on screen.
    val shownAt = remember { SystemClock.elapsedRealtime() }
    Row(Modifier.fillMaxSize().padding(6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Summary(Modifier.weight(1.15f).fillMaxHeight(), s) { vm.toggle(it) }
        Methods(Modifier.weight(0.62f).fillMaxHeight(), s) { vm.select(it) }
        Column(Modifier.weight(1.05f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Panel(
                "Payment amount", Money.format(now),
                when {
                    s.shares.isNotEmpty() || s.ways > 1 || s.custom != null -> "Of ${Money.format(s.due)}. ${Money.format(s.remaining - now)} is left after this payment."
                    s.lines.size > 1 -> "The lines ticked in the order summary"
                    else -> "The whole bill"
                },
            ) {
                // Split the bill: evenly between a number of guests, or an amount typed in.
                Row(Modifier.fillMaxWidth().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Split evenly", Modifier.weight(1f), color = Pos.Text2, fontSize = 13.sp)
                    Key("−", false, Modifier.width(44.dp)) { vm.ways(s.ways - 1) }
                    Text(if (s.ways > 1) "${s.ways} ways" else "No", Modifier.width(64.dp), color = Pos.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
                    Key("+", false, Modifier.width(44.dp)) { vm.ways(s.ways + 1) }
                    Key(if (s.custom != null) "Whole" else "Amount", s.custom != null, Modifier.width(84.dp)) { if (s.custom != null) vm.custom(null) else part = true }
                }
                s.shares.forEach { sh ->
                    Row(Modifier.fillMaxWidth().padding(top = 6.dp)) {
                        Text("Taken: ${sh.type}", Modifier.weight(1f), color = Pos.Ok, fontSize = 13.sp)
                        Text(Money.format(sh.input.amount), color = Pos.Ok, fontSize = 13.sp)
                    }
                }
            }
            Panel("Received amount", Money.format(received), if (cash) null else "Paid by ${s.selected?.name ?: "this type"}") {
                if (cash) {
                    val quick = quickAmounts(now)
                    val keys = listOf(Quick("Custom", s.tendered != null && s.tendered !in quick) { custom = true }) +
                        Quick(Money.format(now), s.tendered == null) { vm.tendered(null) } +
                        quick.map { a -> Quick(Money.format(a), s.tendered == a) { vm.tendered(a) } }
                    keys.chunked(3).forEach { row ->
                        Row(Modifier.fillMaxWidth().padding(top = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            row.forEach { k -> Key(k.label, k.on, Modifier.weight(1f), k.tap) }
                            repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                } else {
                    BasicTextField(
                        value = s.reference,
                        onValueChange = { vm.reference(it) },
                        modifier = Modifier.fillMaxWidth().padding(top = 10.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Key)
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                        singleLine = true,
                        textStyle = TextStyle(color = Pos.Text, fontSize = 15.sp),
                        cursorBrush = SolidColor(Pos.Text),
                        decorationBox = { inner ->
                            if (s.reference.isEmpty()) Text("Reference (optional)", color = Pos.Text3, fontSize = 15.sp)
                            inner()
                        },
                    )
                }
            }
            BasicTextField(
                value = s.note,
                onValueChange = { vm.note(it) },
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).background(Pos.Panel).padding(horizontal = 14.dp, vertical = 14.dp),
                singleLine = true,
                textStyle = TextStyle(color = Pos.Text, fontSize = 15.sp),
                cursorBrush = SolidColor(Pos.Text),
                decorationBox = { inner ->
                    if (s.note.isEmpty()) Text("Remark for the kitchen and the receipt (optional)", color = Pos.Text3, fontSize = 15.sp)
                    inner()
                },
            )
            Spacer(Modifier.weight(1f))
            s.notice?.let { Text(it, Modifier.padding(horizontal = 4.dp), color = Pos.Link, fontSize = 13.sp) }
            s.error?.let { Text(it, Modifier.padding(horizontal = 4.dp), color = Pos.Pink, fontSize = 13.sp) }
            Panel("Change", Money.format((received - now).coerceAtLeast(0)), null)
            Box(
                Modifier.fillMaxWidth().height(50.dp).clip(RoundedCornerShape(3.dp)).background(Pos.Green)
                    .clickable { if (SystemClock.elapsedRealtime() - shownAt > 700) vm.pay() },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    (if (now < s.remaining) "Take this share - " else "Pay - ") + Money.format(now),
                    color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium,
                )
            }
        }
    }
    if (part) {
        var typed by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { part = false },
            title = { Text("Amount for this payment") },
            text = {
                Column {
                    Text("Up to ${Money.format(s.remaining)}. The rest stays to pay.", Modifier.padding(bottom = 8.dp), color = Pos.Text2, fontSize = 13.sp)
                    Text(
                        "Rs ${typed.ifEmpty { "0" }}", Modifier.fillMaxWidth().padding(bottom = 12.dp),
                        color = Pos.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End,
                    )
                    AmountPad(typed, 48.dp, Modifier.fillMaxWidth()) { typed = it }
                }
            },
            confirmButton = { Button(onClick = { Money.parseRs(typed)?.let { vm.custom(it) }; part = false }) { Text("OK") } },
            dismissButton = { OutlinedButton(onClick = { part = false }) { Text("Cancel") } },
        )
    }
    if (custom) {
        var typed by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { custom = false },
            title = { Text("Amount received") },
            text = {
                Column {
                    Text(
                        "Rs ${typed.ifEmpty { "0" }}", Modifier.fillMaxWidth().padding(bottom = 12.dp),
                        color = Pos.Text, fontSize = 26.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.End,
                    )
                    AmountPad(typed, 48.dp, Modifier.fillMaxWidth()) { typed = it }
                }
            },
            confirmButton = { Button(onClick = { Money.parseRs(typed)?.let { vm.tendered(it) }; custom = false }) { Text("OK") } },
            dismissButton = { OutlinedButton(onClick = { custom = false }) { Text("Cancel") } },
        )
    }
}

// The order as it will be paid. With more than one line, a tap leaves a line
// out for another guest's payment (splitting the bill by item).
@Composable
private fun Summary(modifier: Modifier, s: PayUiState.Ready, onToggle: (String) -> Unit) {
    val split = s.lines.size > 1
    val gross = s.lines.filter { it.selected }.sumOf { it.amount }
    Column(modifier.clip(RoundedCornerShape(4.dp)).background(Pos.Panel)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
            Text("Order summary", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            if (split) Text("Tap a line to leave it for another payment", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 12.sp)
        }
        Rule()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            s.lines.forEach { line ->
                Row(
                    Modifier.fillMaxWidth().clickable(enabled = split) { onToggle(line.id) }.alpha(if (line.selected) 1f else 0.45f)
                        .padding(horizontal = 16.dp, vertical = 13.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (split) {
                        Box(Modifier.padding(end = 10.dp).size(18.dp), contentAlignment = Alignment.Center) {
                            if (line.selected) Icon(Icons.Filled.Check, contentDescription = "In this payment", tint = Pos.Ok, modifier = Modifier.size(18.dp))
                        }
                    }
                    Text(
                        "${qtyText(line.qty)} ${line.name}", Modifier.weight(1f),
                        color = Pos.Text, fontSize = 15.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                    Text(Money.format(line.amount), color = Pos.Text2, fontSize = 14.sp)
                }
                Rule()
            }
        }
        Rule()
        if (gross != s.due) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(top = 12.dp)) {
                Text("Discount", Modifier.weight(1f), color = Pos.Text2, fontSize = 14.sp)
                Text("- ${Money.format(gross - s.due)}", color = Pos.Text2, fontSize = 14.sp)
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp)) {
            Text("Total", Modifier.weight(1f), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(Money.format(s.due), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium)
        }
    }
}

// The payment types set in the back office, grouped by kind.
@Composable
private fun Methods(modifier: Modifier, s: PayUiState.Ready, onPick: (PaymentTypeEntity) -> Unit) {
    val groups = listOf(
        "Cash" to s.methods.filter { it.kind == "cash" },
        "Cards" to s.methods.filter { it.kind == "card" },
        "Other" to s.methods.filter { it.kind != "cash" && it.kind != "card" },
    ).filter { it.second.isNotEmpty() }
    Column(modifier.clip(RoundedCornerShape(4.dp)).background(Pos.Panel)) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 14.dp)) {
            Text("Payment methods", color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text("Select a type to continue", Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 12.sp)
        }
        Rule()
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 6.dp, vertical = 8.dp)) {
            if (groups.isEmpty()) Text("No payment type has been downloaded yet.", Modifier.padding(6.dp), color = Pos.Text3, fontSize = 13.sp)
            groups.forEach { (label, types) ->
                Text(label, Modifier.padding(start = 6.dp, top = 8.dp, bottom = 6.dp), color = Pos.Text3, fontSize = 12.sp)
                types.chunked(2).forEach { row ->
                    Row(Modifier.fillMaxWidth().padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        row.forEach { m -> Key(m.name, m.id == s.selected?.id, Modifier.weight(1f)) { onPick(m) } }
                        repeat(2 - row.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun Panel(title: String, value: String, hint: String?, content: (@Composable ColumnScope.() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).background(Pos.Panel).padding(horizontal = 14.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f), color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            Text(value, color = Pos.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        }
        if (hint != null) Text(hint, Modifier.padding(top = 2.dp), color = Pos.Text3, fontSize = 12.sp)
        content?.invoke(this)
    }
}

private class Quick(val label: String, val on: Boolean, val tap: () -> Unit)

@Composable
private fun Key(label: String, on: Boolean, modifier: Modifier, onTap: () -> Unit) {
    Box(
        modifier.height(44.dp).clip(RoundedCornerShape(3.dp)).background(if (on) Pos.TabOn else Pos.Key).clickable(onClick = onTap),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            label, Modifier.padding(horizontal = 4.dp), color = if (on) Color.White else Pos.Text, fontSize = 13.sp,
            fontWeight = if (on) FontWeight.Medium else FontWeight.Normal, textAlign = TextAlign.Center, maxLines = 2,
            overflow = TextOverflow.Ellipsis, lineHeight = 15.sp,
        )
    }
}

@Composable
private fun Rule() {
    Box(Modifier.fillMaxWidth().height(1.dp).background(Pos.Line))
}

// Quantities are thousandths: "2", or "1.5" for a weighed line.
private fun qtyText(qty: Int): String =
    if (qty % 1000 == 0) "${qty / 1000}" else "%.3f".format(qty / 1000.0).trimEnd('0')

// The notes a guest is likely to hand over for this amount: the next 50, 100,
// 200, 500, 1000 and 2000 above it.
private fun quickAmounts(due: Long): List<Long> =
    listOf(5_000L, 10_000L, 20_000L, 50_000L, 100_000L, 200_000L)
        .map { step -> (due + step - 1) / step * step }
        .filter { it > due }.distinct().sorted().take(6)

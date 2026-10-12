package com.restopos.feature.floor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Money
import com.restopos.core.common.tableLabel
import com.restopos.core.guest.Checked
import com.restopos.core.guest.GuestShown
import com.restopos.core.ui.Gap
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.press

// What a guest is told when an order is declined: the cashier picks one.
private val REASONS = listOf("Sorry, that is sold out.", "Sorry, the kitchen is closed for now.", "Please ask a member of staff.")

// a phone: the key on the top bar that opens these orders, and the mark on each of them
const val PHONE = "M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2zM11 18h2"

private fun ago(since: Long, now: Long): String {
    val m = ((now - since) / 60_000).coerceAtLeast(0)
    return if (m < 1) "just now" else "$m min ago"
}

// One line under a table's name in the list: how much was asked for, or that it cannot be taken.
internal fun guestSummary(checked: Checked): String = when (checked) {
    is Checked.Ready -> checked.lines.sumOf { it.qty }.let { n -> "$n item${if (n == 1) "" else "s"} · ${Money.format(checked.total)}" }
    is Checked.Fault -> "Cannot be taken as it is"
}

// The orders guests sent from the codes on their tables, waiting for an
// answer. The owner: "when clicking on the phone icon, it says table 1 placed
// order or something and then when clicking it shows order and to accept or
// decline". So the sheet opens on a list, one line to an order; a line opens
// that order, shown at the till's own names and prices, never the phone's.
// Accept puts it on its table's order and opens that order; Decline asks what
// the guest should be told. An order the menu can no longer take (a dish sold
// out since) says why, and can only be declined.
//
// standing: how the line to the ordering site stands, said under the list
// when it is worth saying. held: why an order cannot be accepted just now (a
// payment is under way: accepting would take the register to another order).
@Composable
internal fun GuestOrders(
    orders: List<GuestShown>, now: Long, onClose: () -> Unit, onAccept: (String) -> Unit, onDecline: (String, String) -> Unit,
    standing: String? = null, held: String? = null,
) {
    var openId by remember { mutableStateOf<String?>(null) }
    var declining by remember { mutableStateOf(false) }
    val open = orders.firstOrNull { it.id == openId }
    // Opened on orders, it closes once the last of them is answered: an empty
    // sheet left up would be under the cashier's finger when the next arrives.
    val had = remember { orders.isNotEmpty() }
    LaunchedEffect(orders.isEmpty()) { if (had && orders.isEmpty()) onClose() }
    Sheet(onDismiss = onClose, width = 640.dp) {
        if (open == null) {
            SheetHead("Orders from the tables", "Sent by guests from the code on their table. Nothing was paid on the phone.") { onClose() }
            if (orders.isEmpty()) T("No order is waiting.", 15.sp, 700, V.Text2)
            Column(Modifier.heightIn(max = 460.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                orders.forEach { o ->
                    Row(
                        Modifier.fillMaxWidth().press(0.98f) { declining = false; openId = o.id }.clip(RoundedCornerShape(14.dp)).background(V.Key).padding(horizontal = 16.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
                    ) {
                        Box(Modifier.size(40.dp).clip(CircleShape).background(V.GreenWash), contentAlignment = Alignment.Center) { VIcon(PHONE, 20.dp, V.GreenText) }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            T("${tableLabel(o.tableName)} placed an order", 17.sp, 800, lines = 2)
                            T(
                                ago(o.placedAt, now) + " · " + guestSummary(o.checked), 13.sp, 600,
                                if (o.checked is Checked.Fault) V.RedText else V.Text2,
                            )
                        }
                        VIcon(VI.Chevron, 20.dp, V.Text3)
                    }
                }
            }
            standing?.let { T(it, 13.sp, 600, V.Text3, lines = 4, height = 18.sp) }
        } else {
            val checked = open.checked
            SheetHead(tableLabel(open.tableName), "Ordered from the table, ${ago(open.placedAt, now)}. Nothing was paid on the phone.") { onClose() }
            Column(
                Modifier.fillMaxWidth().heightIn(max = 360.dp).clip(RoundedCornerShape(14.dp)).background(V.Key).verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                when (checked) {
                    is Checked.Ready -> {
                        checked.lines.forEach { l ->
                            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                T("${l.qty} ×", 15.sp, 700, V.Text2, Modifier.width(40.dp))
                                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                    T(l.item.name, 15.sp, 700, lines = 2)
                                    if (l.mods.isNotEmpty()) T(l.mods.joinToString(", ") { it.name }, 13.sp, 500, V.Text2, lines = 3)
                                    l.note?.let { T("Note: $it", 13.sp, 600, V.AmberText, lines = 4) }
                                }
                                T(Money.format(l.total), 14.sp, 600)
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            T("Total", 14.sp, 700, V.Text2)
                            Gap()
                            T(Money.format(checked.total), 16.sp, 800)
                        }
                    }
                    is Checked.Fault -> T(checked.why + " It cannot be taken as it is.", 14.sp, 600, V.RedText, lines = 3)
                }
            }
            if (declining) {
                T("What should the guest be told?", 14.sp, 700, V.Text2)
                val reasons = (if (checked is Checked.Fault) listOf("Sorry: " + checked.why) else emptyList()) + REASONS
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    reasons.forEach { r -> VBtn(r, Modifier.fillMaxWidth(), height = 46.dp, size = 14.sp) { declining = false; openId = null; onDecline(open.id, r) } }
                    VBtn("Back", Modifier.fillMaxWidth(), bg = V.Panel, height = 42.dp, size = 14.sp) { declining = false }
                }
            } else {
                if (held != null && checked is Checked.Ready) T(held, 13.sp, 600, V.AmberText, lines = 3, height = 18.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VBtn("Back", Modifier.weight(1f), bg = V.Panel, height = 54.dp, icon = VI.Back) { openId = null }
                    VBtn("Decline", Modifier.weight(1f), bg = V.RedWash, fg = V.RedText, height = 54.dp) { declining = true }
                    if (checked is Checked.Ready) VBtn("Accept", Modifier.weight(2f), bg = V.On, fg = V.OnText, height = 54.dp, weight = 800, enabled = held == null) { onAccept(open.id) }
                }
            }
        }
    }
}

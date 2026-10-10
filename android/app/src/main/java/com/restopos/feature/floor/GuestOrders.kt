package com.restopos.feature.floor

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
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

// What a guest is told when an order is declined: the cashier picks one.
private val REASONS = listOf("Sorry, that is sold out.", "Sorry, the kitchen is closed for now.", "Please ask a member of staff.")

private fun ago(since: Long, now: Long): String {
    val m = ((now - since) / 60_000).coerceAtLeast(0)
    return if (m < 1) "just now" else "$m min ago"
}

// The orders guests sent from the codes on their tables, waiting for an
// answer. Each is shown at the till's own names and prices, never the phone's.
// Accept puts it on its table's order and opens that order; Decline asks what
// the guest should be told. An order the menu can no longer take (a dish sold
// out since) says why, and can only be declined.
@Composable
internal fun GuestOrders(orders: List<GuestShown>, now: Long, onClose: () -> Unit, onAccept: (String) -> Unit, onDecline: (String, String) -> Unit) {
    var declining by remember { mutableStateOf<String?>(null) }
    Sheet(onDismiss = onClose, width = 640.dp) {
        SheetHead("Orders from the tables", "Sent by guests from the code on their table. Nothing was paid on the phone.") { onClose() }
        Column(Modifier.heightIn(max = 500.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            orders.forEach { o ->
                val checked = o.checked
                Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Key).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T(tableLabel(o.tableName), 18.sp, 800)
                        Gap()
                        T(ago(o.placedAt, now), 13.sp, 600, V.Text2)
                    }
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
                    if (declining == o.id) {
                        T("What should the guest be told?", 14.sp, 700, V.Text2)
                        val reasons = (if (checked is Checked.Fault) listOf("Sorry: " + checked.why) else emptyList()) + REASONS
                        // a shade off the card they sit on, which is a key's own colour: seen as flat words otherwise
                        reasons.forEach { r -> VBtn(r, Modifier.fillMaxWidth(), bg = V.Hover, height = 46.dp, size = 14.sp) { declining = null; onDecline(o.id, r) } }
                        VBtn("Back", Modifier.fillMaxWidth(), bg = V.Panel, height = 42.dp, size = 14.sp) { declining = null }
                    } else {
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            VBtn("Decline", Modifier.weight(1f), bg = V.RedWash, fg = V.RedText, height = 50.dp) { declining = o.id }
                            if (checked is Checked.Ready) VBtn("Accept", Modifier.weight(2f), bg = V.On, fg = V.OnText, height = 50.dp) { onAccept(o.id) }
                        }
                    }
                }
            }
        }
    }
}

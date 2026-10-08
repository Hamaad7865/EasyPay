package com.restopos.feature.menu

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.data.Approvals
import com.restopos.core.data.LinePrice
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StockForm
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.press
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

// One line of stock on the sheet: an item, or one variant of a product, with
// what this till believes its store holds (in thousandths) and which way the
// sheet opens.
class StockEdit(val itemId: String, val variantId: String?, val name: String, val now: Long, val weighed: Boolean, val way: StockForm.Way)

// Stock added or taken out from the till: a restaurant's Menu screen and a
// shop's Products & stock both hold one of these and draw StockSheet from it.
// The till asks the server and waits (ServiceRepository.adjustStock): only
// the server knows what the other tills have sold, and it holds the floor.
// Someone who may not adjust stock asks someone who may.
// done: told the item's id once its stock has changed.
class StockEditor(
    private val service: ServiceRepository, private val approvals: Approvals, private val scope: CoroutineScope,
    private val shop: Boolean, private val done: (String) -> Unit = {},
) {
    val editing = MutableStateFlow<StockEdit?>(null)
    val busy = MutableStateFlow(false)

    fun open(edit: StockEdit) { editing.value = edit }
    fun close() { if (!busy.value) editing.value = null }

    fun save(way: StockForm.Way, typed: String, reason: String?, by: StaffMember? = null) {
        val edit = editing.value ?: return
        val units = StockForm.units(typed)
        if (units == null) { Toaster.say("Type how many, as a number above zero, for example 3 or 1.5"); return }
        val left = LinePrice.left(edit.now, edit.weighed)
        // the server refuses it too, with what it holds; said here when this till already knows
        if (way == StockForm.Way.Out && units > edit.now) { Toaster.say(StockForm.refused("not-enough-stock", shop, left)); return }
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.adjustStock(edit.itemId, edit.variantId, units, way, reason, shop, left, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                editing.value = null
                approvals.ask(need.permission, need.what) { approver -> editing.value = edit; save(way, typed, reason, approver) }
            } else out.fold(
                {
                    editing.value = null
                    val n = LinePrice.qty(units, edit.weighed)
                    Toaster.say(if (way == StockForm.Way.In) "$n added to ${edit.name}." else "$n taken out of ${edit.name}.")
                    done(edit.itemId)
                },
                { Toaster.say(it.message ?: "That did not work") },
            )
        }
    }
}

// Add or take out, how many, and why, which need not be said.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun StockSheet(editor: StockEditor, edit: StockEdit) {
    val busy by editor.busy.collectAsState()
    var way by remember(edit) { mutableStateOf(edit.way) }
    var typed by remember(edit) { mutableStateOf("") }
    var reason by remember(edit) { mutableStateOf<String?>(null) }
    val units = StockForm.units(typed)
    val after = units?.let { StockForm.after(edit.now, it, way) }

    // top: the keyboard takes the lower half of the screen
    Sheet(onDismiss = { editor.close() }, width = 560.dp, gap = 14.dp, top = true) {
        SheetHead("Stock of ${edit.name}", "Needs a connection. Kept in the stock history with who changed it.") { editor.close() }

        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well).padding(4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            Way("Add stock", way == StockForm.Way.In, Modifier.weight(1f)) { way = StockForm.Way.In; reason = null }
            Way("Remove stock", way == StockForm.Way.Out, Modifier.weight(1f)) { way = StockForm.Way.Out; reason = null }
        }

        Caps(if (edit.weighed) "How many kilos" else "How many", V.Text2)
        Field(
            typed, { v -> typed = v.filter { it.isDigit() || it == '.' || it == ',' }.take(11) }, "0", Modifier.fillMaxWidth(), height = 60.dp, number = true, size = 22.sp,
            onDone = { editor.save(way, typed, reason) },
        )
        T(
            "Now " + (if (edit.now <= 0) "none" else LinePrice.qty(edit.now.toInt(), edit.weighed)) + when {
                after == null -> ""
                after < 0 -> " · there is not that much to take out"
                else -> " · will be " + LinePrice.qty(after.toInt(), edit.weighed)
            },
            15.sp, 700, if (after != null && after < 0) V.RedText else V.Text2,
        )

        Caps("Why · you can leave this", V.Text2)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            StockForm.reasons(way).forEach { r ->
                val on = reason == r.code
                Box(
                    Modifier.height(44.dp).clip(RoundedCornerShape(22.dp)).background(if (on) V.On else V.Key).border(1.dp, if (on) V.On else V.Stroke, RoundedCornerShape(22.dp))
                        // tapped again, it is no reason
                        .press { reason = if (on) null else r.code }.padding(horizontal = 16.dp),
                    contentAlignment = Alignment.Center,
                ) { T(r.label, 14.sp, 700, if (on) V.OnText else V.Text) }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Cancel", Modifier.weight(1f), height = 60.dp, enabled = !busy) { editor.close() }
            VBtn(if (busy) "Saving…" else if (way == StockForm.Way.In) "Add" else "Remove", Modifier.weight(1f), V.Blue, Color.White, 60.dp, weight = 800, enabled = !busy) {
                editor.save(way, typed, reason)
            }
        }
    }
}

@Composable
private fun Way(label: String, on: Boolean, modifier: Modifier, pick: () -> Unit) {
    Box(modifier.height(48.dp).clip(RoundedCornerShape(11.dp)).background(if (on) V.Panel else Color.Transparent).press(0.98f, pick), contentAlignment = Alignment.Center) {
        T(label, 15.sp, 800, if (on) V.Text else V.Text2)
    }
}

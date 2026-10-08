package com.restopos.feature.menu

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import com.restopos.core.data.ItemForm
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.database.CategoryEntity
import com.restopos.core.database.ItemEntity
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.Toggle
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.press
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

// The item on the sheet: one being changed, or (item = null) a new one that
// starts in the category the list was showing.
class ItemEdit(val item: ItemEntity?, val category: String?, val fixedPrice: Boolean = false)

// An item made, changed or removed from the till: a restaurant's Menu screen
// and a shop's Products & stock both hold one of these and draw ItemSheet
// from it. The till asks the server and waits for its answer (see
// ServiceRepository.saveItem), so the keys are held while it does. Someone
// who may not edit the menu asks someone who may; the sheet closes while
// they do, and what was typed goes with the question.
class ItemEditor(private val service: ServiceRepository, private val approvals: Approvals, private val scope: CoroutineScope, private val shop: Boolean) {
    val editing = MutableStateFlow<ItemEdit?>(null)
    val busy = MutableStateFlow(false)
    private val thing = if (shop) "product" else "item"

    fun new(category: String?) { editing.value = ItemEdit(null, category) }
    // fixedPrice: a product whose variants or weight carry its price; it cannot be one whose price is typed
    fun open(item: ItemEntity, fixedPrice: Boolean = false) { editing.value = ItemEdit(item, item.category_id, fixedPrice) }
    fun close() { if (!busy.value) editing.value = null }

    fun save(name: String, price: String, open: Boolean, category: String?, barcode: String, available: Boolean, by: StaffMember? = null, done: () -> Unit = {}) {
        val edit = editing.value
        val id = edit?.item?.id
        val read = ItemForm.read(name, price, open, barcode).getOrElse { Toaster.say(it.message ?: "That is not an $thing yet"); return }
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.saveItem(id, read, category, available, shop, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                editing.value = null
                approvals.ask(need.permission, need.what) { approver -> editing.value = edit; save(name, price, open, category, barcode, available, approver, done) }
            } else out.fold(
                {
                    editing.value = null
                    Toaster.say(if (id == null) "${read.name} is added. The other tills have it at their next sync." else "${read.name} is saved. The other tills have it at their next sync.")
                    done()
                },
                { Toaster.say(it.message ?: "That did not work") },
            )
        }
    }

    fun remove(by: StaffMember? = null, done: () -> Unit = {}) {
        val edit = editing.value
        val item = edit?.item ?: return
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.removeItem(item.id, shop, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                editing.value = null
                approvals.ask(need.permission, need.what) { approver -> editing.value = edit; remove(approver, done) }
            } else out.fold(
                { editing.value = null; Toaster.say("${item.name} is removed. Receipts that sold it keep its name."); done() },
                { Toaster.say(it.message ?: "That did not work") },
            )
        }
    }
}

private fun rupees(cents: Long): String = if (cents % 100 == 0L) (cents / 100).toString() else "%d.%02d".format(cents / 100, cents % 100)

// What the till can make or change of an item: its name, its price or that
// its price is typed at the sale, its category, its barcode, whether it is on
// sale; and it can remove it. Its add-ons, variants, tax, cost and stock are
// the back office's.
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ItemSheet(editor: ItemEditor, edit: ItemEdit, cats: List<CategoryEntity>, shop: Boolean, done: () -> Unit = {}) {
    val was = edit.item
    val thing = if (shop) "product" else "item"
    val busy by editor.busy.collectAsState()
    var name by remember(edit) { mutableStateOf(was?.name ?: "") }
    var price by remember(edit) { mutableStateOf(if (was == null || was.open_price) "" else rupees(was.price)) }
    var open by remember(edit) { mutableStateOf(was?.open_price ?: false) }
    var cat by remember(edit) { mutableStateOf(was?.category_id ?: edit.category) }
    var barcode by remember(edit) { mutableStateOf(was?.barcode ?: "") }
    var onSale by remember(edit) { mutableStateOf(was?.is_available ?: true) }
    var removing by remember(edit) { mutableStateOf(false) }

    // top: the keyboard takes the lower half of the screen
    Sheet(onDismiss = { editor.close() }, width = 640.dp, gap = 14.dp, top = true) {
        if (removing && was != null) {
            SheetHead("Remove ${was.name}?", "It goes from every till. Receipts that sold it keep its name, and an order that still holds it is taken as it is.") { editor.close() }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 60.dp, enabled = !busy) { removing = false }
                VBtn("Remove it", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800, enabled = !busy) { editor.remove(done = done) }
            }
            return@Sheet
        }
        SheetHead(if (was == null) "New $thing" else was.name, "It needs a connection: the server answers, and every till has it at its next sync.") { editor.close() }

        Caps("Name", V.Text2)
        Field(name, { name = it.take(80) }, if (shop) "What the product is called" else "What the item is called", Modifier.fillMaxWidth(), height = 56.dp, size = 17.sp)

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Price", V.Text2)
                Field(
                    if (open) "" else price, { v -> if (!open) price = v.filter { it.isDigit() || it == '.' }.take(10) },
                    if (open) "Typed at the sale" else "0.00", Modifier.fillMaxWidth(), height = 56.dp, number = true, size = 17.sp,
                    leading = { T("Rs", 16.sp, 700, V.Text2) },
                )
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Barcode", V.Text2)
                Field(barcode, { barcode = it.take(64) }, "Scan it here, or leave empty", Modifier.fillMaxWidth(), height = 56.dp, size = 17.sp)
            }
        }

        // A service, or anything charged differently each time: tapping it on
        // the till opens the keypad for its price.
        if (!edit.fixedPrice) Switch("Price typed at the sale", "For a service, or anything charged differently each time: tapping it opens the keypad.", open) { open = !open }
        Switch("On sale", if (shop) "Off, it cannot be rung up on any till." else "Off, the till greys it and will not sell it.", onSale) { onSale = !onSale }

        Caps("Category", V.Text2)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            (listOf<CategoryEntity?>(null) + cats).forEach { c ->
                val on = c?.id == cat
                Box(
                    Modifier.height(42.dp).clip(RoundedCornerShape(21.dp)).background(if (on) V.On else V.Key).border(1.dp, if (on) V.On else V.Stroke, RoundedCornerShape(21.dp))
                        .press { cat = c?.id }.padding(horizontal = 16.dp),
                    contentAlignment = Alignment.Center,
                ) { T(c?.name ?: "No category", 14.sp, 700, if (on) V.OnText else V.Text) }
            }
        }

        T("Its ${if (shop) "variants, cost, tax and stock" else "add-ons, tax and stock"} are set in the back office.", 13.sp, 500, V.Text3, lines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (was != null) VBtn("Remove", height = 56.dp, fg = V.RedText, enabled = !busy) { removing = true }
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 56.dp, enabled = !busy) { editor.close() }
            VBtn(if (busy) "Saving…" else if (was == null) "Add $thing" else "Save", bg = V.Blue, fg = Color.White, height = 56.dp, weight = 800, enabled = !busy) {
                editor.save(name, price, open, cat, barcode, onSale, done = done)
            }
        }
    }
}

@Composable
private fun Switch(title: String, sub: String, on: Boolean, flip: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Key).press(0.99f, flip).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            T(title, 15.sp, 700)
            T(sub, 13.sp, 500, V.Text2, lines = 2)
        }
        Toggle(on)
    }
}

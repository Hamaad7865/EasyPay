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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
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
import com.restopos.core.data.CategoryForm
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.database.CategoryEntity
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Pos
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.catColor
import com.restopos.core.ui.press
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

// The category on the sheet: one being changed, or (category = null) a new one.
class CategoryEdit(val category: CategoryEntity?)

// Categories made, changed and removed from the till: a restaurant's Menu
// screen and a shop's Products & stock both hold one of these and draw
// CategorySheets from it. As with an item, the till asks the server and waits
// for its answer (ServiceRepository.saveCategory), so the keys are held while
// it does; someone who may not edit the menu asks someone who may, and the
// sheets close while they do.
// gone: told the id of a category that was removed, so a list showing it can stop.
class CategoryEditor(
    private val service: ServiceRepository, private val approvals: Approvals, private val scope: CoroutineScope,
    private val shop: Boolean, private val gone: (String) -> Unit = {},
) {
    val listing = MutableStateFlow(false)
    val editing = MutableStateFlow<CategoryEdit?>(null)
    val busy = MutableStateFlow(false)

    fun list() { listing.value = true }
    fun new() { editing.value = CategoryEdit(null) }
    fun open(c: CategoryEntity) { editing.value = CategoryEdit(c) }
    // closing the category goes back to the list; closing the list closes all
    fun close() { if (!busy.value) editing.value = null }
    fun closeAll() { if (!busy.value) { editing.value = null; listing.value = false } }

    fun save(name: String, color: String?, by: StaffMember? = null) {
        val edit = editing.value ?: return
        val id = edit.category?.id
        val read = CategoryForm.read(name, color).getOrElse { Toaster.say(it.message ?: "That is not a category yet"); return }
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.saveCategory(id, read, shop, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                editing.value = null; listing.value = false
                approvals.ask(need.permission, need.what) { approver -> listing.value = true; editing.value = edit; save(name, color, approver) }
            } else out.fold(
                {
                    editing.value = null
                    Toaster.say(if (id == null) "${read.name} is added. The other tills have it at their next sync." else "${read.name} is saved. The other tills have it at their next sync.")
                },
                { Toaster.say(it.message ?: "That did not work") },
            )
        }
    }

    fun remove(by: StaffMember? = null) {
        val edit = editing.value
        val c = edit?.category ?: return
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.removeCategory(c.id, shop, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                editing.value = null; listing.value = false
                approvals.ask(need.permission, need.what) { approver -> listing.value = true; editing.value = edit; remove(approver) }
            } else out.fold(
                { editing.value = null; gone(c.id); Toaster.say("${c.name} is removed.") },
                { Toaster.say(it.message ?: "That did not work") },
            )
        }
    }
}

// Whichever of the two is open: the category being made or changed, else the list.
// counts: how many items each category holds, by its id.
@Composable
internal fun CategorySheets(editor: CategoryEditor, cats: List<CategoryEntity>, counts: Map<String, Int>, shop: Boolean) {
    val listing by editor.listing.collectAsState()
    val editing by editor.editing.collectAsState()
    val edit = editing
    if (edit != null) CategorySheet(editor, edit, counts[edit.category?.id] ?: 0, shop)
    else if (listing) CategoryList(editor, cats, counts, shop)
}

private fun things(n: Int, shop: Boolean): String = "$n " + (if (shop) "product" else "item") + if (n == 1) "" else "s"

@Composable
private fun CategoryList(editor: CategoryEditor, cats: List<CategoryEntity>, counts: Map<String, Int>, shop: Boolean) {
    Sheet(onDismiss = { editor.closeAll() }, width = 560.dp, gap = 14.dp) {
        SheetHead("Categories", "Tap one to change its name or colour.") { editor.closeAll() }
        if (cats.isEmpty()) T("No categories yet.", 15.sp, 500, V.Text2)
        else Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well)) {
            cats.forEachIndexed { i, c ->
                if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 56.dp).press(0.99f) { editor.open(c) }.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(Modifier.size(14.dp).clip(CircleShape).background(catColor(c.color, i)))
                    T(c.name, 15.sp, 700, modifier = Modifier.weight(1f))
                    T(things(counts[c.id] ?: 0, shop), 14.sp, 500, V.Text2)
                    VIcon(VI.Chevron, 16.dp, V.Text3)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Close", Modifier.weight(1f), height = 56.dp) { editor.closeAll() }
            VBtn("New category", Modifier.weight(1f), V.Blue, Color.White, 56.dp, weight = 800) { editor.new() }
        }
    }
}

// What the till can make or change of a category: its name and its colour;
// and it can remove one that holds nothing. Where its items print, its place
// among the buttons and whether its stock is counted are the back office's.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CategorySheet(editor: CategoryEditor, edit: CategoryEdit, items: Int, shop: Boolean) {
    val was = edit.category
    val busy by editor.busy.collectAsState()
    var name by remember(edit) { mutableStateOf(was?.name ?: "") }
    var color by remember(edit) { mutableStateOf(was?.color?.takeIf { it.isNotBlank() }) }
    var removing by remember(edit) { mutableStateOf(false) }

    // top: the keyboard takes the lower half of the screen
    Sheet(onDismiss = { editor.close() }, width = 560.dp, gap = 14.dp, top = true) {
        if (removing && was != null) {
            SheetHead("Remove ${was.name}?", "It goes from every till at its next sync.") { editor.close() }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 60.dp, enabled = !busy) { removing = false }
                VBtn("Remove it", Modifier.weight(1f), V.Red, Color.White, 60.dp, weight = 800, enabled = !busy) { editor.remove() }
            }
            return@Sheet
        }
        SheetHead(if (was == null) "New category" else was.name, "Needs a connection. Every till has it at its next sync.") { editor.close() }

        Caps("Name", V.Text2)
        Field(name, { name = it.take(60) }, "What the category is called", Modifier.fillMaxWidth(), height = 56.dp, size = 17.sp)

        Caps("Colour", V.Text2)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // none: it is painted by its place among the buttons
            Swatch(null, color == null) { color = null }
            CategoryForm.shown(was?.color).forEach { hex -> Swatch(hex, CategoryForm.same(hex, color)) { color = hex } }
        }
        if (color == null) T("With no colour of its own it takes one by its place among the buttons.", 13.sp, 500, V.Text2, lines = 2)

        // a restaurant's new category is ticked for no printer yet: said before an order finds out
        if (was == null && !shop) T("Its items print nowhere until a printer is ticked for it in the back office, under Printers.", 13.sp, 500, V.AmberText, lines = 2)
        T("Where its ${if (shop) "products" else "items"} print, its place among the buttons and whether its stock is counted are set in the back office.", 13.sp, 500, V.Text3, lines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (was != null) VBtn("Remove", height = 56.dp, fg = V.RedText, enabled = !busy) {
                // the server refuses it too; said here without asking
                if (items > 0) Toaster.say("${was.name} still has ${things(items, shop)}. Move or remove them first.") else removing = true
            }
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 56.dp, enabled = !busy) { editor.close() }
            VBtn(if (busy) "Saving…" else if (was == null) "Add category" else "Save", bg = V.Blue, fg = Color.White, height = 56.dp, weight = 800, enabled = !busy) {
                editor.save(name, color)
            }
        }
    }
}

// One colour to pick, as wide as a finger; the one chosen wears a ring.
@Composable
private fun Swatch(hex: String?, on: Boolean, pick: () -> Unit) {
    Box(
        Modifier.size(52.dp).clip(CircleShape).border(3.dp, if (on) V.Text else Color.Transparent, CircleShape).press(onClick = pick).padding(7.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (hex == null) Box(Modifier.size(38.dp).clip(CircleShape).background(V.Key).border(1.dp, V.Stroke2, CircleShape), contentAlignment = Alignment.Center) { T("–", 16.sp, 800, V.Text2) }
        else Box(Modifier.size(38.dp).clip(CircleShape).background(Pos.css(hex, V.Key)))
    }
}

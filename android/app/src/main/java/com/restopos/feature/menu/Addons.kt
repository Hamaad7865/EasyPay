package com.restopos.feature.menu

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import com.restopos.core.common.Money
import com.restopos.core.common.Uuid7
import com.restopos.core.data.AddonForm
import com.restopos.core.data.Approvals
import com.restopos.core.data.Journey
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.database.ModifierEntity
import com.restopos.core.database.ModifierGroupEntity
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.IconKey
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.quietTap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

// The group on the sheet: one being changed, with its choices, or a new one.
// id is made when the sheet opens, so a second try sends the same one.
class AddonEdit(val group: ModifierGroupEntity?, val id: String, val choices: List<ModifierEntity>)

// The add-on groups of a restaurant's menu ("Extras", "Cooking"), made and
// changed from the till as on the back office's Add-ons page (server 0096).
// A group is saved whole, with its choices. Which items carry a group is
// ticked on each item's own sheet.
class AddonEditor(private val service: ServiceRepository, private val approvals: Approvals, private val scope: CoroutineScope) {
    val listing = MutableStateFlow(false)
    val editing = MutableStateFlow<AddonEdit?>(null)
    val busy = MutableStateFlow(false)

    fun list() { listing.value = true }
    fun closeList() { listing.value = false }
    fun new() { editing.value = AddonEdit(null, Uuid7.next(), emptyList()) }
    fun open(group: ModifierGroupEntity, choices: List<ModifierEntity>) { editing.value = AddonEdit(group, group.id, choices) }
    fun close() { if (!busy.value) editing.value = null }

    fun save(name: String, min: String, max: String, rows: List<AddonForm.Typed>, by: StaffMember? = null) {
        val edit = editing.value ?: return
        val read = AddonForm.read(name, min, max, rows).getOrElse { Toaster.say(it.message ?: "That is not a group yet"); return }
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.saveAddon(edit.id, read, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) approvals.ask(need.permission, need.what) { who -> save(name, min, max, rows, who) }
            else out.fold({ editing.value = null; Toaster.say("${read.name} is saved." + Journey.others) }, { Toaster.say(it.message ?: "That did not work") })
        }
    }

    fun remove(by: StaffMember? = null) {
        val edit = editing.value ?: return
        val group = edit.group ?: return
        if (busy.value) return
        scope.launch {
            busy.value = true
            val out = service.removeAddon(group.id, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) approvals.ask(need.permission, need.what) { who -> remove(who) }
            else out.fold({ editing.value = null; Toaster.say("${group.name} is removed. It is off every item that carried it.") }, { Toaster.say(it.message ?: "That did not work") })
        }
    }
}

private fun rupees(cents: Long): String = if (cents % 100 == 0L) (cents / 100).toString() else "%d.%02d".format(cents / 100, cents % 100)

// The list of groups, and the sheet of the one being changed.
@Composable
internal fun AddonSheets(editor: AddonEditor, groups: List<ModifierGroupEntity>, choices: List<ModifierEntity>) {
    val listing by editor.listing.collectAsState()
    val editing by editor.editing.collectAsState()
    val byGroup = choices.groupBy { it.group_id }

    editing?.let { AddonSheet(editor, it); return }
    if (!listing) return
    Sheet(onDismiss = { editor.closeList() }, width = 620.dp) {
        SheetHead("Add-ons", "What can be added to an item when it is ordered: extras, how it is cooked. Tap a group to change it.") { editor.closeList() }
        if (groups.isEmpty()) T("No group yet. Add one, then tick it on the items that carry it.", 14.sp, 500, V.Text2, lines = 2)
        else Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well)) {
            groups.forEachIndexed { i, g ->
                if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                val mine = byGroup[g.id].orEmpty()
                Row(Modifier.fillMaxWidth().quietTap { editor.open(g, mine) }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        T(g.name, 15.sp, 700)
                        T(AddonForm.rule(g.min_select, g.max_select) + " · " + (if (mine.isEmpty()) "no choice yet" else mine.joinToString(", ") { it.name }), 13.sp, 500, V.Text2, lines = 2)
                    }
                    T(if (mine.size == 1) "1 choice" else "${mine.size} choices", 13.sp, 700, V.Text3)
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn("Close", height = 52.dp) { editor.closeList() }
            Box(Modifier.weight(1f))
            VBtn("New group", bg = V.Blue, fg = Color.White, height = 52.dp, weight = 800) { editor.new() }
        }
    }
}

@Composable
private fun AddonSheet(editor: AddonEditor, edit: AddonEdit) {
    val was = edit.group
    val busy by editor.busy.collectAsState()
    var name by remember(edit) { mutableStateOf(was?.name ?: "") }
    var min by remember(edit) { mutableStateOf(was?.min_select?.toString() ?: "0") }
    var max by remember(edit) { mutableStateOf(was?.max_select?.toString() ?: "0") }
    // its choices, and one empty row to type the next into
    var rows by remember(edit) { mutableStateOf(edit.choices.map { AddonForm.Typed(it.id, it.name, if (it.price == 0L) "" else rupees(it.price), it.alone) } + AddonForm.Typed(Uuid7.next())) }
    var removing by remember(edit) { mutableStateOf(false) }

    Sheet(onDismiss = { editor.close() }, width = 640.dp, pad = 22.dp, gap = 10.dp, top = true) {
        if (removing && was != null) {
            SheetHead("Remove ${was.name}?", "It comes off every item that carries it. Orders already taken keep what was picked.") { editor.close() }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 56.dp, enabled = !busy) { removing = false }
                VBtn("Remove it", Modifier.weight(1f), V.Red, Color.White, 56.dp, weight = 800, enabled = !busy) { editor.remove() }
            }
            return@Sheet
        }
        SheetHead(was?.name ?: "New group of add-ons") { editor.close() }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(2f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Name", V.Text2)
                Field(name, { name = it.take(40) }, "Extras, Cooking, Sauce", Modifier.fillMaxWidth(), height = 50.dp, size = 17.sp)
            }
            Column(Modifier.weight(0.8f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Fewest", V.Text2)
                Field(min, { v -> min = v.filter { it.isDigit() }.take(2) }, "0", Modifier.fillMaxWidth(), height = 50.dp, number = true, size = 17.sp)
            }
            Column(Modifier.weight(0.8f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Most", V.Text2)
                Field(max, { v -> max = v.filter { it.isDigit() }.take(2) }, "0", Modifier.fillMaxWidth(), height = 50.dp, number = true, size = 17.sp)
            }
        }
        T(
            AddonForm.rule(min.toIntOrNull() ?: 0, max.toIntOrNull() ?: 0) + ". Fewest 0 makes the group optional, 1 means one must be picked. Most 0 is as many as they like.",
            13.sp, 500, V.Text2, lines = 2,
        )
        Caps("Choices, and what each adds to the price", V.Text2)
        rows.forEach { r ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Field(r.name, { v -> rows = rows.map { if (it.id == r.id) it.copy(name = v.take(40)) else it } }, "A choice", Modifier.weight(2f), height = 48.dp, size = 16.sp)
                Field(
                    r.price, { v -> rows = rows.map { if (it.id == r.id) it.copy(price = v.filter { c -> c.isDigit() || c == '.' }.take(9)) else it } }, "Free",
                    Modifier.weight(1f), height = 48.dp, number = true, size = 16.sp, leading = { T("Rs", 15.sp, 700, V.Text2) },
                )
                // picked alone: All among the sauces, None
                Box(
                    Modifier.height(48.dp).clip(RoundedCornerShape(12.dp)).background(if (r.alone) V.On else V.Key)
                        .quietTap { rows = rows.map { if (it.id == r.id) it.copy(alone = !it.alone) else it } }.padding(horizontal = 14.dp),
                    contentAlignment = Alignment.Center,
                ) { T("Alone", 14.sp, 700, if (r.alone) V.OnText else V.Text2) }
                IconKey(VI.Close, size = 48.dp) { rows = rows.filterNot { it.id == r.id }.ifEmpty { listOf(AddonForm.Typed(Uuid7.next())) } }
            }
        }
        T("Alone: picking that choice takes the group's others off, and picking another takes it off. For a choice such as All or None.", 13.sp, 500, V.Text2, lines = 2)
        Row { VBtn("Another choice", height = 44.dp, radius = 12.dp, size = 14.sp, icon = VI.Plus) { rows = rows + AddonForm.Typed(Uuid7.next()) } }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (was != null) VBtn("Remove", height = 50.dp, fg = V.RedText, enabled = !busy) { removing = true }
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy) { editor.close() }
            VBtn(if (busy) "Saving…" else if (was == null) "Add group" else "Save", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy) {
                editor.save(name, min, max, rows)
            }
        }
    }
}

// What a choice adds, for a line that lists a group's choices: "Cheese +Rs 25.00"
internal fun choiceSays(c: ModifierEntity): String = if (c.price == 0L) c.name else c.name + " +" + Money.format(c.price)

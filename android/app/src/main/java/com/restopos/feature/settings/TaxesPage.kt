package com.restopos.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Uuid7
import com.restopos.core.data.Approvals
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.data.TaxForm
import com.restopos.core.database.TaxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Field
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.quietTap
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// The tax on the sheet: one being changed, or (tax = null) a new one. id is
// made when the sheet opens, so a second try after a lost answer sends the
// same one and the server makes nothing twice.
class TaxEdit(val tax: TaxEntity?, val id: String)

// The taxes, added and changed from this till as on the back office's Taxes
// page (server 0094). The till asks the server and waits for its answer (see
// ServiceRepository.saveTax), so the keys are held while it does. Someone who
// may not edit the menu asks someone who may; the sheet closes while they do,
// and what was typed goes with the question.
@HiltViewModel
class TaxesViewModel @Inject constructor(db: TillDatabase, private val service: ServiceRepository, private val approvals: Approvals) : ViewModel() {
    val taxes: StateFlow<List<TaxEntity>> = db.catalog().taxes().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    // how many items carry each
    val use: StateFlow<Map<String, Int>> = db.catalog().taxUse().map { rows -> rows.associate { it.id to it.n } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())
    val editing = MutableStateFlow<TaxEdit?>(null)
    val busy = MutableStateFlow(false)

    fun new() { editing.value = TaxEdit(null, Uuid7.next()) }
    fun open(tax: TaxEntity) { editing.value = TaxEdit(tax, tax.id) }
    fun close() { if (!busy.value) editing.value = null }

    fun save(name: String, rate: String, added: Boolean, usual: Boolean, by: StaffMember? = null) {
        val edit = editing.value ?: return
        val read = TaxForm.read(name, rate, added, usual).getOrElse { Toaster.say(it.message ?: "That is not a tax yet"); return }
        if (busy.value) return
        viewModelScope.launch {
            busy.value = true
            val out = service.saveTax(edit.id, read, by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) {
                editing.value = null
                approvals.ask(need.permission, need.what) { approver -> editing.value = edit; save(name, rate, added, usual, approver) }
            } else out.fold(
                {
                    editing.value = null
                    Toaster.say(if (edit.tax == null) "${read.name} is added. The other tills have it at their next sync." else "${read.name} is saved. Orders already open keep the tax they were rung up with.")
                },
                { Toaster.say(it.message ?: "That did not work") },
            )
        }
    }
}

// Settings > Taxes: what each item's price carries.
@Composable
internal fun TaxesPage(vm: TaxesViewModel = hiltViewModel()) {
    val taxes by vm.taxes.collectAsState()
    val use by vm.use.collectAsState()
    val editing by vm.editing.collectAsState()

    Note("An item carries one tax, and a new item starts on the usual one. A price either already includes its tax, or the tax is added on top at the sale.")
    if (taxes.isEmpty()) Panel { Note("No tax is set up yet. Add one, and make it the usual tax.") }
    else Group {
        taxes.forEachIndexed { i, t ->
            if (i > 0) Line()
            Row(Modifier.fillMaxWidth().quietTap { vm.open(t) }.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        T(t.name, 15.sp, 700)
                        if (t.is_default) Chip("Usual", V.GreenWash, V.GreenText)
                    }
                    val n = use[t.id] ?: 0
                    T(TaxForm.says(t.rate_bp, t.type) + " · " + if (n == 1) "on 1 item" else "on $n items", 13.sp, 500, V.Text2)
                }
                Small("Change") { vm.open(t) }
            }
        }
    }
    Row { VBtn("Add a tax", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800) { vm.new() } }
    Note("A tax is not removed: receipts already printed name it. Change its rate, or move items onto another from their own sheet. Changing a tax needs a connection, and the other tills have it at their next sync.")

    editing?.let { TaxSheet(vm, it) }
}

@Composable
private fun TaxSheet(vm: TaxesViewModel, edit: TaxEdit) {
    val was = edit.tax
    val busy by vm.busy.collectAsState()
    var name by remember(edit) { mutableStateOf(was?.name ?: "") }
    var rate by remember(edit) { mutableStateOf(was?.let { TaxForm.rate(it.rate_bp) } ?: "") }
    var added by remember(edit) { mutableStateOf(was?.type == "added") }
    var usual by remember(edit) { mutableStateOf(was?.is_default ?: false) }

    // top: the keyboard takes the lower half of the screen
    Sheet(onDismiss = { vm.close() }, width = 560.dp, gap = 14.dp, top = true) {
        SheetHead(was?.name ?: "New tax", "Needs a connection. Every till has it at its next sync.") { vm.close() }

        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1.7f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Name", V.Text2)
                Field(name, { name = it.take(30) }, "VAT, for example", Modifier.fillMaxWidth(), height = 56.dp, size = 17.sp)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Rate", V.Text2)
                Field(
                    rate, { v -> rate = v.filter { it.isDigit() || it == '.' || it == ',' }.take(6) }, "15", Modifier.fillMaxWidth(), height = 56.dp, number = true, size = 17.sp,
                    leading = { T("%", 16.sp, 700, V.Text2) },
                )
            }
        }

        Row {
            com.restopos.core.ui.Seg(
                listOf(SegOption("Included in the price", !added) { added = false }, SegOption("Added on top", added) { added = true }),
                well = V.Key, height = 44.dp, radius = 14.dp,
            )
        }
        T(
            if (added) "The price on the item is before tax: the tax is added to it at the sale."
            else "The price on the item is what the customer pays: the tax is worked out of it.",
            13.sp, 500, V.Text2, lines = 2,
        )

        Row(
            Modifier.fillMaxWidth().quietTap { if (was?.is_default == true) Toaster.say("To change the usual tax, open another tax and make that one the usual.") else usual = !usual },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f).padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                T("The usual tax", 15.sp, 700)
                T("A new item starts on it. There is one, so making this the usual tax takes it off the other.", 13.sp, 500, V.Text2, lines = 2)
            }
            com.restopos.core.ui.Toggle(usual)
        }

        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 56.dp, enabled = !busy) { vm.close() }
            VBtn(if (busy) "Saving…" else if (was == null) "Add tax" else "Save", bg = V.Blue, fg = Color.White, height = 56.dp, weight = 800, enabled = !busy) {
                vm.save(name, rate, added, usual)
            }
        }
    }
}

package com.restopos.feature.stock

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Uuid7
import com.restopos.core.data.Approvals
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffSession
import com.restopos.core.data.StockRepository
import com.restopos.core.data.SupplierForm
import com.restopos.core.database.SupplierEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Field
import com.restopos.core.ui.Gap
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.VI
import com.restopos.core.ui.panel
import com.restopos.core.ui.press
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// A supplier's sheet while it is open: whose it is (its id is made when the
// sheet opens for a new one, so a second try sends the same), what is typed,
// and what went wrong the last time it was saved.
data class SupplierSheet(val id: String, val fresh: Boolean, val form: SupplierForm.Supplier, val problem: String? = null, val removing: Boolean = false)

// Behind the Suppliers tab: who the shop buys from. The list is the tablet's
// own copy; a change is asked of the server and shows when the sync brings it.
@HiltViewModel
class SuppliersViewModel @Inject constructor(
    db: TillDatabase,
    private val stock: StockRepository,
    private val staff: StaffSession,
    private val approvals: Approvals,
) : ViewModel() {
    val suppliers: StateFlow<List<SupplierEntity>> = db.stock().suppliers().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
    // how many products name each
    val use: StateFlow<Map<String, Int>> = db.stock().supplierUse().map { rows -> rows.associate { it.supplier_id to it.n } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    private val _sheet = MutableStateFlow<SupplierSheet?>(null)
    val sheet: StateFlow<SupplierSheet?> = _sheet
    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy
    // who gave their word for the sheet that is open, when the person at the till may not change suppliers
    private var approver: StaffMember? = null

    // Someone who may not change suppliers is let in by someone who may; their word goes with the save.
    private fun guard(then: () -> Unit) {
        approver = null
        if (staff.can("suppliers.edit")) then()
        else approvals.ask("suppliers.edit", "change suppliers") { who -> approver = who; then() }
    }
    fun add() = guard { _sheet.value = SupplierSheet(Uuid7.next(), true, SupplierForm.Supplier("")) }
    fun edit(s: SupplierEntity) = guard {
        _sheet.value = SupplierSheet(s.id, false, SupplierForm.Supplier(s.name, s.contact.orEmpty(), s.phone.orEmpty(), s.email.orEmpty(), s.address.orEmpty(), s.note.orEmpty()))
    }
    fun type(change: (SupplierForm.Supplier) -> SupplierForm.Supplier) { _sheet.value = _sheet.value?.let { it.copy(form = change(it.form), problem = null) } }
    fun close() { if (!_busy.value) { _sheet.value = null; approver = null } }
    fun askRemove(on: Boolean) { _sheet.value = _sheet.value?.copy(removing = on, problem = null) }

    fun save() = viewModelScope.launch {
        val s = _sheet.value ?: return@launch
        if (_busy.value) return@launch
        SupplierForm.problem(s.form)?.let { _sheet.value = s.copy(problem = it); return@launch }
        _busy.value = true
        val out = stock.saveSupplier(s.id, s.form, approver)
        _busy.value = false
        out.fold(
            { _sheet.value = null; approver = null; Toaster.say(if (s.fresh) "${s.form.name.trim()} is added." else "Saved.") },
            // what was typed stays on the sheet: with no connection it is tried again from there
            { e -> _sheet.value = _sheet.value?.copy(problem = e.message ?: "That did not work. Try again.") },
        )
    }

    fun remove() = viewModelScope.launch {
        val s = _sheet.value ?: return@launch
        if (_busy.value) return@launch
        _busy.value = true
        val out = stock.removeSupplier(s.id, approver)
        _busy.value = false
        out.fold(
            { _sheet.value = null; approver = null; Toaster.say("${s.form.name.trim()} is removed. It stays on its old orders.") },
            { e -> _sheet.value = _sheet.value?.copy(removing = false, problem = e.message ?: "That did not work. Try again.") },
        )
    }
}

@Composable
fun SuppliersTab(vm: SuppliersViewModel) {
    val rows by vm.suppliers.collectAsState()
    val use by vm.use.collectAsState()
    val sheet by vm.sheet.collectAsState()

    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            T(if (rows.size == 1) "1 supplier" else "${rows.size} suppliers", 15.sp, 600, V.Text2)
            Gap()
            VBtn("Add a supplier", bg = V.Blue, fg = Color.White, height = 48.dp, pad = 20.dp, icon = VI.Plus) { vm.add() }
        }
        if (rows.isEmpty()) {
            T("Nobody yet. Add who the shop buys from: an order is written to a supplier, and a delivery can name one.", 15.sp, 500, V.Text2, Modifier.padding(40.dp), lines = 3)
        } else LazyColumn(Modifier.fillMaxWidth().weight(1f).panel(), contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 6.dp)) {
            items(rows, key = { it.id }) { s -> SupplierRow(s, use[s.id] ?: 0) { vm.edit(s) } }
        }
    }
    sheet?.let { SupplierSheetView(it, vm) }
}

@Composable
private fun SupplierRow(s: SupplierEntity, products: Int, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().press(0.99f, onClick).padding(horizontal = 18.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T(s.name, 16.sp, 700)
            val under = listOfNotNull(s.contact, s.phone, s.email).filter { it.isNotBlank() }.joinToString(" · ")
            if (under.isNotEmpty()) T(under, 13.sp, 500, V.Text2)
            if (!s.note.isNullOrBlank()) T(s.note, 13.sp, 500, V.Text3)
        }
        if (products > 0) Chip(if (products == 1) "1 product" else "$products products", V.Key, V.Text2)
    }
}

// Typed into with the tablet's keyboard, so it sits at the top of the screen.
@Composable
private fun SupplierSheetView(s: SupplierSheet, vm: SuppliersViewModel) {
    val busy by vm.busy.collectAsState()
    Sheet(onDismiss = { vm.close() }, width = 620.dp, top = true, gap = 10.dp) {
        SheetHead(if (s.fresh) "New supplier" else s.form.name.ifBlank { "Supplier" }) { vm.close() }
        if (s.removing) {
            T("Remove ${s.form.name.trim()}? It stays on the orders and deliveries it is on, and can no longer be picked for a new one.", 15.sp, 500, V.Text2, lines = 4)
            s.problem?.let { T(it, 14.sp, 600, V.Red, lines = 3) }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 56.dp, enabled = !busy) { vm.askRemove(false) }
                VBtn(if (busy) "Removing…" else "Remove", Modifier.weight(1f), V.Red, Color.White, 56.dp, weight = 800, enabled = !busy) { vm.remove() }
            }
        } else {
        Labelled("Name") { Field(s.form.name, { v -> vm.type { it.copy(name = v.take(120)) } }, "Textiles Ocean", Modifier.fillMaxWidth(), height = 48.dp, size = 16.sp) }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Labelled("Contact", Modifier.weight(1f)) { Field(s.form.contact, { v -> vm.type { it.copy(contact = v.take(120)) } }, "Who to ask for", Modifier.fillMaxWidth(), height = 48.dp) }
            Labelled("Phone", Modifier.weight(1f)) { Field(s.form.phone, { v -> vm.type { it.copy(phone = v.take(40)) } }, "5250 1234", Modifier.fillMaxWidth(), height = 48.dp, phone = true) }
        }
        Labelled("E-mail") { Field(s.form.email, { v -> vm.type { it.copy(email = v.take(120)) } }, "orders@supplier.mu", Modifier.fillMaxWidth(), height = 48.dp) }
        Labelled("Address") { Field(s.form.address, { v -> vm.type { it.copy(address = v.take(200)) } }, "Where they are", Modifier.fillMaxWidth(), height = 48.dp) }
        Labelled("Note") { Field(s.form.note, { v -> vm.type { it.copy(note = v.take(200)) } }, "Delivers on Tuesdays", Modifier.fillMaxWidth(), height = 48.dp) }
        s.problem?.let {
            T(it, 14.sp, 600, V.Red, Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(V.Red.copy(alpha = 0.12f)).padding(horizontal = 12.dp, vertical = 10.dp), lines = 3)
        }
        Row(Modifier.height(56.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (!s.fresh) VBtn("Remove", Modifier.weight(1f), height = 56.dp, fg = V.Red, enabled = !busy) { vm.askRemove(true) }
            VBtn(if (busy) "Saving…" else "Save", Modifier.weight(2f), V.Green, V.GreenInk, 56.dp, 16.dp, 17.sp, 800, enabled = !busy) { vm.save() }
        }
        }
    }
}

// A field with its name above it.
@Composable
private fun Labelled(label: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Caps(label)
        content()
    }
}

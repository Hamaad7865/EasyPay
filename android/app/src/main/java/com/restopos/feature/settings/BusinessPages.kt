package com.restopos.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.Money
import com.restopos.core.common.PinHash
import com.restopos.core.common.Uuid7
import com.restopos.core.data.Approvals
import com.restopos.core.data.DiscountForm
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.Perms
import com.restopos.core.data.PosSettings
import com.restopos.core.data.RoleForm
import com.restopos.core.data.ServiceRepository
import com.restopos.core.data.StaffMember
import com.restopos.core.database.DiscountEntity
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.RoleEntity
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
import com.restopos.core.ui.VI
import com.restopos.core.ui.VIcon
import com.restopos.core.ui.press
import com.restopos.core.ui.quietTap
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// Staff, roles and discounts, set up from this till as on the back office's
// pages of the same names (server 0095). A linked till asks the server and
// waits; a tablet that works on its own answers itself (ServiceRepository.ask).
// Someone who may not is asked for someone who may, with their own PIN.
@HiltViewModel
class BusinessViewModel @Inject constructor(db: TillDatabase, private val service: ServiceRepository, private val approvals: Approvals) : ViewModel() {
    private fun <T> kotlinx.coroutines.flow.Flow<T>.held(initial: T): StateFlow<T> = stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), initial)
    val shop = db.ops().settingsFlow().map { PosSettings.parse(it).retail }.held(false)
    val staff = db.staff().everyone().held(emptyList())
    val roles = db.staff().roles().map { rows -> rows.sortedBy { it.name.lowercase() } }.held(emptyList())
    val discounts = db.catalog().discountsFlow().held(emptyList())
    // the receipt's notes and the service charge, as the settings hold them
    val settings = db.ops().settingsFlow().map { PosSettings.parse(it) }.held(PosSettings())
    val busy = MutableStateFlow(false)

    // One change: asked, and if the person signed in may not, asked again with the word of someone who may.
    private fun go(said: String, done: () -> Unit, by: StaffMember? = null, change: suspend (StaffMember?) -> Result<Unit>) {
        if (busy.value) return
        viewModelScope.launch {
            busy.value = true
            val out = change(by)
            busy.value = false
            val need = out.exceptionOrNull() as? NeedsApproval
            if (need != null && by == null) approvals.ask(need.permission, need.what) { who -> go(said, done, who, change) }
            else out.fold({ Toaster.say(said); done() }, { Toaster.say(it.message ?: "That did not work") })
        }
    }

    fun addStaff(id: String, name: String, role: String?, pin: String, done: () -> Unit) {
        val called = name.trim().take(80)
        if (called.isEmpty()) { Toaster.say("Give them a name"); return }
        if (role == null) { Toaster.say("Pick their role"); return }
        if (!PinHash.isPin(pin)) { Toaster.say("A PIN is 4 digits"); return }
        go("$called is added.", done) { by -> service.addStaff(id, called, role, pin, by) }
    }

    // what changed of someone, and a new PIN when one was typed
    fun saveStaff(was: EmployeeEntity, name: String, role: String?, active: Boolean, pin: String, done: () -> Unit) {
        val called = name.trim().take(80)
        if (called.isEmpty()) { Toaster.say("Give them a name"); return }
        if (pin.isNotEmpty() && !PinHash.isPin(pin)) { Toaster.say("A PIN is 4 digits"); return }
        val newName = called.takeIf { it != was.name }
        val newRole = role?.takeIf { it != was.role_id }
        val newActive = active.takeIf { it != was.is_active }
        go("$called is saved.", done) { by ->
            var out = Result.success(Unit)
            if (newName != null || newRole != null || newActive != null) out = service.updateStaff(was.id, newName, newRole, newActive, by)
            if (out.isSuccess && pin.isNotEmpty()) out = service.setPin(was.id, pin, by)
            out
        }
    }

    fun saveRole(id: String, name: String, ticked: Set<String>, shop: Boolean, done: () -> Unit) {
        val called = RoleForm.name(name).getOrElse { Toaster.say(it.message ?: "Give the role a name"); return }
        go("$called is saved. It applies when staff next sign in with their PIN.", done) { by -> service.saveRole(id, called, ticked, Perms.offered(shop), by) }
    }

    fun removeRole(role: RoleEntity, done: () -> Unit) = go("${role.name} is removed.", done) { by -> service.removeRole(role.id, by) }

    fun saveDiscount(id: String, name: String, percent: Boolean, value: String, needsManager: Boolean, done: () -> Unit) {
        val d = DiscountForm.read(name, percent, value, needsManager).getOrElse { Toaster.say(it.message ?: "That is not a discount yet"); return }
        go("${d.name} is saved.", done) { by -> service.saveDiscount(id, d, by) }
    }

    // only what was changed is sent: the rest is left as it is
    fun saveReceipt(was: PosSettings, header: String, footer: String, pct: String) {
        val service = if (was.retail) null else (pct.trim().ifEmpty { "0" }.toIntOrNull()?.takeIf { it in 0..30 } ?: run { Toaster.say("A service charge is a whole number from 0 to 30"); return })
        val h = header.trim().take(300).takeIf { it != was.header }
        val f = footer.trim().take(300).takeIf { it != was.footer }
        val p = service?.takeIf { it != was.servicePct }
        if (h == null && f == null && p == null) { Toaster.say("Nothing was changed."); return }
        go("Saved. Receipts printed from now on carry it.", {}) { by -> this.service.saveSettings(h, f, p, by) }
    }

    // the minutes before an order for later is due that the tills ring; empty is off
    fun saveDueReminder(was: PosSettings, typed: String) {
        val m = typed.trim().ifEmpty { "0" }.toIntOrNull()?.takeIf { it in 0..120 }
            ?: run { Toaster.say("A reminder is a whole number of minutes, 1 to 120, or empty for off"); return }
        if (m == was.dueReminder) { Toaster.say("Nothing was changed."); return }
        go(if (m == 0) "The reminder is off." else "Saved. The till rings $m minutes before an order for later is due.", {}) { by -> service.saveDueReminder(m, by) }
    }

    // a shop's deposits (0113): only what changed is sent
    fun saveDeposits(was: PosSettings, on: Boolean, cancel: String, days: String, overdue: String, grace: String, customer: Boolean) {
        val d = days.trim().toIntOrNull()?.takeIf { it in 1..365 } ?: run { Toaster.say("Hold goods for 1 to 365 days"); return }
        val g = grace.trim().ifEmpty { "0" }.toIntOrNull()?.takeIf { it in 0..365 } ?: run { Toaster.say("Grace is 0 to 365 days"); return }
        val changed = listOf(on != was.depositsOn, cancel != was.depositCancel, d != was.depositDays, overdue != was.depositOverdue, g != was.depositGrace, customer != was.depositCustomer)
        if (changed.none { it }) { Toaster.say("Nothing was changed."); return }
        go("Saved. Every till of the shop takes it.", {}) { by ->
            service.saveDeposits(on.takeIf { changed[0] }, cancel.takeIf { changed[1] }, d.takeIf { changed[2] }, overdue.takeIf { changed[3] }, g.takeIf { changed[4] }, customer.takeIf { changed[5] }, by)
        }
    }

    // a shop's customer accounts (0114): only what changed is sent
    fun saveAccounts(was: PosSettings, on: Boolean, days: String) {
        val d = days.trim().toIntOrNull()?.takeIf { it in 1..365 } ?: run { Toaster.say("Overdue after 1 to 365 days"); return }
        val changed = listOf(on != was.accountsOn, d != was.accountDays)
        if (changed.none { it }) { Toaster.say("Nothing was changed."); return }
        go("Saved. Every till of the shop takes it.", {}) { by -> service.saveAccounts(on.takeIf { changed[0] }, d.takeIf { changed[1] }, by) }
    }

    // another printer (a kitchen's, a bar's): the first one of a store is the receipt printer, the others print what is ticked for them
    fun addPrinter(id: String, name: String, kind: String, address: String, paper: Int, done: () -> Unit) {
        val p = com.restopos.core.data.PrinterForm.read(name, kind, address, paper).getOrElse { Toaster.say(it.message ?: "That is not a printer yet"); return }
        go("${p.name} is added. Tick the categories that print on it: Menu, Categories.", done) { by -> service.savePrinter(id, p, null, by) }
    }

    fun removeDiscount(d: DiscountEntity, done: () -> Unit) = go("${d.name} is removed. Receipts it was given on keep it.", done) { by -> service.removeDiscount(d.id, by) }
}

// ---- Settings > Staff ----
private class StaffEdit(val person: EmployeeEntity?, val id: String)

@Composable
internal fun StaffPage(vm: BusinessViewModel = hiltViewModel()) {
    val staff by vm.staff.collectAsState()
    val roles by vm.roles.collectAsState()
    var editing by remember { mutableStateOf<StaffEdit?>(null) }
    val roleName = roles.associate { it.id to it.name }

    Note("Who works here. Each signs in at the till with their own PIN, and may do what their role allows.")
    if (staff.isEmpty()) Panel { Note("Nobody yet. Add the owner first, with the role that can do everything.") }
    else Group {
        staff.forEachIndexed { i, e ->
            if (i > 0) Line()
            Row(Modifier.fillMaxWidth().quietTap { editing = StaffEdit(e, e.id) }.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        T(e.name, 15.sp, 700)
                        if (!e.is_active) Chip("Switched off", V.Key, V.Text3)
                        else if (e.pin_hash == null) Chip("No PIN", V.Key, V.Text2)
                    }
                    T(roleName[e.role_id] ?: "No role", 13.sp, 500, V.Text2)
                }
                Small("Change") { editing = StaffEdit(e, e.id) }
            }
        }
    }
    Row { VBtn("Add staff", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800) { editing = StaffEdit(null, Uuid7.next()) } }
    Note("Someone switched off can no longer sign in at the tills; what they rang up keeps their name. What each role may do is under Roles.")

    editing?.let { e -> StaffSheet(vm, e, roles) { editing = null } }
}

@Composable
private fun StaffSheet(vm: BusinessViewModel, edit: StaffEdit, roles: List<RoleEntity>, close: () -> Unit) {
    val was = edit.person
    val busy by vm.busy.collectAsState()
    var name by remember(edit) { mutableStateOf(was?.name ?: "") }
    var role by remember(edit) { mutableStateOf(was?.role_id) }
    var active by remember(edit) { mutableStateOf(was?.is_active ?: true) }
    var pin by remember(edit) { mutableStateOf("") }
    // someone with a login of their own is EasyPay's to change; their PIN can still be set here
    val login = was?.has_login == true

    Sheet(onDismiss = { if (!busy) close() }, width = 600.dp, pad = 22.dp, gap = 10.dp, top = true) {
        SheetHead(was?.name ?: "New member of staff") { if (!busy) close() }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1.6f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Name", V.Text2)
                Field(name, { if (!login) name = it.take(80) }, "Their name", Modifier.fillMaxWidth(), height = 50.dp, size = 17.sp)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps(if (was == null) "PIN, 4 digits" else "New PIN", V.Text2)
                Field(pin, { v -> pin = v.filter { it.isDigit() }.take(4) }, if (was == null) "4 digits" else "Leave empty to keep", Modifier.fillMaxWidth(), height = 50.dp, number = true, size = 17.sp)
            }
        }
        Caps("Role", V.Text2)
        if (roles.isEmpty()) T("There is no role to give yet. Add one under Roles.", 13.sp, 500, V.Text2)
        else Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            roles.forEach { r -> Pick(r.name, r.id == role) { if (!login) role = r.id } }
        }
        if (login) T("They sign in with a login of their own, which EasyPay looks after: their name, role and access are not changed here. Their PIN can be.", 13.sp, 500, V.Text2, lines = 3)
        else if (was != null) Row(Modifier.fillMaxWidth().quietTap { active = !active }, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(end = 14.dp)) {
                T("May use the tills", 15.sp, 700)
                T("Off, they can no longer sign in with their PIN.", 13.sp, 500, V.Text2)
            }
            com.restopos.core.ui.Toggle(active)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy) { close() }
            VBtn(if (busy) "Saving…" else if (was == null) "Add" else "Save", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy) {
                if (was == null) vm.addStaff(edit.id, name, role, pin, close) else vm.saveStaff(was, name, role, active, pin, close)
            }
        }
    }
}

// ---- Settings > Roles ----
private class RoleEdit(val role: RoleEntity?, val id: String)

@Composable
internal fun RolesPage(vm: BusinessViewModel = hiltViewModel()) {
    val roles by vm.roles.collectAsState()
    val staff by vm.staff.collectAsState()
    val shop by vm.shop.collectAsState()
    var editing by remember { mutableStateOf<RoleEdit?>(null) }

    Note("What each role may do on the till. A member of staff is given a role under Staff.")
    Group {
        roles.forEachIndexed { i, r ->
            if (i > 0) Line()
            val n = staff.count { it.role_id == r.id }
            Row(Modifier.fillMaxWidth().quietTap { editing = RoleEdit(r, r.id) }.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    T(r.name, 15.sp, 700)
                    T(RoleForm.says(r.permissions, shop) + " · " + if (n == 1) "1 member of staff" else "$n staff", 13.sp, 500, V.Text2)
                }
                Small(if (RoleForm.isOwner(r.permissions)) "See" else "Change") { editing = RoleEdit(r, r.id) }
            }
        }
    }
    Row { VBtn("Add a role", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800) { editing = RoleEdit(null, Uuid7.next()) } }

    editing?.let { e -> RoleSheet(vm, e, shop, staff.count { it.role_id == e.id }) { editing = null } }
}

@Composable
private fun RoleSheet(vm: BusinessViewModel, edit: RoleEdit, shop: Boolean, holders: Int, close: () -> Unit) {
    val was = edit.role
    val busy by vm.busy.collectAsState()
    val owner = was != null && RoleForm.isOwner(was.permissions)
    var name by remember(edit) { mutableStateOf(was?.name ?: "") }
    // a new role starts with taking orders and payment: a role that can do nothing is no use to anyone
    var ticked by remember(edit) { mutableStateOf(was?.let { RoleForm.held(it.permissions) } ?: setOf("sale.create", "payment.take")) }
    var removing by remember(edit) { mutableStateOf(false) }

    Sheet(onDismiss = { if (!busy) close() }, width = 680.dp, pad = 22.dp, gap = 10.dp, top = true) {
        if (removing && was != null) {
            SheetHead("Remove ${was.name}?", "Nobody has this role. It cannot be brought back.") { close() }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                VBtn("Keep it", Modifier.weight(1f), height = 56.dp, enabled = !busy) { removing = false }
                VBtn("Remove it", Modifier.weight(1f), V.Red, Color.White, 56.dp, weight = 800, enabled = !busy) { vm.removeRole(was, close) }
            }
            return@Sheet
        }
        SheetHead(was?.name ?: "New role") { if (!busy) close() }
        if (owner) {
            T("The owner's role can do everything, and cannot be changed.", 14.sp, 500, V.Text2, lines = 2)
            Row { Box(Modifier.weight(1f)); VBtn("Close", height = 50.dp) { close() } }
            return@Sheet
        }
        Caps("Name", V.Text2)
        Field(name, { name = it.take(30) }, "Cashier, Waiter, Manager", Modifier.fillMaxWidth(), height = 50.dp, size = 17.sp)
        Perms.groups(shop).forEach { g ->
            Caps(g.title, V.Text2, Modifier.padding(top = 4.dp))
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well)) {
                g.perms.forEachIndexed { i, (key, label) ->
                    if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                    val on = key in ticked
                    Row(Modifier.fillMaxWidth().quietTap { ticked = if (on) ticked - key else ticked + key }.padding(horizontal = 14.dp, vertical = 11.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(24.dp).clip(RoundedCornerShape(7.dp)).background(if (on) V.Blue else V.Key).border(1.dp, if (on) V.Blue else V.Stroke, RoundedCornerShape(7.dp)),
                            contentAlignment = Alignment.Center,
                        ) { if (on) VIcon(VI.Check, 15.dp, Color.White, 2.6f) }
                        T(label, 14.sp, 600, modifier = Modifier.padding(start = 12.dp), lines = 2)
                    }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (was != null) VBtn("Remove", height = 50.dp, fg = V.RedText, enabled = !busy) {
                if (holders > 0) Toaster.say("Staff still have this role. Give them another role first, under Staff.") else removing = true
            }
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy) { close() }
            VBtn(if (busy) "Saving…" else if (was == null) "Add role" else "Save", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy) {
                vm.saveRole(edit.id, name, ticked, shop, close)
            }
        }
    }
}

// ---- Settings > Printers: another printer ----
@Composable
internal fun AddPrinterKey(vm: BusinessViewModel = hiltViewModel()) {
    var adding by remember { mutableStateOf<String?>(null) }
    Row { VBtn("Add a printer", height = 48.dp, radius = 13.dp, icon = VI.Plus) { adding = Uuid7.next() } }
    val id = adding ?: return
    val busy by vm.busy.collectAsState()
    var name by remember(id) { mutableStateOf("") }
    var kind by remember(id) { mutableStateOf(com.restopos.core.data.PrinterForm.NETWORK) }
    var address by remember(id) { mutableStateOf("") }
    var paper by remember(id) { mutableStateOf(80) }
    Sheet(onDismiss = { if (!busy) adding = null }, width = 600.dp, pad = 22.dp, gap = 10.dp, top = true) {
        SheetHead("Another printer", "A kitchen's or a bar's. The categories ticked for it print there.") { if (!busy) adding = null }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Caps("Its name", V.Text2)
                Field(name, { name = it.take(40) }, "Kitchen", Modifier.fillMaxWidth(), height = 50.dp, size = 16.sp)
            }
            if (kind != com.restopos.core.data.PrinterForm.USB) Column(Modifier.weight(1.2f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Caps(if (kind == com.restopos.core.data.PrinterForm.BLUETOOTH) "Its Bluetooth name" else "Its address", V.Text2)
                Field(address, { address = it.take(40) }, if (kind == com.restopos.core.data.PrinterForm.BLUETOOTH) "As the tablet lists it" else "192.168.1.51", Modifier.fillMaxWidth(), height = 50.dp, size = 16.sp)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            com.restopos.core.ui.Seg(
                listOf(
                    SegOption("Network", kind == com.restopos.core.data.PrinterForm.NETWORK) { kind = com.restopos.core.data.PrinterForm.NETWORK },
                    SegOption("USB", kind == com.restopos.core.data.PrinterForm.USB) { kind = com.restopos.core.data.PrinterForm.USB },
                    SegOption("Bluetooth", kind == com.restopos.core.data.PrinterForm.BLUETOOTH) { kind = com.restopos.core.data.PrinterForm.BLUETOOTH },
                ),
                well = V.Key, height = 38.dp, radius = 12.dp, size = 14.sp,
            )
            com.restopos.core.ui.Seg(
                listOf(SegOption("80 mm", paper == 80) { paper = 80 }, SegOption("58 mm", paper == 58) { paper = 58 }),
                well = V.Key, height = 38.dp, radius = 12.dp, size = 14.sp,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy) { adding = null }
            VBtn(if (busy) "Saving…" else "Add printer", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy) {
                vm.addPrinter(id, name, kind, address, paper) { adding = null }
            }
        }
    }
}

// ---- Settings > Receipt ----
@Composable
internal fun ReceiptPage(vm: BusinessViewModel = hiltViewModel()) {
    val st by vm.settings.collectAsState()
    val busy by vm.busy.collectAsState()
    var header by remember(st.header) { mutableStateOf(st.header) }
    var footer by remember(st.footer) { mutableStateOf(st.footer) }
    var pct by remember(st.servicePct) { mutableStateOf(if (st.servicePct == 0) "" else st.servicePct.toString()) }

    Note("Two notes printed on every receipt and bill: one under the business's name and address, one at the foot.")
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Caps("At the top", V.Text2)
            Field(header, { header = it.take(300) }, "Open every day, 9 to 9", Modifier.fillMaxWidth(), height = 50.dp, size = 16.sp)
            Caps("At the foot", V.Text2, Modifier.padding(top = 6.dp))
            Field(footer, { footer = it.take(300) }, "Thank you. See you again soon.", Modifier.fillMaxWidth(), height = 50.dp, size = 16.sp)
        }
    }
    if (!st.retail) {
        Note("A service charge is added to orders served at a table, and to no other.")
        Panel {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    T("Service charge", 15.sp, 700)
                    T("A percentage, 0 to 30. Empty is none.", 13.sp, 500, V.Text2)
                }
                Field(pct, { v -> pct = v.filter { it.isDigit() }.take(2) }, "0", Modifier.padding(start = 8.dp).fillMaxWidth(0.25f), height = 50.dp, number = true, size = 17.sp, leading = { T("%", 15.sp, 700, V.Text2) })
            }
        }
    }
    Row { VBtn(if (busy) "Saving…" else "Save", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800, enabled = !busy) { vm.saveReceipt(st, header, footer, pct) } }
    Note("The business's name, address and numbers on the receipt are under This till, Set-up, Business details.")
}

// ---- Settings > Notifications: the reminder before an order for later is due ----
@Composable
internal fun DueReminderPanel(vm: BusinessViewModel = hiltViewModel()) {
    val st by vm.settings.collectAsState()
    val busy by vm.busy.collectAsState()
    var minutes by remember(st.dueReminder) { mutableStateOf(if (st.dueReminder == 0) "" else st.dueReminder.toString()) }

    Note("The till makes a sound and says which order, this many minutes before a takeaway or delivery taken for later is due. One taken for as soon as possible never rings.")
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f)) {
                T("Remind before an order is due", 15.sp, 700)
                T("Minutes, 1 to 120. Empty is off. The same for every till.", 13.sp, 500, V.Text2)
            }
            Field(minutes, { v -> minutes = v.filter { it.isDigit() }.take(3) }, "Off", Modifier.padding(start = 8.dp).fillMaxWidth(0.25f), height = 50.dp, number = true, size = 17.sp)
        }
    }
    Row { VBtn(if (busy) "Saving…" else "Save", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800, enabled = !busy) { vm.saveDueReminder(st, minutes) } }
}

// ---- Settings > Deposits (a shop's, 0113) ----
@Composable
internal fun DepositSettingsPage(vm: BusinessViewModel = hiltViewModel()) {
    val st by vm.settings.collectAsState()
    val busy by vm.busy.collectAsState()
    var on by remember(st.depositsOn) { mutableStateOf(st.depositsOn) }
    var cancel by remember(st.depositCancel) { mutableStateOf(st.depositCancel) }
    var days by remember(st.depositDays) { mutableStateOf(st.depositDays.toString()) }
    var overdue by remember(st.depositOverdue) { mutableStateOf(st.depositOverdue) }
    var grace by remember(st.depositGrace) { mutableStateOf(st.depositGrace.toString()) }
    var customer by remember(st.depositCustomer) { mutableStateOf(st.depositCustomer) }

    if (!st.depositsPaid) {
        Note("Deposits are an extra for this shop. Ask EasyPay to add them: goods held for a customer who pays part now and collects later.")
        return
    }
    Note("A deposit holds goods off the shelf at the price of the day while the customer pays part, and pays the rest when they collect. It is taken on Sell with the Deposit key.")
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Choice("Take deposits", listOf("on" to "On", "off" to "Off"), if (on) "on" else "off") { on = it == "on" }
            Choice("When a deposit is cancelled", listOf("credit" to "Credit note", "refund" to "Give money back", "keep" to "Shop keeps it"), cancel) { cancel = it }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    T("Hold goods for", 15.sp, 700)
                    T("Days, 1 to 365: the collect-by date offered. The cashier can change it.", 13.sp, 500, V.Text2, lines = 2)
                }
                Field(days, { v -> days = v.filter { it.isDigit() }.take(3) }, "30", Modifier.fillMaxWidth(0.25f), height = 50.dp, number = true, size = 17.sp)
            }
            Choice("Past the collect-by date", listOf("show" to "Mark it overdue", "cancel" to "Cancel it by itself"), overdue) { overdue = it }
            if (overdue == "cancel") Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    T("Days of grace", 15.sp, 700)
                    T("After the date, before it is cancelled. 0 is the day after.", 13.sp, 500, V.Text2, lines = 2)
                }
                Field(grace, { v -> grace = v.filter { it.isDigit() }.take(3) }, "7", Modifier.fillMaxWidth(0.25f), height = 50.dp, number = true, size = 17.sp)
            }
            Choice("Customer", listOf("required" to "Name and phone needed", "optional" to "Optional"), if (customer) "required" else "optional") { customer = it == "required" }
        }
    }
    Row { VBtn(if (busy) "Saving..." else "Save", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800, enabled = !busy) { vm.saveDeposits(st, on, cancel, days, overdue, grace, customer) } }
}

// ---- Settings > Accounts (a shop's customer accounts, 0114) ----
@Composable
internal fun AccountSettingsPage(vm: BusinessViewModel = hiltViewModel()) {
    val st by vm.settings.collectAsState()
    val busy by vm.busy.collectAsState()
    var on by remember(st.accountsOn) { mutableStateOf(st.accountsOn) }
    var days by remember(st.accountDays) { mutableStateOf(st.accountDays.toString()) }

    if (!st.accountsPaid) {
        Note("Customer accounts are an extra for this shop. Ask EasyPay to add them: a named customer takes the goods now and pays later.")
        return
    }
    Note("A sale is put on the customer's account with On account on Pay, once the sale names a customer. They pay it off under More, Accounts. Who may sell on account is set on the role: Sell on account.")
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Choice("Sell on account", listOf("on" to "On", "off" to "Off"), if (on) "on" else "off") { on = it == "on" }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    T("Overdue after", 15.sp, 700)
                    T("Days, 1 to 365: a bill older than that shows as overdue.", 13.sp, 500, V.Text2, lines = 2)
                }
                Field(days, { v -> days = v.filter { it.isDigit() }.take(3) }, "30", Modifier.fillMaxWidth(0.25f), height = 50.dp, number = true, size = 17.sp)
            }
        }
    }
    Row { VBtn(if (busy) "Saving..." else "Save", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800, enabled = !busy) { vm.saveAccounts(st, on, days) } }
}

// One setting with its choices as keys, the one picked lit.
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
private fun Choice(label: String, options: List<Pair<String, String>>, picked: String, onPick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        T(label, 15.sp, 700)
        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { (key, words) -> VBtn(words, bg = if (key == picked) V.On else V.Key, fg = if (key == picked) V.OnText else V.Text, height = 46.dp) { onPick(key) } }
        }
    }
}

// ---- Settings > Discounts ----
private class DiscountEdit(val discount: DiscountEntity?, val id: String)

@Composable
internal fun DiscountsPage(vm: BusinessViewModel = hiltViewModel()) {
    val discounts by vm.discounts.collectAsState()
    var editing by remember { mutableStateOf<DiscountEdit?>(null) }

    Note("The discounts the till offers on a bill. A discount's name prints on the receipt.")
    if (discounts.isEmpty()) Panel { Note("No discount is set up yet.") }
    else Group {
        discounts.forEachIndexed { i, d ->
            if (i > 0) Line()
            Row(Modifier.fillMaxWidth().quietTap { editing = DiscountEdit(d, d.id) }.padding(horizontal = 18.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        T(d.name, 15.sp, 700)
                        if (d.requires_approval) Chip("Needs a manager", V.Key, V.Text2)
                    }
                    T(DiscountForm.says(d.type, d.value), 13.sp, 500, V.Text2)
                }
                Small("Change") { editing = DiscountEdit(d, d.id) }
            }
        }
    }
    Row { VBtn("Add a discount", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800) { editing = DiscountEdit(null, Uuid7.next()) } }
    Note("A removed discount is no longer offered; receipts it was given on keep its name and what it took off.")

    editing?.let { e -> DiscountSheet(vm, e) { editing = null } }
}

@Composable
private fun DiscountSheet(vm: BusinessViewModel, edit: DiscountEdit, close: () -> Unit) {
    val was = edit.discount
    val busy by vm.busy.collectAsState()
    var name by remember(edit) { mutableStateOf(was?.name ?: "") }
    var percent by remember(edit) { mutableStateOf(was?.type != "amount") }
    var value by remember(edit) { mutableStateOf(was?.let { if (it.type == "percent") it.value.toString() else Money.format(it.value).removePrefix("Rs ").replace(",", "") } ?: "") }
    var needs by remember(edit) { mutableStateOf(was?.requires_approval ?: false) }

    Sheet(onDismiss = { if (!busy) close() }, width = 560.dp, pad = 22.dp, gap = 10.dp, top = true) {
        SheetHead(was?.name ?: "New discount") { if (!busy) close() }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1.7f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps("Name", V.Text2)
                Field(name, { name = it.take(40) }, "Staff meal, for example", Modifier.fillMaxWidth(), height = 50.dp, size = 17.sp)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Caps(if (percent) "Percent off" else "Rupees off", V.Text2)
                Field(value, { v -> value = v.filter { it.isDigit() || (!percent && it == '.') }.take(9) }, if (percent) "10" else "50", Modifier.fillMaxWidth(), height = 50.dp, number = true, size = 17.sp)
            }
        }
        Row {
            com.restopos.core.ui.Seg(
                listOf(SegOption("A percentage of the bill", percent) { percent = true; value = "" }, SegOption("An amount off it", !percent) { percent = false; value = "" }),
                well = V.Key, height = 38.dp, radius = 12.dp, size = 14.sp,
            )
        }
        Row(Modifier.fillMaxWidth().quietTap { needs = !needs }, verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f).padding(end = 14.dp)) {
                T("Needs a manager", 15.sp, 700)
                T("Only someone allowed to give it can; a cashier asks for their PIN.", 13.sp, 500, V.Text2)
            }
            com.restopos.core.ui.Toggle(needs)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            if (was != null) VBtn("Remove", height = 50.dp, fg = V.RedText, enabled = !busy) { vm.removeDiscount(was, close) }
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy) { close() }
            VBtn(if (busy) "Saving…" else if (was == null) "Add discount" else "Save", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy) {
                vm.saveDiscount(edit.id, name, percent, value, needs, close)
            }
        }
    }
}

@Composable
private fun Pick(text: String, on: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.height(42.dp).clip(RoundedCornerShape(21.dp)).background(if (on) V.On else V.Key).border(1.dp, if (on) V.On else V.Stroke, RoundedCornerShape(21.dp))
            .press(onClick = onClick).padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) { T(text, 14.sp, 700, if (on) V.OnText else V.Text) }
}

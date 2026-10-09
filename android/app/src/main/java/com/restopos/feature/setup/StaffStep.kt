package com.restopos.feature.setup

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.PinHash
import com.restopos.core.common.Uuid7
import com.restopos.core.data.SetupFacts
import com.restopos.core.data.StaffForm
import com.restopos.core.data.StaffMember
import com.restopos.core.database.RoleEntity
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.press
import com.restopos.feature.auth.MainKey
import com.restopos.feature.auth.Problem
import com.restopos.feature.auth.SetupField

// The last step: who uses the till, and their PINs. It is last because a PIN
// changes the till: once anyone has one, the start screen asks for a PIN. The
// first goes to the owner or a manager (StaffForm.leads); after that everyone
// may have one and people can be added. Only the owner may do either, as in
// the back office: the server holds that, and the till asks for the owner's
// PIN where it knows the person at it is not the owner.
@Composable
internal fun StaffStep(vm: SetupViewModel, facts: SetupFacts, next: () -> Unit) {
    val people by vm.people.collectAsState()
    val roles by vm.roles.collectAsState()
    val refused by vm.refusedStaff.collectAsState()
    val problem by vm.problem.collectAsState()
    var pinFor by remember { mutableStateOf<StaffMember?>(null) }
    var adding by remember { mutableStateOf(false) }
    val anyPin = people.any { it.hasPin }

    if (refused) {
        // the tablet was signed in with a manager's login, and the server said no
        StepBody(
            title = "Staff and PINs",
            sub = "Only the owner can add staff or set a PIN.",
            foot = { StepFoot("Continue", ready = true, busy = false, onMain = next) },
        ) {
            T(
                "Ask the owner to set this tablet up, or to add staff and their PINs in the back office, under Staff. The tills have them at their next sync.",
                15.sp, 500, V.Text2, lines = 4, height = 22.sp,
            )
        }
        return
    }

    StepBody(
        title = "Staff and PINs",
        sub = "With PINs, each person clocks in and signs in with their own, and the till knows who rang up what. Without PINs the register opens with one tap.",
        foot = {
            if (anyPin) StepFoot("Continue", ready = true, busy = false, onMain = next)
            else StepFoot("Give the owner or a manager a PIN to go on", ready = false, busy = false, quiet = SKIP, onQuiet = next, onMain = {})
        },
    ) {
        if (vm.mayStaff == false) T("Adding staff or setting a PIN needs the owner: the till will ask for the owner's PIN.", 14.sp, 600, V.AmberText, lines = 2, height = 20.sp)
        if (pinFor == null && !adding) problem?.let { Problem(it) }
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(V.Well)) {
            people.forEachIndexed { i, m ->
                if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                val may = StaffForm.mayHavePin(m, people)
                Row(
                    Modifier.fillMaxWidth().graphicsLayer { alpha = if (may) 1f else 0.55f }
                        .then(if (may) Modifier.press(0.99f) { vm.clear(); pinFor = m } else Modifier).padding(horizontal = 18.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        T(m.employee.name, 16.sp, 800)
                        T(if (may) m.role ?: "No role" else "First give a PIN to the owner or a manager", 14.sp, 500, V.Text2)
                    }
                    if (m.hasPin) Chip("PIN set", V.GreenWash, V.GreenText) else Chip("No PIN", V.Key, V.Text2)
                    Spacer(Modifier.width(14.dp))
                    T(if (m.hasPin) "Change" else "Set PIN", 14.sp, 700, if (may) V.BlueText else V.Off)
                }
            }
        }
        val mayAdd = StaffForm.mayAdd(people)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier.clip(RoundedCornerShape(12.dp)).background(V.Key).then(if (mayAdd) Modifier.press(0.97f) { vm.clear(); adding = true } else Modifier).padding(horizontal = 18.dp).height(46.dp),
                contentAlignment = Alignment.Center,
            ) { T("Add someone", 15.sp, 700, if (mayAdd) V.Text else V.Off) }
            if (!mayAdd) { Spacer(Modifier.width(12.dp)); T("First give a PIN to the owner or a manager", 13.sp, 500, V.Text3) }
        }
    }

    pinFor?.let { m -> PinSheet(vm, m) { pinFor = null } }
    if (adding) AddSheet(vm, roles) { adding = false }
}

// A PIN for someone: four digits, shown as they are typed so that they can be
// told to the person, as the back office shows them.
@Composable
private fun PinSheet(vm: SetupViewModel, m: StaffMember, close: () -> Unit) {
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    var pin by remember { mutableStateOf("") }
    val set = { vm.setPin(m, pin, close) }
    Sheet(onDismiss = { if (!busy) close() }, width = 440.dp, top = true) {
        SheetHead("A PIN for ${m.employee.name}", "Four digits. They show as they are typed, to be told to ${m.employee.name}.") { if (!busy) close() }
        problem?.let { Problem(it) }
        SetupField("PIN", pin, { pin = it.filter(Char::isDigit).take(4); vm.clear() }, "0000", enabled = !busy, keyboard = KeyboardType.Number, ime = ImeAction.Done, onIme = { if (PinHash.isPin(pin)) set() })
        MainKey(if (PinHash.isPin(pin)) "Set PIN" else "Type four digits", ready = PinHash.isPin(pin), busy = busy) { set() }
    }
}

// Someone new: their name, what they are, and their PIN. They have no login:
// a login is the back office's to give.
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AddSheet(vm: SetupViewModel, roles: List<RoleEntity>, close: () -> Unit) {
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    // made when the sheet opens and kept until the server has taken it: a second try adds nobody twice
    val id = remember { Uuid7.next() }
    var name by remember { mutableStateOf("") }
    var role by remember { mutableStateOf<RoleEntity?>(null) }
    var pin by remember { mutableStateOf("") }
    val missing = when {
        name.isBlank() -> "Give them a name"
        role == null -> "Pick what they are"
        !PinHash.isPin(pin) -> "Type a PIN of four digits"
        else -> null
    }
    Sheet(onDismiss = { if (!busy) close() }, width = 520.dp, top = true) {
        SheetHead("Add someone", "They sign in at the till with their PIN.") { if (!busy) close() }
        problem?.let { Problem(it) }
        SetupField("Name", name, { name = it; vm.clear() }, "Asha", enabled = !busy, ime = ImeAction.Next)
        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
            T("What they are", 13.sp, 600, V.Text2)
            if (roles.isEmpty()) T("This business has no roles to give. Add one in the back office, under Roles and permissions.", 14.sp, 500, V.Text2, lines = 3)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                roles.forEach { r ->
                    val on = role?.id == r.id
                    Box(
                        Modifier.clip(RoundedCornerShape(12.dp)).background(if (on) V.On else V.Well).press(0.96f) { role = r; vm.clear() }.padding(horizontal = 18.dp).height(44.dp),
                        contentAlignment = Alignment.Center,
                    ) { T(r.name, 15.sp, 700, if (on) V.OnText else V.Dim) }
                }
            }
        }
        SetupField("PIN", pin, { pin = it.filter(Char::isDigit).take(4); vm.clear() }, "0000", enabled = !busy, keyboard = KeyboardType.Number, ime = ImeAction.Done)
        MainKey(missing ?: "Add ${name.trim()}", ready = missing == null, busy = busy) { vm.addStaff(id, name, role, pin, close) }
    }
}

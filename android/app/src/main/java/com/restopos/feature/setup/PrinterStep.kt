package com.restopos.feature.setup

import android.Manifest
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.common.Uuid7
import com.restopos.core.data.PrinterForm
import com.restopos.core.data.SetupFacts
import com.restopos.core.database.PrinterEntity
import com.restopos.core.ui.Chip
import com.restopos.core.ui.Gap
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.T
import com.restopos.core.ui.Toggle
import com.restopos.core.ui.V
import com.restopos.core.ui.press
import com.restopos.core.ui.quietTap
import com.restopos.feature.auth.Problem
import com.restopos.feature.auth.QuietLink
import com.restopos.feature.auth.SetupField
import kotlinx.coroutines.launch

// The printer the receipts come out of. A store with none is asked for one:
// how the tablet reaches it, and a test page, sent from what was typed before
// anything is saved, so a wrong address is never stored. A store that has
// printers shows them, each with a test and a way to change it. More
// printers, and which category prints where, stay the back office's.
@Composable
internal fun PrinterStep(vm: SetupViewModel, facts: SetupFacts, next: () -> Unit) {
    val printers by vm.printers.collectAsState()
    // the printer being changed, or "new" for one being added to a store that has some
    var open by rememberSaveable { mutableStateOf<String?>(null) }
    val editing = printers.firstOrNull { it.id == open }
    if (printers.isEmpty() || editing != null) {
        PrinterEditor(vm, facts, editing, onSaved = { if (editing == null) next() else open = null }, onCancel = if (editing != null) ({ vm.clear(); open = null }) else null, onSkip = next)
    } else {
        PrinterList(vm, printers, onChange = { vm.clear(); open = it.id }, next = next)
    }
}

// ---- the store's printers ----

@Composable
private fun PrinterList(vm: SetupViewModel, printers: List<PrinterEntity>, onChange: (PrinterEntity) -> Unit, next: () -> Unit) {
    val scope = rememberCoroutineScope()
    // what each printer's test said, by its id; "" while it is being sent
    var said by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    StepBody(
        title = "The receipt printer",
        sub = "Where receipts, bills and reports come out. The cash drawer opens through it.",
        foot = { StepFoot("Continue", ready = true, busy = false, onMain = next) },
    ) {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(V.Well)) {
            printers.forEachIndexed { i, p ->
                if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                T(p.name, 16.sp, 800)
                                if (p.is_receipt) Chip("Prints the receipts", V.GreenWash, V.GreenText)
                                if (!p.is_active) Chip("Switched off", V.Key, V.Text3)
                            }
                            T(PrinterForm.connection(p.kind, p.address) + "  ·  ${p.paper_mm} mm", 14.sp, 500, V.Text2)
                        }
                        val sending = said[p.id] == ""
                        QuietLink(if (sending) "Sending" else "Test", enabled = !sending) {
                            said = said + (p.id to "")
                            scope.launch { said = said + (p.id to (vm.testSaved(p) ?: "A test page was sent to ${p.name}.")) }
                        }
                        Spacer(Modifier.width(18.dp))
                        QuietLink("Change", enabled = true) { onChange(p) }
                    }
                    said[p.id]?.takeIf { it.isNotEmpty() }?.let { T(it, 13.sp, 600, V.Text2, lines = 3, height = 18.sp) }
                }
            }
        }
        T("More printers, and which category prints where, are set in the back office, under Printers.", 13.sp, 500, V.Text3, lines = 2)
    }
}

// ---- one printer, being added or changed ----

@Composable
private fun PrinterEditor(vm: SetupViewModel, facts: SetupFacts, was: PrinterEntity?, onSaved: () -> Unit, onCancel: (() -> Unit)?, onSkip: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val busy by vm.busy.collectAsState()
    val problem by vm.problem.collectAsState()
    // a new printer's id is made when its form opens and kept until the server
    // has it: a second try after a lost answer makes no second printer
    val id = rememberSaveable(was?.id) { was?.id ?: Uuid7.next() }
    var name by rememberSaveable(was?.id) { mutableStateOf(was?.name ?: "Receipt") }
    var kind by rememberSaveable(was?.id) { mutableStateOf(was?.kind?.takeIf { it == PrinterForm.USB || it == PrinterForm.BLUETOOTH } ?: PrinterForm.NETWORK) }
    var address by rememberSaveable(was?.id) { mutableStateOf(was?.address.orEmpty()) }
    var paper by rememberSaveable(was?.id) { mutableStateOf(was?.paper_mm ?: 80) }
    // a restaurant's first printer: whether kitchen orders print on it too
    val asksKitchen = !facts.retail && was == null
    var one by rememberSaveable { mutableStateOf(true) }
    var testing by remember { mutableStateOf(false) }
    var refused by remember { mutableStateOf<String?>(null) } // why the test page could not be sent
    var hint by remember { mutableStateOf(false) }
    var asked by rememberSaveable(was?.id) { mutableStateOf(false) } // the page was sent: did it print?
    val read = PrinterForm.read(name, kind, address, paper)
    fun touched() { refused = null; hint = false; vm.clear() }

    if (asked && read.isSuccess) {
        val p = read.getOrThrow()
        StepBody(
            title = "Did it print?",
            sub = "A test page was sent to ${p.name} (${PrinterForm.connection(p.kind, p.address)}).",
            foot = {
                StepFoot("Yes, save it", ready = true, busy = busy, quiet = "No", onQuiet = { asked = false; hint = true }) {
                    vm.savePrinter(id, p, if (asksKitchen) one else null) { asked = false; onSaved() }
                }
            },
        ) {
            problem?.let { Problem(it) }
            T("The page says \"Test page\" and the printer's name. If nothing came out, tap No: nothing has been saved.", 14.sp, 500, V.Text2, lines = 3, height = 20.sp)
        }
        return
    }

    StepBody(
        title = if (was == null) "The receipt printer" else "Change ${was.name}",
        sub = "Where receipts, bills and reports come out. The cash drawer opens through it.",
        foot = {
            StepFoot(
                read.exceptionOrNull()?.message ?: "Print a test page", ready = read.isSuccess, busy = testing,
                quiet = if (onCancel != null) "Cancel" else SKIP, onQuiet = onCancel ?: onSkip,
            ) {
                val p = read.getOrNull() ?: return@StepFoot
                touched()
                testing = true
                scope.launch {
                    refused = vm.testPrinter(id, p)
                    testing = false
                    if (refused == null) asked = true else hint = true
                }
            }
        },
    ) {
        refused?.let { Problem(it) }
        if (hint) T(PrinterForm.hint(kind), 14.sp, 600, V.AmberText, lines = 3, height = 20.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
            SetupField("Its name", name, { name = it; touched() }, "Receipt", Modifier.weight(1f), enabled = !testing, ime = ImeAction.Done)
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                T("Paper", 13.sp, 600, V.Text2)
                Seg(listOf(SegOption("80 mm", paper == 80) { paper = 80; touched() }, SegOption("58 mm", paper == 58) { paper = 58; touched() }), well = V.Well, height = 46.dp)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
            T("How it is connected", 13.sp, 600, V.Text2)
            Seg(
                listOf(
                    SegOption("Network", kind == PrinterForm.NETWORK) { kind = PrinterForm.NETWORK; touched() },
                    SegOption("USB", kind == PrinterForm.USB) { kind = PrinterForm.USB; touched() },
                    SegOption("Bluetooth", kind == PrinterForm.BLUETOOTH) { kind = PrinterForm.BLUETOOTH; if (was?.kind != PrinterForm.BLUETOOTH) address = ""; touched() },
                ),
                well = V.Well, height = 46.dp,
            )
        }
        when (kind) {
            PrinterForm.USB -> {
                val seen by vm.usb.collectAsState(initial = null)
                T(seen?.let { "The tablet sees a printer: $it" } ?: "No printer is plugged into this tablet", 15.sp, 600, if (seen != null) V.GreenText else V.Text2, lines = 2)
                T("The first time it prints, the tablet asks whether EasyPay may use it.", 13.sp, 500, V.Text3, lines = 2)
            }
            PrinterForm.BLUETOOTH -> {
                var allowed by remember { mutableStateOf(vm.bluetoothAllowed()) }
                val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = vm.bluetoothAllowed() }
                if (!allowed) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T("A Bluetooth printer cannot be reached until the tablet allows it. It asks once.", 14.sp, 500, V.Text2, Modifier.weight(1f), lines = 3, height = 20.sp)
                        Spacer(Modifier.width(12.dp))
                        QuietLink("Allow Bluetooth", enabled = true) { ask.launch(Manifest.permission.BLUETOOTH_CONNECT) }
                    }
                } else {
                    val paired by vm.paired.collectAsState(initial = emptyList())
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T("Paired with this tablet", 13.sp, 600, V.Text2)
                        Gap()
                        // pairing is done in the tablet's own settings
                        QuietLink("Bluetooth settings", enabled = true) {
                            runCatching { context.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        }
                    }
                    if (paired.isEmpty()) T("No device is paired with this tablet yet. Pair the printer in the tablet's Bluetooth settings: it then shows here.", 14.sp, 500, V.Text2, lines = 3, height = 20.sp)
                    else Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well)) {
                        paired.forEachIndexed { i, (called, at) ->
                            if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
                            // a printer saved by its name is this one too (BluetoothMatch)
                            val on = address.equals(at, ignoreCase = true) || address.equals(called, ignoreCase = true)
                            Row(
                                Modifier.fillMaxWidth().background(if (on) V.RowOn else V.Well).quietTap { address = at; touched() }.padding(horizontal = 16.dp).height(50.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                T(called, 15.sp, if (on) 800 else 600, V.Text, Modifier.weight(1f))
                                T(at, 13.sp, 500, V.Text3)
                            }
                        }
                    }
                }
            }
            else -> {
                SetupField("Its address", address, { address = it.trim(); touched() }, "192.168.1.50", enabled = !testing, keyboard = KeyboardType.Uri, ime = ImeAction.Done)
                T("Most printers print their address on their self-test page.", 13.sp, 500, V.Text3, lines = 2)
            }
        }
        if (asksKitchen) {
            Row(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well).press(0.99f) { one = !one }.padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T("Kitchen orders print on it too", 15.sp, 700)
                    T("With one printer for everything, every kitchen order prints here.", 13.sp, 500, V.Text2, lines = 2)
                }
                Spacer(Modifier.width(12.dp))
                Toggle(one)
            }
        }
    }
}

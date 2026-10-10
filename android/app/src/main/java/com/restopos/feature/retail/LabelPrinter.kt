package com.restopos.feature.retail

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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.PrinterForm
import com.restopos.core.print.LabelBook
import com.restopos.core.print.LabelJob
import com.restopos.core.print.LabelLayout
import com.restopos.core.print.LabelPaint
import com.restopos.core.print.LabelPrinter
import com.restopos.core.print.LabelPrinters
import com.restopos.core.print.LabelTemplates
import com.restopos.core.print.LabelWords
import com.restopos.core.print.Printing
import com.restopos.core.print.UsbPick
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Gap
import com.restopos.core.ui.Seg
import com.restopos.core.ui.SegOption
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.quietTap
import com.restopos.feature.auth.Problem
import com.restopos.feature.auth.QuietLink
import com.restopos.feature.auth.SetupField
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

// Behind the label printer's set-up: the printer this tablet's labels come
// out of. It is the tablet's own (SessionStore), set up here and nowhere
// else; the Print labels screen and Settings both open the same form.
@HiltViewModel
class LabelPrinterViewModel @Inject constructor(
    private val session: SessionStore,
    private val printing: Printing,
) : ViewModel() {
    val printer: StateFlow<LabelPrinter?> = session.labelPrinter.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    // whether it is there right now (plugged in, paired, answering); null while it is being asked, or with none
    private val _there = MutableStateFlow<Boolean?>(null)
    val there: StateFlow<Boolean?> = _there
    init { viewModelScope.launch { printer.collect { look(it) } } }
    fun check() = viewModelScope.launch { look(printer.value) }
    private suspend fun look(p: LabelPrinter?) {
        _there.value = null
        _there.value = p?.let { printing.labelAnswers(it) }
    }

    fun usb(): List<UsbPick.Seen> = printing.usbPrinters()
    fun paired(): List<Pair<String, String>> = printing.pairedDevices()
    fun bluetoothAllowed(): Boolean = printing.bluetoothAllowed()

    fun save(p: LabelPrinter) = viewModelScope.launch { session.setLabelPrinter(p) }
    fun remove() = viewModelScope.launch { session.setLabelPrinter(null) }

    // One test label, in the size of the label in use, to a printer as it is
    // typed: nothing has to be saved first, so a wrong address never is. Null
    // when it was sent, else why not, in words.
    suspend fun test(p: LabelPrinter): String? {
        // the label in use, one of the shop's own included: the test is of its size
        val of = LabelBook.find(session.labelTemplates.first(), session.labelTemplate.first()) ?: LabelTemplates.byId(null)
        val placed = LabelLayout.place(LabelTemplates.test(of), LabelWords("", "", "", "", LabelTemplates.testCode(of)), p.dots)
        val raster = withContext(Dispatchers.Default) { LabelPaint.raster(placed) }
        val bytes = LabelJob.bytes(p, listOf(LabelJob.Label(raster, 1)), of).getOrElse { return it.message }
        return printing.sendLabels(p, bytes, "Test label").exceptionOrNull()?.let { it.message ?: "The test label could not be sent." }
    }
}

// How a label printer is reached, in a few words, for a list.
fun labelConnection(p: LabelPrinter): String =
    if (p.kind == PrinterForm.USB) "USB" + (p.usbName?.let { " · $it" } ?: "") else PrinterForm.connection(p.kind, p.address)

private fun usbName(s: UsbPick.Seen): String = s.name ?: "USB printer"
private fun usbNumbers(s: UsbPick.Seen): String = "%04X:%04X".format(s.vendor, s.product) + (s.serial?.let { " · $it" } ?: "")

// The form: its name, what kind of printer it is, how the tablet reaches it,
// and a test label sent from what is typed. After the set-up's receipt
// printer form (feature/setup/PrinterStep.kt), whose rules it shares.
@Composable
fun LabelPrinterSheet(vm: LabelPrinterViewModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val was = remember { vm.printer.value }
    var name by remember { mutableStateOf(was?.name ?: "Labels") }
    var kind by remember { mutableStateOf(was?.kind ?: PrinterForm.USB) }
    var address by remember { mutableStateOf(was?.address.orEmpty()) }
    var sticker by remember { mutableStateOf(was?.sticker ?: true) }
    var dpi by remember { mutableIntStateOf(was?.dpi ?: 203) }
    var paper by remember { mutableIntStateOf(was?.paper ?: 80) }
    // what is plugged in and what is paired, looked at again while the form is open
    var seen by remember { mutableStateOf(vm.usb()) }
    var paired by remember { mutableStateOf(vm.paired()) }
    var allowed by remember { mutableStateOf(vm.bluetoothAllowed()) }
    var usb by remember { mutableStateOf(was?.let { UsbPick.match(it, seen) }) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(2000)
            seen = vm.usb()
            allowed = vm.bluetoothAllowed()
            paired = vm.paired()
            // unplugged while the form is open: it is no longer picked
            if (usb != null && seen.none { it == usb }) usb = null
        }
    }
    var testing by remember { mutableStateOf(false) }
    var said by remember { mutableStateOf<String?>(null) } // what the test label's sending came to
    var sent by remember { mutableStateOf(false) }
    fun touched() { said = null; sent = false }

    val read = LabelPrinters.form(name, kind, address, if (sticker) LabelPrinter.TSPL else LabelPrinter.ESCPOS, dpi, paper, usb)
    // another printer on a cable that the tablet cannot tell from the one picked
    val twins = kind == PrinterForm.USB && usb?.let { UsbPick.twins(it, seen) } == true
    val ready = read.isSuccess && !twins

    Sheet(onDismiss = onDismiss, width = 640.dp, pad = 24.dp, gap = 16.dp, top = true) {
        // The keyboard's own Done puts it away, so that the keys under it can be
        // reached. Asked for in here: the sheet is a window of its own, and the
        // keyboard that is up belongs to this window, not to the screen behind.
        val keyboard = LocalSoftwareKeyboardController.current
        val typed: () -> Unit = { keyboard?.hide() }
        SheetHead(if (was == null) "Add a label printer" else "Label printer", "The printer this tablet's labels come out of.", onDismiss)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Bottom) {
            SetupField("Its name", name, { name = it.take(40); touched() }, "Labels", Modifier.weight(1f), enabled = !testing, onIme = typed)
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                T("What it is", 13.sp, 600, V.Text2)
                Seg(listOf(SegOption("Sticker printer", sticker) { sticker = true; touched() }, SegOption("Receipt printer", !sticker) { sticker = false; touched() }), well = V.Well, height = 46.dp)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
            T("How it is connected", 13.sp, 600, V.Text2)
            Seg(
                listOf(
                    SegOption("USB", kind == PrinterForm.USB) { kind = PrinterForm.USB; touched() },
                    SegOption("Bluetooth", kind == PrinterForm.BLUETOOTH) { kind = PrinterForm.BLUETOOTH; if (was?.kind != PrinterForm.BLUETOOTH) address = ""; touched() },
                    SegOption("Network", kind == PrinterForm.NETWORK) { kind = PrinterForm.NETWORK; if (was?.kind != PrinterForm.NETWORK) address = ""; touched() },
                ),
                well = V.Well, height = 46.dp,
            )
        }
        when (kind) {
            PrinterForm.USB -> {
                if (seen.isEmpty()) T("No printer is plugged into this tablet. Plug the label printer in and switch it on: it then shows here.", 14.sp, 500, V.Text2, lines = 3, height = 20.sp)
                else {
                    T("Plugged into this tablet. Tap the label printer.", 13.sp, 600, V.Text2)
                    Picks(seen.map { Triple(usbName(it), usbNumbers(it), it == usb) }) { i -> usb = seen[i]; touched() }
                }
                if (twins) Problem("Another printer plugged into this tablet looks exactly the same to it, so labels and receipts could not be kept apart. Connect one of the two by Bluetooth or over the network instead.")
                else T("The first time it prints, the tablet asks whether EasyPay may use it.", 13.sp, 500, V.Text3, lines = 2)
            }
            PrinterForm.BLUETOOTH -> {
                val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = vm.bluetoothAllowed(); paired = vm.paired() }
                if (!allowed) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T("A Bluetooth printer cannot be reached until the tablet allows it. It asks once.", 14.sp, 500, V.Text2, Modifier.weight(1f), lines = 3, height = 20.sp)
                        Spacer(Modifier.width(12.dp))
                        QuietLink("Allow Bluetooth", enabled = true) { ask.launch(Manifest.permission.BLUETOOTH_CONNECT) }
                    }
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        T("Paired with this tablet. Tap the label printer.", 13.sp, 600, V.Text2)
                        Gap()
                        // pairing is done in the tablet's own settings
                        QuietLink("Bluetooth settings", enabled = true) {
                            runCatching { context.startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                        }
                    }
                    if (paired.isEmpty()) T("No device is paired with this tablet yet. Pair the printer in the tablet's Bluetooth settings: it then shows here.", 14.sp, 500, V.Text2, lines = 3, height = 20.sp)
                    else Picks(paired.map { (called, at) -> Triple(called, at, address.equals(at, ignoreCase = true)) }) { i -> address = paired[i].second; touched() }
                }
            }
            else -> {
                SetupField("Its address", address, { address = it.trim().take(40); touched() }, "192.168.1.60", enabled = !testing, keyboard = KeyboardType.Uri, onIme = typed)
                T("A label printer prints its address on its self-test label. Hold its feed key while switching it on.", 13.sp, 500, V.Text3, lines = 2)
            }
        }
        if (sticker) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T("How fine it prints", 13.sp, 600, V.Text2)
                    T("Nearly all print 203 dots an inch. If the test label comes out a third too small, it is a 300.", 13.sp, 500, V.Text3, lines = 2, height = 18.sp)
                }
                Seg(listOf(SegOption("203 dpi", dpi != 300) { dpi = 203; touched() }, SegOption("300 dpi", dpi == 300) { dpi = 300; touched() }), well = V.Well, height = 46.dp)
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    T("Its paper", 13.sp, 600, V.Text2)
                    T("Each label is printed, fed and cut like a short receipt. A label wider than the paper is not printed.", 13.sp, 500, V.Text3, lines = 2, height = 18.sp)
                }
                Seg(listOf(SegOption("80 mm", paper != 58) { paper = 80; touched() }, SegOption("58 mm", paper == 58) { paper = 58; touched() }), well = V.Well, height = 46.dp)
            }
        }
        said?.let { if (sent) T(it, 14.sp, 600, V.GreenText, lines = 3, height = 20.sp) else Problem(it) }
        // until it can be saved, the form says what is missing
        if (said == null && !twins) read.exceptionOrNull()?.message?.let { T("$it.", 14.sp, 600, V.AmberText, lines = 2, height = 20.sp) }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            VBtn(if (testing) "Sending…" else "Print a test label", Modifier.weight(1f), fg = if (ready) V.Text else V.Text3, height = 56.dp, radius = 16.dp, enabled = ready && !testing) {
                val p = read.getOrNull() ?: return@VBtn
                touched()
                testing = true
                scope.launch {
                    val why = vm.test(p)
                    testing = false
                    sent = why == null
                    said = why ?: "A test label was sent to ${p.name}. If it came out whole, with its frame on all four sides, save it."
                }
            }
            VBtn("Save", Modifier.weight(1f), if (ready) V.Green else V.Key, if (ready) V.GreenInk else V.Text3, 56.dp, 16.dp, 16.sp, 800, enabled = ready && !testing) {
                read.getOrNull()?.let { vm.save(it); onDismiss() }
            }
        }
    }
}

// A short list to pick one of: what is plugged in, or what is paired.
@Composable
private fun Picks(rows: List<Triple<String, String, Boolean>>, onPick: (Int) -> Unit) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(V.Well)) {
        rows.forEachIndexed { i, (called, detail, on) ->
            if (i > 0) Box(Modifier.fillMaxWidth().height(1.dp).background(V.RowLine))
            Row(
                Modifier.fillMaxWidth().background(if (on) V.RowOn else V.Well).quietTap { onPick(i) }.padding(horizontal = 16.dp).height(50.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                T(called, 15.sp, if (on) 800 else 600, V.Text, Modifier.weight(1f))
                T(detail, 13.sp, 500, V.Text3)
            }
        }
    }
}

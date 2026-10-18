package com.restopos.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.Approvals
import com.restopos.core.data.GoLive
import com.restopos.core.data.GoLiveRules
import com.restopos.core.data.PosSettings
import com.restopos.core.data.StaffSession
import com.restopos.core.data.settingUpFlow
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
import com.restopos.core.ui.Field
import com.restopos.core.ui.Sheet
import com.restopos.core.ui.SheetHead
import com.restopos.core.ui.T
import com.restopos.core.ui.Toaster
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import com.restopos.core.ui.press
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

// Settings, This till, on a tablet that is setting up: what that means, and
// Go live (core/data/GoLive). The owner's to do; anyone else is asked for the
// owner's PIN. The sheet says what goes, with how many, and what stays.
@HiltViewModel
class GoLiveViewModel @Inject constructor(
    private val goLive: GoLive,
    db: TillDatabase,
    session: SessionStore,
    private val staff: StaffSession,
    private val approvals: Approvals,
) : ViewModel() {
    val settingUp: StateFlow<Boolean> = settingUpFlow(db, session).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    // the sheet, open with what would go
    val rung = MutableStateFlow<GoLive.Rung?>(null)
    val busy = MutableStateFlow(false)

    // owner: whoever is signed in may do it themselves. On the start screen
    // nobody is, and the owner's PIN is always asked for (from the start).
    fun ask(fromStart: Boolean = false) {
        val open: () -> Unit = { viewModelScope.launch { rung.value = goLive.rung() } }
        if (!fromStart && staff.can("*")) open() else approvals.ask("*", "put this till live") { open() }
    }
    fun close() { if (!busy.value) rung.value = null }

    // ---- back to setting up (0.9.18): an offline tablet that is live ----
    val alone: StateFlow<Boolean> = db.ops().settingsFlow().map { PosSettings.parse(it).alone }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    // the sheet that asks, open with what would go and the business's name to type
    class Again(val rung: GoLive.Rung, val business: String?)
    val again = MutableStateFlow<Again?>(null)
    private val names = session
    fun askAgain() {
        val open: () -> Unit = { viewModelScope.launch { again.value = Again(goLive.rung(), names.businessName()) } }
        if (staff.can("*")) open() else approvals.ask("*", "set this till up again") { open() }
    }
    fun closeAgain() { if (!busy.value) again.value = null }
    fun setUpAgain(typed: String) = viewModelScope.launch {
        val a = again.value ?: return@launch
        if (busy.value || !GoLiveRules.named(typed, a.business)) return@launch
        busy.value = true
        goLive.again().fold(
            { again.value = null; Toaster.say("This till is being set up again. What is rung up goes when you tap Go live.") },
            { Toaster.say(it.message ?: "That did not work.") },
        )
        busy.value = false
    }

    fun go(then: () -> Unit) = viewModelScope.launch {
        if (busy.value) return@launch
        busy.value = true
        goLive.go().fold(
            { rung.value = null; Toaster.say("This till is live. Receipts start again at 1: open the day to start selling."); then() },
            { Toaster.say(it.message ?: "That did not work.") },
        )
        busy.value = false
    }
}

@Composable
internal fun SettingUpCard(onLive: () -> Unit, vm: GoLiveViewModel = hiltViewModel()) {
    val on by vm.settingUp.collectAsState()
    val rung by vm.rung.collectAsState()
    val busy by vm.busy.collectAsState()
    if (!on) return
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(V.AmberWash).padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T("This till is being set up", 16.sp, 800, V.AmberText)
            T("What is rung up here is for trying: it prints TEST, and goes when the business goes live. The menu, the staff, the stock and all that is set up stay.", 13.sp, 500, V.Text2, lines = 3)
        }
        VBtn("Go live", bg = V.Blue, fg = Color.White, height = 46.dp, weight = 800) { vm.ask() }
    }
    rung?.let { r -> GoLiveSheet(r, busy, onClose = vm::close, onGo = { vm.go(onLive) }) }
}

// Settings, This till, on an offline tablet that is live: the way back to
// setting up, for a business that has not sold for real yet (its tablet was
// tried out before 0.9.17, or went live too early). Said quietly at the foot
// of the page, and behind the owner's PIN and the business's name typed.
@Composable
internal fun BackToSettingUp(vm: GoLiveViewModel = hiltViewModel()) {
    val on by vm.settingUp.collectAsState()
    val alone by vm.alone.collectAsState()
    val again by vm.again.collectAsState()
    val busy by vm.busy.collectAsState()
    if (on || !alone) return
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(V.Panel).padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T("Back to setting up", 15.sp, 700)
            T("Only before the business sells for real: everything rung up on this tablet so far becomes trying, and goes at Go live. The menu, the staff and all that is set up stay.", 13.sp, 500, V.Text2, lines = 3)
        }
        VBtn("Back to setting up", height = 46.dp) { vm.askAgain() }
    }
    again?.let { a -> AgainSheet(a, busy, onClose = vm::closeAgain, onGo = vm::setUpAgain) }
}

@Composable
private fun AgainSheet(a: GoLiveViewModel.Again, busy: Boolean, onClose: () -> Unit, onGo: (String) -> Unit) {
    var typed by remember(a) { mutableStateOf("") }
    val ok = GoLiveRules.named(typed, a.business)
    Sheet(onDismiss = onClose, width = 600.dp, pad = 24.dp, gap = 12.dp, top = true) {
        SheetHead("Back to setting up?", "Only for a business that has not sold for real yet.", onClose)
        T(
            "Everything rung up on this tablet so far (" + listOf(many(a.rung.receipts, "receipt"), many(a.rung.orders, "order"), many(a.rung.days, "day")).joinToString(", ") +
                ") and from now on is for trying: it prints TEST, and goes when the owner taps Go live. What those sales took off the shelf is not put back: count the stock after Go live.",
            14.sp, 500, V.Text2, lines = 5,
        )
        if (a.business.isNullOrBlank()) T("This tablet does not know its business's name, so it cannot be set up again here. Ask EasyPay.", 14.sp, 600, V.AmberText, lines = 3)
        else {
            Caps("Type ${a.business} to confirm", V.Text2)
            Field(typed, { typed = it.take(80) }, a.business, Modifier.fillMaxWidth(), height = 50.dp, size = 17.sp)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy, onClick = onClose)
            VBtn(if (busy) "Setting up…" else "Back to setting up", bg = if (ok) V.Blue else V.Key, fg = if (ok) Color.White else V.Text3, height = 50.dp, weight = 800, enabled = ok && !busy) { onGo(typed) }
        }
    }
}

// The same on the start screen, so the owner goes live before the drawer is
// counted for the first real day: a day opened only to reach Settings would
// go with the rest. `link`: the key alone, where the screen has a row of them.
@Composable
fun GoLiveFromStart(modifier: Modifier = Modifier, link: Boolean = false, color: Color, vm: GoLiveViewModel = hiltViewModel()) {
    val on by vm.settingUp.collectAsState()
    val rung by vm.rung.collectAsState()
    val busy by vm.busy.collectAsState()
    if (!on) return
    val key = @Composable { T("Go live", 15.sp, 600, color, Modifier.press(0.97f) { vm.ask(fromStart = true) }.padding(10.dp)) }
    if (link) key()
    else Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        T("This till is being set up: what is rung up on it is for trying, and goes when the business goes live.", 13.sp, 500, V.AmberText, lines = 3, align = androidx.compose.ui.text.style.TextAlign.Center)
        key()
    }
    rung?.let { r -> GoLiveSheet(r, busy, onClose = vm::close, onGo = { vm.go {} }) }
}

@Composable
private fun GoLiveSheet(r: GoLive.Rung, busy: Boolean, onClose: () -> Unit, onGo: () -> Unit) {
    Sheet(onDismiss = onClose, width = 600.dp, pad = 24.dp, gap = 12.dp) {
        SheetHead("Go live?", "From now on what is sold here is real: its receipts, its days and its stock.", onClose)
        Caps("What goes", V.Text2)
        T(listOf(many(r.receipts, "receipt"), many(r.orders, "order"), many(r.days, "day")).joinToString(", ") + ", with their payments, refunds, cash in and out, clock-ins, deposits, credit notes and account bills.", 15.sp, 600, lines = 4)
        Caps("What stays", V.Text2)
        T("The menu, the staff and their PINs, the tables, the printers, the settings, the customers, the suppliers and the stock. What sales rung up while setting up took off the shelf goes back on it; sales from before Back to setting up do not.", 15.sp, 500, lines = 4)
        T("Receipts start again at 1. This cannot be undone.", 13.sp, 600, V.AmberText, lines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy, onClick = onClose)
            VBtn(if (busy) "Going live…" else "Go live", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy, onClick = onGo)
        }
    }
}

private fun many(n: Int, one: String) = "$n $one" + if (n == 1) "" else "s"

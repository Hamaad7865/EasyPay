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
import com.restopos.core.data.StaffSession
import com.restopos.core.data.settingUpFlow
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Caps
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
        T("The menu, the staff and their PINs, the tables, the printers, the settings, the customers, the suppliers and the stock. What the sales took off the shelf goes back on it.", 15.sp, 500, lines = 4)
        T("Receipts start again at 1. This cannot be undone.", 13.sp, 600, V.AmberText, lines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy, onClick = onClose)
            VBtn(if (busy) "Going live…" else "Go live", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy, onClick = onGo)
        }
    }
}

private fun many(n: Int, one: String) = "$n $one" + if (n == 1) "" else "s"

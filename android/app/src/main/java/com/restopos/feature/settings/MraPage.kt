package com.restopos.feature.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.PosSettings
import com.restopos.core.database.DeviceEntity
import com.restopos.core.database.MraCounts
import com.restopos.core.database.MraInvoiceEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.mra.MraLogin
import com.restopos.core.mra.MraSender
import com.restopos.core.sync.SessionStore
import com.restopos.core.ui.Field
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// Settings, MRA (docs/superpowers/plans/2026-10-21-mra-phase-2-till.md, Task
// 14): a Premium MRA client's till signs in to the MRA itself, with the login
// a manager types here. The login stays on this tablet (MraLogin): EasyPay
// never has it. The till's EBS MRA ID is EasyPay's to type, in /admin.
@HiltViewModel
class MraViewModel @Inject constructor(
    private val db: TillDatabase,
    private val login: MraLogin,
    private val sender: MraSender,
    private val session: SessionStore,
) : ViewModel() {
    val settings: StateFlow<PosSettings> = db.ops().settingsFlow().map { PosSettings.parse(it) }.stateIn(viewModelScope, SharingStarted.Eagerly, PosSettings())
    val state: StateFlow<MraLogin.State> = login.state
    val problem: StateFlow<String?> = sender.problem
    val environment: StateFlow<String?> = sender.environment
    val counts: StateFlow<MraCounts?> = db.mra().counts().stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val problems: StateFlow<List<MraInvoiceEntity>> = db.mra().problems().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())
    val device = MutableStateFlow<DeviceEntity?>(null)
    val busy = MutableStateFlow(false)
    val said = MutableStateFlow<Pair<String, Boolean>?>(null) // what Connect answered, and whether it went well

    fun load() = viewModelScope.launch { device.value = session.deviceId()?.let { db.catalog().device(it) } }

    // a new login, if one was typed, then Connect: signs in now and says how it went
    fun connect(username: String?, password: String?, areaCode: String?) = viewModelScope.launch {
        if (busy.value) return@launch
        busy.value = true
        said.value = null
        if (username != null && password != null) login.save(username, password, areaCode.orEmpty())
        said.value = when (val r = sender.connect()) {
            is MraSender.Connected -> "Connected to the MRA" + (r.until?.let { " until ${hm(it)}" } ?: "") + "." to true
            is MraSender.NotConnected -> r.why to false
        }
        load()
        busy.value = false
        // what waited goes now
        sender.tick()
    }

    fun sendAgain(id: String) = viewModelScope.launch { sender.sendAgain(id) }

    companion object {
        fun hm(ms: Long): String = SimpleDateFormat("d MMM HH:mm", Locale.UK).format(Date(ms))
    }
}

@Composable
internal fun MraSettingsPage(can: Boolean, guard: (then: () -> Unit) -> Unit, vm: MraViewModel = hiltViewModel()) {
    var shown by remember { mutableStateOf(false) }
    if (!can && !shown) {
        Locked("The MRA login is for managers.") { guard { shown = true } }
        return
    }
    LaunchedEffect(Unit) { vm.load() }
    val st by vm.settings.collectAsState()
    val login by vm.state.collectAsState()
    val device by vm.device.collectAsState()
    val counts by vm.counts.collectAsState()
    val problems by vm.problems.collectAsState()
    val problem by vm.problem.collectAsState()
    val environment by vm.environment.collectAsState()
    val busy by vm.busy.collectAsState()
    val said by vm.said.collectAsState()
    var changing by remember { mutableStateOf(false) }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }
    var area by remember { mutableStateOf("") }

    Note("Each sale goes to the MRA (Mauritius Revenue Authority) as it is paid, with this till's own MRA login. The login stays on this tablet: EasyPay never has it.")
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            T(device?.let { "${it.name} (${it.code})" } ?: "This till", 15.sp, 700)
            T(
                device?.mra_ebs_id?.let { "EBS MRA ID: $it. Typed by EasyPay." } ?: "This till has no EBS MRA ID yet. Ask EasyPay: it is typed in EasyPay's office.",
                13.sp, 500, if (device?.mra_ebs_id == null) V.AmberText else V.Text2, lines = 2,
            )
            T(
                when (st.mra) {
                    "training" -> "Training: sales go to the MRA as training invoices. Nothing counts."
                    "live" -> "Live: every sale goes to the MRA."
                    "setting_up" -> "Being set up: nothing goes to the MRA yet. The till can be connected now."
                    else -> "This business is not on the MRA."
                },
                13.sp, 500, V.Text2, lines = 2,
            )
        }
    }
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            T("MRA login", 15.sp, 700)
            if (login.username != null && !changing) {
                T("Username: ${login.username}" + (login.areaCode?.takeIf { it.isNotBlank() }?.let { " · Area code $it" } ?: ""), 14.sp, 500, V.Text2)
                val until = login.until
                when {
                    login.refused != null -> T("The MRA refused the login: ${login.refused}", 13.sp, 600, V.RedText, lines = 3)
                    until != null && until > System.currentTimeMillis() -> T("Connected until ${MraViewModel.hm(until)}.", 13.sp, 600, V.Green)
                    else -> T("Not connected yet.", 13.sp, 600, V.AmberText)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VBtn(if (busy) "Connecting..." else "Connect to the MRA", bg = V.Blue, fg = Color.White, height = 48.dp, radius = 12.dp, enabled = !busy) { vm.connect(null, null, null) }
                    VBtn("Change login", height = 48.dp, radius = 12.dp, enabled = !busy) { changing = true; user = login.username ?: ""; pass = ""; area = login.areaCode ?: "" }
                }
            } else {
                T("As the MRA gave it to the business. The area code is needed to send invoices.", 13.sp, 500, V.Text2, lines = 2)
                Field(user, { user = it.trim().take(100) }, "Username", Modifier.fillMaxWidth())
                Secret(pass, { pass = it.take(100) }, "Password")
                Field(area, { area = it.trim().take(20) }, "Area code", Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    VBtn(
                        if (busy) "Connecting..." else "Connect to the MRA", bg = V.Blue, fg = Color.White, height = 48.dp, radius = 12.dp,
                        enabled = !busy && user.isNotBlank() && pass.isNotEmpty() && area.isNotBlank(),
                    ) { vm.connect(user, pass, area); pass = ""; changing = false }
                    if (login.username != null) VBtn("Cancel", height = 48.dp, radius = 12.dp) { changing = false; pass = "" }
                }
            }
            said?.let { (words, ok) -> T(words, 13.sp, 600, if (ok) V.Green else V.RedText, lines = 3) }
        }
    }
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            T("Invoices", 15.sp, 700)
            val c = counts
            T(
                if (c == null || c.waiting == 0) "None waiting." else "${c.waiting} waiting" + (c.oldestWaiting?.let { " since ${MraViewModel.hm(it)}" } ?: "") + ". They go once the line is back.",
                13.sp, 500, V.Text2,
            )
            c?.lastFiscalised?.let { T("Last fiscalised ${MraViewModel.hm(it)}.", 13.sp, 500, V.Text2) }
            T("MRA counter: ${device?.mra_counter ?: 0}.", 13.sp, 500, V.Text2)
            problem?.let { T("The MRA refuses this till's invoices: $it", 13.sp, 600, V.RedText, lines = 3) }
            // the MRA said whether it counted them; a business live with us must be LIVE there too
            environment?.let { env ->
                if (com.restopos.core.mra.MraBanner.testAtMra(st.mra, env)) {
                    T("The MRA answers this till as TEST: its sales are fiscalised but do not count. Its EBS is not live with the MRA yet: the business registers it on the MRA's portal.", 13.sp, 600, V.RedText, lines = 4)
                } else {
                    T("The MRA counts this till's invoices as $env.", 13.sp, 500, V.Text2)
                }
            }
        }
    }
    if (problems.isNotEmpty()) {
        Heading("To check")
        problems.forEach { e ->
            Panel {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f).padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        T("${e.identifier} · ${e.type}", 14.sp, 700)
                        T(
                            if (e.status == "check") "Sent twice with no answer: it may be at the MRA already. Check before sending again."
                            else "Refused by the MRA: " + e.errors.trim('[', ']').replace("\"", ""),
                            13.sp, 500, if (e.status == "refused") V.RedText else V.AmberText, lines = 3,
                        )
                    }
                    if (e.status == "check") Small("Send again") { vm.sendAgain(e.id) }
                }
            }
        }
    }
}

// a password box: what is typed is never shown
@Composable
private fun Secret(value: String, onChange: (String) -> Unit, placeholder: String) {
    Box(
        Modifier.fillMaxWidth().height(46.dp).clip(RoundedCornerShape(10.dp)).background(V.Well).border(1.dp, V.Stroke, RoundedCornerShape(10.dp)).padding(horizontal = 12.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        if (value.isEmpty()) T(placeholder, 15.sp, 400, V.Text3)
        BasicTextField(
            value, onChange, Modifier.fillMaxWidth(), singleLine = true,
            textStyle = TextStyle(color = V.Text, fontSize = 15.sp, fontWeight = FontWeight.Medium),
            cursorBrush = SolidColor(V.Blue),
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
    }
}

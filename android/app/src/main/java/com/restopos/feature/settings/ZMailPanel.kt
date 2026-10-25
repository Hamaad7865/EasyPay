package com.restopos.feature.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.data.ZMail
import com.restopos.core.data.ZMailRules
import com.restopos.core.data.ZMailSetting
import com.restopos.core.ui.Field
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// Settings > Cash drawer: the Z report by email (ZMail), this till's own
// setting. Anyone sees it; changing it asks for someone who may set the till
// up: it is where the business's figures go.
@HiltViewModel
class ZMailViewModel @Inject constructor(private val zMail: ZMail) : ViewModel() {
    val setting: StateFlow<ZMailSetting?> = zMail.setting.stateIn(viewModelScope, SharingStarted.Eagerly, null)
    val waiting = MutableStateFlow(0)
    val busy = MutableStateFlow(false)
    val said = MutableStateFlow<Pair<String, Boolean>?>(null) // what Save answered, and whether it went well

    // how the address stands is asked of the mail service each time the page opens
    fun load() = viewModelScope.launch { waiting.value = zMail.waiting(); zMail.check() }

    fun save(on: Boolean, to: String) = viewModelScope.launch {
        if (busy.value) return@launch
        busy.value = true
        said.value = zMail.save(on, to).fold(
            { s -> (if (s.on) "Saved." else "Saved: the Z report is no longer emailed from this till.") to true },
            { (it.message ?: "Not saved.") to false },
        )
        waiting.value = zMail.waiting()
        busy.value = false
    }

    fun again() = viewModelScope.launch { zMail.again(); said.value = "The email to confirm goes again as soon as the tablet is online." to true }

    companion object {
        fun stamp(ms: Long): String = SimpleDateFormat("d MMM HH:mm", Locale.UK).format(Date(ms))
    }
}

@Composable
internal fun ZMailPanel(can: Boolean, guard: (then: () -> Unit) -> Unit, vm: ZMailViewModel = hiltViewModel()) {
    val setting by vm.setting.collectAsState()
    val st = setting ?: return
    val waiting by vm.waiting.collectAsState()
    val busy by vm.busy.collectAsState()
    val said by vm.said.collectAsState()
    var on by remember(st.on) { mutableStateOf(st.on) }
    var to by remember(st.to) { mutableStateOf(st.to) }
    LaunchedEffect(Unit) { vm.load() }
    // a change is made by someone who may set the till up, or with their approval
    val allowed = { then: () -> Unit -> if (can) then() else guard(then) }

    Note("Each day closing of this till is emailed to this address too, as its paper prints it. The address is asked first: EasyPay emails it once, with a Confirm button. With no internet at closing, the email goes when the tablet is back online. Each till has its own setting.")
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Choice("Email the Z report", listOf("on" to "On", "off" to "Off"), if (on) "on" else "off") { on = it == "on" }
            if (on) Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                T("Send to", 15.sp, 700)
                Field(to, { v -> to = v.filter { !it.isWhitespace() }.take(254) }, "owner@example.com", Modifier.fillMaxWidth(), height = 50.dp, size = 17.sp, email = true)
            }
            // how it stands, once it was saved on
            if (st.on) {
                val w = ZMailRules.words(st, waiting) { ZMailViewModel.stamp(it) }
                val tone = when (st.state) {
                    ZMailRules.YES -> V.Green
                    ZMailRules.ASK, ZMailRules.WAITING -> V.AmberText
                    else -> V.RedText
                }
                T(w.text, 13.sp, 600, tone, lines = 4)
                if (w.again) Row { Small("Send the email to confirm again", enabled = !busy) { allowed { vm.again() } } }
            }
        }
    }
    said?.let { (words, ok) -> T(words, 13.sp, 600, if (ok) V.Text2 else V.RedText, lines = 3) }
    Row { VBtn(if (busy) "Saving..." else "Save", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800, enabled = !busy) { allowed { vm.save(on, to) } } }
}

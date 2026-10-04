package com.restopos.feature.staff

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
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
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.PinHash
import com.restopos.core.data.Approvals
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffRepository
import com.restopos.core.data.StaffSession
import com.restopos.core.ui.Pos
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

// When the person signed in may not do what they just tried, someone who may
// enters their own PIN, and the same thing is done again with their go-ahead.
@HiltViewModel
class ApprovalViewModel @Inject constructor(
    private val approvals: Approvals,
    private val repo: StaffRepository,
    private val staffSession: StaffSession,
) : ViewModel() {
    val request: StateFlow<Approvals.Request?> = approvals.request
    val current: StateFlow<StaffMember?> = staffSession.current

    // null while looking
    private val _who = MutableStateFlow<List<StaffMember>?>(null)
    val who: StateFlow<List<StaffMember>?> = _who

    // Everyone with a PIN who may do it. They need not be clocked in: a
    // manager walks over from the office.
    fun load(permission: String) = viewModelScope.launch {
        _who.value = null
        _who.value = repo.staffNow().filter { it.hasPin && it.can(permission) }
    }

    // Wrong PINs lock that name for a minute, as on the start screen.
    suspend fun check(member: StaffMember, pin: String): PinCheck {
        val id = member.employee.id
        staffSession.lockedFor(id).takeIf { it > 0 }?.let { return PinCheck.Locked((it + 999) / 1000) }
        val ok = withContext(Dispatchers.Default) { PinHash.matches(pin, member.employee.pin_hash) }
        return if (ok) { staffSession.rightPin(id); PinCheck.Ok }
        else {
            staffSession.wrongPin(id)
            staffSession.lockedFor(id).takeIf { it > 0 }?.let { PinCheck.Locked((it + 999) / 1000) } ?: PinCheck.Wrong
        }
    }

    fun approve(member: StaffMember) {
        val r = approvals.request.value ?: return
        approvals.done()
        r.then(member)
    }

    fun cancel() = approvals.done()
}

// Sits over every screen: shows nothing until an approval is asked for.
@Composable
fun ApprovalHost(vm: ApprovalViewModel = hiltViewModel()) {
    val request by vm.request.collectAsState()
    val who by vm.who.collectAsState()
    val current by vm.current.collectAsState()
    val r = request ?: return
    var picked by remember(r) { mutableStateOf<StaffMember?>(null) }
    LaunchedEffect(r) { vm.load(r.permission) }
    val member = picked
    if (member != null) {
        PinPad(member, check = { vm.check(member, it) }, onOk = { vm.approve(member) }, onDismiss = { picked = null })
        return
    }
    val list = who
    AlertDialog(
        onDismissRequest = { vm.cancel() },
        title = { Text("Approval needed") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    "${current?.employee?.name ?: "You"} may not ${r.what}. Someone who may can approve it with their own PIN.",
                    Modifier.padding(bottom = 6.dp), color = Pos.Text2, fontSize = 14.sp,
                )
                if (list != null && list.isEmpty()) {
                    Text("Nobody with a PIN is allowed to do this. Roles and PINs are set in the back office, under Staff.", color = Pos.Warn, fontSize = 14.sp)
                }
                list.orEmpty().forEach { m ->
                    Row(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).background(Pos.Key).clickable { picked = m }.padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(m.employee.name, Modifier.weight(1f), color = Pos.Text, fontSize = 16.sp)
                        RoleBadge(m.role)
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { OutlinedButton(onClick = { vm.cancel() }) { Text("Cancel") } },
    )
}

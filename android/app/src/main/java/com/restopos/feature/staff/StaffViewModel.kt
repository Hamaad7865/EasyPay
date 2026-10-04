package com.restopos.feature.staff

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.restopos.core.common.PinHash
import com.restopos.core.data.Approvals
import com.restopos.core.data.NeedsApproval
import com.restopos.core.data.StaffMember
import com.restopos.core.data.StaffRepository
import com.restopos.core.data.StaffSession
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.network.ApiClient
import com.restopos.core.sync.SessionStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

data class TillInfo(val business: String? = null, val store: String? = null, val device: String? = null)

sealed interface PinCheck {
    data object Ok : PinCheck
    data object Wrong : PinCheck
    data class Locked(val seconds: Long) : PinCheck
}

// What a closed shift came to, for the screen shown after the count.
data class Closing(val float: Long, val cash: Long, val expected: Long, val counted: Long)

// Behind the start screen, clock in/out and the cash count: who works here,
// who is clocked in, and this till's shift. All of it from Room.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class StaffViewModel @Inject constructor(
    private val repo: StaffRepository,
    private val session: SessionStore,
    private val staffSession: StaffSession,
    private val db: TillDatabase,
    private val api: ApiClient,
    private val approvals: Approvals,
) : ViewModel() {
    private val _info = MutableStateFlow(TillInfo())
    val info: StateFlow<TillInfo> = _info

    private val storeId = flow { emit(session.storeId()) }
    private val deviceId = flow { emit(session.deviceId()) }

    // null while loading
    val staff: StateFlow<List<StaffMember>?> = storeId
        .flatMapLatest { s -> if (s == null) emptyFlow() else repo.staff(s) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val shift: StateFlow<ShiftEntity?> = deviceId
        .flatMapLatest { d -> if (d == null) emptyFlow() else repo.openShift(d) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val needsSignIn: StateFlow<Boolean> = session.needsSignIn
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    val pending: StateFlow<Long> = db.outbox().pendingCountFlow()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    val current: StateFlow<StaffMember?> = staffSession.current

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun messageShown() { _message.value = null }

    private val _suggested = MutableStateFlow(0L)
    val suggested: StateFlow<Long> = _suggested
    private val _closing = MutableStateFlow<Closing?>(null)
    val closing: StateFlow<Closing?> = _closing
    private val _openOrders = MutableStateFlow(0L)
    val openOrders: StateFlow<Long> = _openOrders

    init {
        viewModelScope.launch {
            val store = session.storeId()?.let { db.catalog().store(it) }
            val device = session.deviceId()?.let { db.catalog().device(it) }
            _info.value = TillInfo(
                business = session.businessName(),
                store = store?.name,
                device = device?.let { if (it.name == it.code) it.code else "${it.name} (${it.code})" },
            )
            _suggested.value = repo.suggestedFloat()
            _openOrders.value = db.tickets().unpaidOrderCount()
            // A till set up before the name was kept: ask once, when online.
            if (_info.value.business == null) {
                runCatching { api.me() }.onSuccess { me ->
                    me.tenants.firstOrNull { it.id == me.tenantId }?.name?.let { name ->
                        session.setBusinessName(name)
                        _info.value = _info.value.copy(business = name)
                    }
                }
            }
        }
    }

    // The hash takes a moment by design; keep it off the main thread.
    suspend fun checkPin(member: StaffMember, pin: String): PinCheck {
        val id = member.employee.id
        staffSession.lockedFor(id).takeIf { it > 0 }?.let { return PinCheck.Locked((it + 999) / 1000) }
        val ok = withContext(Dispatchers.Default) { PinHash.matches(pin, member.employee.pin_hash) }
        return if (ok) { staffSession.rightPin(id); PinCheck.Ok }
        else {
            staffSession.wrongPin(id)
            staffSession.lockedFor(id).takeIf { it > 0 }?.let { PinCheck.Locked((it + 999) / 1000) } ?: PinCheck.Wrong
        }
    }

    fun clock(member: StaffMember, kind: String) = viewModelScope.launch {
        repo.punch(member, kind).fold(
            onSuccess = { _message.value = "${member.employee.name} clocked ${if (kind == "in") "in" else "out"}" },
            onFailure = { _message.value = it.message },
        )
    }

    // Clocking in is also signing in: the PIN was just entered, so the person
    // goes straight on. With a shift open, to the register. With none, to the
    // cash count that opens it, if they are allowed to open one; if not, they
    // are clocked in and wait for someone who is.
    fun clockIn(member: StaffMember, toRegister: () -> Unit, toCashCount: () -> Unit) = viewModelScope.launch {
        repo.punch(member, "in").fold(
            onSuccess = {
                val open = session.deviceId()?.let { repo.openShift(it).first() }
                when {
                    open != null -> { session.setPendingDiscount(null); staffSession.signIn(member); toRegister() }
                    member.can("shift.open_close") -> { session.setPendingDiscount(null); staffSession.signIn(member); toCashCount() }
                    else -> _message.value = "${member.employee.name} is clocked in. The shift is closed: someone allowed to open it has to clock in."
                }
            },
            onFailure = { _message.value = it.message },
        )
    }

    // After the right PIN on the start screen. A discount the last person
    // picked does not carry over to this one.
    fun signIn(member: StaffMember, then: () -> Unit) = viewModelScope.launch {
        session.setPendingDiscount(null)
        staffSession.signIn(member)
        then()
    }

    fun signOut() = staffSession.signOut()

    fun say(text: String) { _message.value = text }

    fun open(float: Long, then: () -> Unit) = viewModelScope.launch {
        repo.open(float).fold(onSuccess = { then() }, onFailure = { _message.value = it.message })
    }

    // Someone who may not close the shift asks for someone who may.
    fun close(counted: Long, by: StaffMember? = null): Job = viewModelScope.launch {
        val out = repo.close(counted, by)
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) { approvals.ask(need.permission, need.what) { approver -> close(counted, approver) }; return@launch }
        out.fold(
            onSuccess = { s ->
                val expected = s.expected_cash ?: s.opening_float
                _closing.value = Closing(s.opening_float, expected - s.opening_float, expected, counted)
            },
            onFailure = { _message.value = it.message },
        )
    }

    // The drawer counted during the shift: the same comparison, and the shift stays open.
    fun count(counted: Long, by: StaffMember? = null): Job = viewModelScope.launch {
        val out = repo.count(counted, by)
        val need = out.exceptionOrNull() as? NeedsApproval
        if (need != null && by == null) { approvals.ask(need.permission, need.what) { approver -> count(counted, approver) }; return@launch }
        out.fold(
            onSuccess = { c ->
                val float = db.staff().shift(c.shift_id)?.opening_float ?: 0
                _closing.value = Closing(float, c.expected - float, c.expected, c.counted)
            },
            onFailure = { _message.value = it.message },
        )
    }
}

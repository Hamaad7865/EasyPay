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

// How the drawer compared, for the screen shown after a count.
data class Closing(val float: Long, val cash: Long, val expected: Long, val counted: Long)

// Behind the start screen, clock in/out and the cash count: who works here,
// who is clocked in, and this till's day. All of it from Room.
@OptIn(ExperimentalCoroutinesApi::class)
@HiltViewModel
class StaffViewModel @Inject constructor(
    private val repo: StaffRepository,
    private val session: SessionStore,
    private val staffSession: StaffSession,
    private val db: TillDatabase,
    private val api: ApiClient,
    private val approvals: Approvals,
    private val door: com.restopos.core.data.SetupDoor,
    private val autoClose: com.restopos.core.data.AutoClose,
) : ViewModel() {
    private val _info = MutableStateFlow(TillInfo())
    val info: StateFlow<TillInfo> = _info

    // ---- the first-run set-up (server 0089) ----
    // The business's set-up is still open and this tablet has not closed it:
    // the start screen offers to finish it.
    val setupOpen: StateFlow<Boolean> = kotlinx.coroutines.flow.combine(db.ops().settingsFlow(), session.setupClosed) { s, closed ->
        com.restopos.core.data.PosSettings.parse(s).setupOpen && !closed
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)

    // Opens the set-up from the start screen, where nobody is signed in.
    // On a till without PINs it opens as the register does, with one tap,
    // and what it saves is the till's login's, as everything there is. Where
    // staff use PINs, someone who may set up the till enters theirs and is
    // signed in for the set-up: what it saves is then theirs and is held to
    // their rights. Without that the server would take every save as the
    // till's login's, which is nearly always the owner's, and a manager at
    // the tablet could set the owner's PIN. They need not be clocked in;
    // coming back to the start screen signs them out, as it signs anyone out.
    // It never asks staffSession.can: with nobody signed in that answers yes.
    fun setUp(then: () -> Unit) {
        val all = staff.value ?: return
        door.approver = null
        if (all.none { it.hasPin }) then()
        else approvals.ask("settings.device", "set this till up") { member -> staffSession.signIn(member); then() }
    }

    private val storeId = flow { emit(session.storeId()) }
    private val deviceId = flow { emit(session.deviceId()) }

    // null while loading
    val staff: StateFlow<List<StaffMember>?> = storeId
        .flatMapLatest { s -> if (s == null) emptyFlow() else repo.staff(s) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val shift: StateFlow<ShiftEntity?> = deviceId
        .flatMapLatest { d -> if (d == null) emptyFlow() else repo.openShift(d) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    // The tablet works on its own (the offline plan): it does not sync, and says nothing of signing in or of changes waiting.
    val alone: StateFlow<Boolean> = db.ops().settingsFlow().map { com.restopos.core.data.PosSettings.parse(it).alone }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    val needsSignIn: StateFlow<Boolean> = kotlinx.coroutines.flow.combine(session.needsSignIn, alone) { wanted, a -> wanted && !a }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    val pending: StateFlow<Long> = kotlinx.coroutines.flow.combine(db.outbox().pendingCountFlow(), alone) { n, a -> if (a) 0L else n }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    val current: StateFlow<StaffMember?> = staffSession.current

    private val _message = MutableStateFlow<String?>(null)
    val message: StateFlow<String?> = _message
    fun messageShown() { _message.value = null }

    private val _suggested = MutableStateFlow(0L)
    val suggested: StateFlow<Long> = _suggested
    private val _closing = MutableStateFlow<Closing?>(null)
    val closing: StateFlow<Closing?> = _closing
    // sales from before that no closing covers: opening the day closes them first
    private val _unclosed = MutableStateFlow(false)
    val unclosed: StateFlow<Boolean> = _unclosed

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
            _unclosed.value = repo.unclosed()
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

    // Clocking in records that someone has arrived, and nothing else: it
    // does not open the day. With the day open the person goes straight on to
    // the register, since the PIN was just entered. With the day not open,
    // someone allowed to open it is asked whether to (offerOpen); anyone else
    // is clocked in and waits for someone who may.
    // Someone who may not open the day is let in all the same: the till
    // takes no order then, and its strip says the day is not open (SellGate).
    fun clockIn(member: StaffMember, toRegister: () -> Unit, offerOpen: () -> Unit) = viewModelScope.launch {
        repo.punch(member, "in").fold(
            onSuccess = {
                // a day left open last night is closed first, if the business closes days by itself (AutoClose)
                autoClose.settled()
                val open = session.deviceId()?.let { repo.openShift(it).first() }
                when {
                    open != null -> { session.setPendingDiscount(null); staffSession.signIn(member); toRegister() }
                    member.can("shift.open_close") -> offerOpen()
                    else -> { session.setPendingDiscount(null); staffSession.signIn(member); toRegister() }
                }
            },
            onFailure = { _message.value = it.message },
        )
    }

    // After the right PIN on the start screen. A discount the last person
    // picked does not carry over to this one. A day left open last night is
    // closed first, if the business closes days by itself (AutoClose).
    fun signIn(member: StaffMember, then: () -> Unit) = viewModelScope.launch {
        autoClose.settled()
        session.setPendingDiscount(null)
        staffSession.signIn(member)
        then()
    }

    // In to look, with no clocking in and no day open: everything that takes
    // no order and moves no money, as their role allows (SellGate).
    fun lookOnly(member: StaffMember, then: () -> Unit) = viewModelScope.launch {
        autoClose.settled()
        session.setPendingDiscount(null)
        staffSession.signIn(member, lookOnly = true)
        then()
    }

    fun signOut() = staffSession.signOut()

    fun say(text: String) { _message.value = text }

    // Opening the day starts with the drawer open, so that the cash in it
    // can be counted. Once for a visit to the screen: Android rebuilding the
    // screen must not open the drawer a second time. When the printer does
    // not answer the person is told, since the drawer then needs its key.
    private var drawerAsked = false
    private val _drawerOpen = MutableStateFlow(false)
    val drawerOpen: StateFlow<Boolean> = _drawerOpen
    fun drawerForOpening() {
        if (drawerAsked) return
        drawerAsked = true
        viewModelScope.launch {
            repo.openDrawerToCount().onSuccess { _drawerOpen.value = it }.onFailure { _message.value = "The drawer did not open. ${it.message ?: "The printer did not answer."}" }
        }
    }

    fun open(float: Long, then: () -> Unit) = viewModelScope.launch {
        repo.open(float).fold(onSuccess = { then() }, onFailure = { _message.value = it.message })
    }

    // The drawer counted during the day: how it compares, and the day stays open.
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

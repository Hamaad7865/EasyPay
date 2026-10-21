package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject
import javax.inject.Singleton

// The gate (SellGate) as this till stands: the strip along the top of the
// till reads `blocked`; every op helper that writes an order or money calls
// check, which reads the day afresh and refuses with NotSelling, so no
// screen can get past it, missed in a list or not.
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@Singleton
class SellCheck @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val closing = MutableStateFlow(false)
    fun closing(on: Boolean) { closing.value = on }

    // whether anyone here has a PIN: until then the till has no days (StartScreen)
    private val usesDays: StateFlow<Boolean?> = flow { emit(session.storeId()) }
        .flatMapLatest { s -> if (s == null) flowOf(false) else db.staff().staff(s).map { list -> list.any { it.pin_hash != null } } }
        .stateIn(scope, SharingStarted.Eagerly, null)
    private val dayOpen = flow { emit(session.deviceId()) }
        .flatMapLatest { d -> if (d == null) flowOf(false) else db.staff().openShiftFlow(d).map { it != null } }

    // what the strip says, or null while the till sells
    val blocked: StateFlow<Blocked?> = combine(usesDays, dayOpen, staff.current, staff.lookOnly, closing) { uses, open, who, look, shut ->
        SellGate.why(uses ?: false, open, look, who?.can("shift.open_close") == true, shut)
    }.stateIn(scope, SharingStarted.Eagerly, null)

    // Before an op is written. Whether PINs are in use is taken from what was
    // last read (a PIN set or cleared is rare); the day is read now. Not yet
    // read is taken for PINs in use: the day decides.
    suspend fun check(type: String) {
        if (type !in SellGate.SELLING) return
        val device = session.deviceId() ?: return
        val b = SellGate.why(
            usesDays.value ?: true, db.staff().openShift(device) != null, staff.lookOnly.value,
            staff.current.value?.can("shift.open_close") == true, closing.value,
        )
        if (b != null) throw NotSelling(b)
    }
}

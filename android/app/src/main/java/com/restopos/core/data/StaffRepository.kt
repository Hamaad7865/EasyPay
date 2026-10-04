package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.EmployeeEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.PunchEntity
import com.restopos.core.database.ShiftEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

data class StaffMember(
    val employee: EmployeeEntity,
    val role: String?,
    val permissions: Set<String>,
    val clockedInAt: Long?, // null = not clocked in
) {
    val hasPin get() = employee.pin_hash != null
    fun can(permission: String) = permissions.contains("*") || permissions.contains(permission)
}

// Thrown by something the person signed in may not do. The screen catches it
// and asks for someone who may, to enter their own PIN.
class NeedsApproval(val permission: String, val what: String) : Exception("You are not allowed to $what. Ask a manager.")

// Hands a need for approval on, out of the Result an operation returns, so the
// screen can ask for it.
fun <T> Result<T>.orAsk(): Result<T> = onFailure { if (it is NeedsApproval) throw it }

// Asking for an approval: one request at a time, shown over whatever screen is
// open. `then` runs with the person who approved.
@Singleton
class Approvals @Inject constructor() {
    class Request(val permission: String, val what: String, val then: (StaffMember) -> Unit)
    private val _request = MutableStateFlow<Request?>(null)
    val request: StateFlow<Request?> = _request
    fun ask(permission: String, what: String, then: (StaffMember) -> Unit) { _request.value = Request(permission, what, then) }
    fun done() { _request.value = null }
}

// Who is signed in at this till right now. Kept in memory only: every time
// the app opens it starts on the start screen (spec 7.1).
@Singleton
class StaffSession @Inject constructor() {
    private val _current = MutableStateFlow<StaffMember?>(null)
    val current: StateFlow<StaffMember?> = _current
    fun signIn(member: StaffMember) { _current.value = member }
    fun signOut() { _current.value = null }
    fun id(): String? = _current.value?.employee?.id
    // On a till with no staff PINs nobody is signed in and nothing is held back.
    fun can(permission: String): Boolean = _current.value?.can(permission) ?: true

    // The person signed in may, or the person who approved may. If neither,
    // the caller is told what to ask for.
    fun allow(permission: String, what: String, approver: StaffMember?) {
        if (can(permission) || approver?.can(permission) == true) return
        throw NeedsApproval(permission, what)
    }

    // For an op's payload: who approved it, when the person signed in could
    // not have done it alone.
    fun approvedBy(permission: String, approver: StaffMember?): String? = approver?.takeIf { !can(permission) }?.employee?.id

    // Wrong PINs: five in a row for one person locks that name for a minute.
    private val misses = HashMap<String, Int>()
    private val lockedUntil = HashMap<String, Long>()
    fun lockedFor(employeeId: String): Long = ((lockedUntil[employeeId] ?: 0) - System.currentTimeMillis()).coerceAtLeast(0)
    fun wrongPin(employeeId: String) {
        val n = (misses[employeeId] ?: 0) + 1
        if (n >= 5) { misses.remove(employeeId); lockedUntil[employeeId] = System.currentTimeMillis() + 60_000 }
        else misses[employeeId] = n
    }
    fun rightPin(employeeId: String) { misses.remove(employeeId); lockedUntil.remove(employeeId) }
}

// Staff, clock punches and the shift, all read from and written to
// Room; every write queues its op in the same transaction (spec 5.1).
@Singleton
class StaffRepository @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staffSession: StaffSession,
    private val cash: CashOps,
    @ApplicationContext private val context: Context,
) {
    private val json = Json { ignoreUnknownKeys = true }

    private fun perms(text: String?): Set<String> =
        runCatching { json.parseToJsonElement(text ?: "[]").jsonArray.map { it.jsonPrimitive.content }.toSet() }.getOrDefault(emptySet())

    // Everyone who may use this store's tills, with their role and whether
    // they are clocked in.
    fun staff(store: String): Flow<List<StaffMember>> =
        combine(db.staff().staff(store), db.staff().roles(), db.staff().punches(store)) { employees, roles, punches ->
            val byRole = roles.associateBy { it.id }
            val last = HashMap<String, PunchEntity>()
            punches.forEach { last[it.employee_id] = it }
            employees.map { e ->
                val role = e.role_id?.let { byRole[it] }
                StaffMember(e, role?.name, perms(role?.permissions), last[e.id]?.takeIf { it.kind == "in" }?.device_time)
            }
        }

    // The till asks for PINs once anyone here has one. Until then it opens
    // the way it always has, so an update never locks a restaurant out.
    fun pinsInUse(store: String): Flow<Boolean> = staff(store).map { list -> list.any { it.hasPin } }

    fun openShift(device: String): Flow<ShiftEntity?> = db.staff().openShiftFlow(device)

    private fun op(type: String, employee: String?, payload: JsonObject) =
        OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = employee)

    suspend fun punch(member: StaffMember, kind: String): Result<Unit> = runCatching {
        val store = session.storeId() ?: error("no store")
        val tenant = session.tenantId() ?: error("no tenant")
        val device = session.deviceId()
        val id = Uuid7.next()
        val now = System.currentTimeMillis()
        db.withTransaction {
            db.staff().upsertPunches(listOf(PunchEntity(id, tenant, store, device, member.employee.id, kind, now)))
            db.outbox().enqueue(op("timeclock.punch", member.employee.id, buildJsonObject {
                put("id", id); put("store_id", store); device?.let { put("device_id", it) }
                put("kind", kind); put("device_time", Instant.ofEpochMilli(now).toString())
            }))
        }
        pushNow(context)
    }

    // What the drawer was left with when this till's last period closed: the
    // amount offered when the next one opens.
    suspend fun suggestedFloat(): Long {
        val device = session.deviceId() ?: return 0
        return db.staff().lastClosedShift(device)?.counted_cash ?: 0
    }

    suspend fun open(float: Long): Result<ShiftEntity> = runCatching {
        val who = staffSession.current.value ?: error("Sign in first")
        require(who.can("shift.open_close")) { "${who.employee.name} is not allowed to open a sales period" }
        require(float >= 0) { "bad amount" }
        val store = session.storeId() ?: error("no store")
        val tenant = session.tenantId() ?: error("no tenant")
        val device = session.deviceId() ?: error("no device")
        db.staff().openShift(device)?.let { return@runCatching it } // one per till
        val now = System.currentTimeMillis()
        val shift = ShiftEntity(Uuid7.next(), tenant, store, device, who.employee.id, now, float)
        db.withTransaction {
            db.staff().upsertShifts(listOf(shift))
            db.outbox().enqueue(op("shift.open", who.employee.id, buildJsonObject {
                put("id", shift.id); put("device_id", device); put("opening_float", float)
                put("opened_at", Instant.ofEpochMilli(now).toString())
            }))
        }
        pushNow(context)
        shift
    }

    // What should be in the drawer: the opening amount plus the cash this
    // till has taken since. The server works out the same figure on close.
    // Refunds paid in cash come off; cash put in and taken out counts.
    suspend fun expectedCash(shift: ShiftEntity): Long = cash.expectedCash(shift)

    suspend fun close(counted: Long, approver: StaffMember? = null): Result<ShiftEntity> = runCatching {
        val who = staffSession.current.value ?: error("Sign in first")
        staffSession.allow("shift.open_close", "close the sales period", approver)
        require(counted >= 0) { "bad amount" }
        val device = session.deviceId() ?: error("no device")
        val open = db.staff().openShift(device) ?: error("No sales period is open")
        val now = System.currentTimeMillis()
        val closed = open.copy(closed_by = who.employee.id, closed_at = now, counted_cash = counted, expected_cash = expectedCash(open))
        db.withTransaction {
            db.staff().upsertShifts(listOf(closed))
            db.outbox().enqueue(op("shift.close", who.employee.id, buildJsonObject {
                put("id", closed.id); put("counted_cash", counted)
                put("closed_at", Instant.ofEpochMilli(now).toString())
                staffSession.approvedBy("shift.open_close", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
        cash.printShiftBehind(closed)
        closed
    }

    // The drawer counted during the shift, which stays open.
    suspend fun count(counted: Long, approver: StaffMember? = null) = cash.count(counted, approver)

    suspend fun staffNow(): List<StaffMember> = session.storeId()?.let { staff(it).first() } ?: emptyList()
}

package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// Staff at the till (spec 7.2, 7.7): who may use it, who is clocked in, and
// the sales period on this till. Mirrors of the server tables, same names.
// Times are epoch millis here; the server keeps timestamps.

@Entity(tableName = "roles")
data class RoleEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val permissions: String, // the JSON array as text, e.g. ["sale.create","payment.take"]
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "employees")
data class EmployeeEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val pin_hash: String? = null,
    val role_id: String? = null,
    val is_active: Boolean = true,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "employee_stores", primaryKeys = ["employee_id", "store_id"])
data class EmployeeStoreEntity(
    val employee_id: String,
    val store_id: String,
    val tenant_id: String,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// A sales period on one till: opened with the cash in the drawer, closed with
// the cash that was counted.
@Entity(tableName = "shifts", indices = [Index("device_id")])
data class ShiftEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val opened_by: String? = null,
    val opened_at: Long,
    val opening_float: Long = 0,
    val closed_by: String? = null,
    val closed_at: Long? = null,
    val expected_cash: Long? = null,
    val counted_cash: Long? = null,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// One row per clock in or clock out, never changed. Someone is clocked in when
// their last punch is "in".
@Entity(tableName = "timeclock_punches", indices = [Index("store_id")])
data class PunchEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String? = null,
    val employee_id: String,
    val kind: String, // "in" or "out"
    val device_time: Long,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Dao
interface StaffDao {
    @Upsert suspend fun upsertRoles(rows: List<RoleEntity>)
    @Upsert suspend fun upsertEmployees(rows: List<EmployeeEntity>)
    @Upsert suspend fun upsertEmployeeStores(rows: List<EmployeeStoreEntity>)
    @Upsert suspend fun upsertShifts(rows: List<ShiftEntity>)
    @Upsert suspend fun upsertPunches(rows: List<PunchEntity>)

    // Who may use this store's tills: switched on, and either assigned to
    // this store or not assigned to any (then they work everywhere).
    @Query(
        """SELECT e.* FROM employees e WHERE e.deleted_at IS NULL AND e.is_active = 1
           AND (EXISTS (SELECT 1 FROM employee_stores s WHERE s.employee_id = e.id AND s.store_id = :store AND s.deleted_at IS NULL)
             OR NOT EXISTS (SELECT 1 FROM employee_stores s WHERE s.employee_id = e.id AND s.deleted_at IS NULL))
           ORDER BY e.name COLLATE NOCASE""",
    )
    fun staff(store: String): Flow<List<EmployeeEntity>>

    @Query("SELECT * FROM roles WHERE deleted_at IS NULL")
    fun roles(): Flow<List<RoleEntity>>

    @Query("SELECT * FROM roles WHERE id = :id")
    suspend fun role(id: String): RoleEntity?

    @Query("SELECT * FROM employees WHERE id = :id")
    suspend fun employee(id: String): EmployeeEntity?

    @Query("SELECT * FROM timeclock_punches WHERE store_id = :store AND deleted_at IS NULL ORDER BY device_time, rowid")
    fun punches(store: String): Flow<List<PunchEntity>>

    @Query("SELECT * FROM shifts WHERE device_id = :device AND closed_at IS NULL AND deleted_at IS NULL ORDER BY opened_at DESC LIMIT 1")
    fun openShiftFlow(device: String): Flow<ShiftEntity?>

    @Query("SELECT * FROM shifts WHERE device_id = :device AND closed_at IS NULL AND deleted_at IS NULL ORDER BY opened_at DESC LIMIT 1")
    suspend fun openShift(device: String): ShiftEntity?

    @Query("SELECT * FROM shifts WHERE id = :id")
    suspend fun shift(id: String): ShiftEntity?

    @Query("SELECT * FROM shifts WHERE device_id = :device AND closed_at IS NOT NULL AND deleted_at IS NULL ORDER BY closed_at DESC LIMIT 1")
    suspend fun lastClosedShift(device: String): ShiftEntity?

    // Cash this till took since a moment (a sales period's opening): what
    // went into the drawer, change already taken off, refunds paid out of it.
    @Query(
        """SELECT COALESCE(SUM(CASE WHEN r.type = 'refund' THEN -p.amount ELSE p.amount END), 0) FROM receipt_payments p
           JOIN receipts r ON r.id = p.receipt_id
           JOIN payment_types t ON t.id = p.payment_type_id
           WHERE r.device_id = :device AND r.deleted_at IS NULL
           AND t.kind = 'cash' AND r.device_time >= :since""",
    )
    suspend fun cashSince(device: String, since: Long): Long

    @Query("DELETE FROM roles") suspend fun clearRoles()
    @Query("DELETE FROM employees") suspend fun clearEmployees()
    @Query("DELETE FROM employee_stores") suspend fun clearEmployeeStores()

    // The mirror of who works here. Sales periods and punches stay: an
    // unsynced one exists only on this tablet.
    @Transaction
    suspend fun clearStaff() { clearEmployeeStores(); clearEmployees(); clearRoles() }
}

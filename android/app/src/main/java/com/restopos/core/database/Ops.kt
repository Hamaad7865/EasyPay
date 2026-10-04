package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// Printers, the restaurant's settings, cash put in and taken out of the
// drawer, and day closings. The first two come from the back office; the last
// two are made on this till and sent up.

@Entity(tableName = "printers", indices = [Index("store_id")])
data class PrinterEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val name: String,
    val kind: String = "network", // network | usb
    val address: String? = null, // ip or ip:port, network printers only
    val paper_mm: Int = 80,
    val is_receipt: Boolean = false, // the cashier's printer: receipts, bills, slips, reports, the drawer
    val feed_lines: Int = 3,
    val cut: Boolean = true,
    val is_active: Boolean = true,
    val sort_order: Int = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// One row: the settings as the JSON the back office saved.
@Entity(tableName = "pos_settings")
data class SettingsEntity(
    @PrimaryKey val tenant_id: String,
    val data: String,
)

@Entity(tableName = "cash_movements", indices = [Index("device_id")])
data class CashMoveEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val shift_id: String? = null,
    val employee_id: String? = null,
    val type: String, // in | out | drawer
    val amount: Long = 0,
    val reason: String? = null,
    val device_time: Long = System.currentTimeMillis(),
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "day_closes", indices = [Index("device_id")])
data class DayCloseEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val number: Int,
    val closed_by: String? = null,
    val from_time: Long? = null,
    val closed_at: Long,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// The cash counted in the drawer during a shift (a handover), with what the
// drawer should have held at that moment. Made on this till and sent up.
@Entity(tableName = "drawer_counts", indices = [Index("shift_id")])
data class DrawerCountEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val shift_id: String,
    val employee_id: String? = null,
    val counted: Long,
    val expected: Long,
    val device_time: Long = System.currentTimeMillis(),
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// A payment with its receipt's type and time, for the shift and day reports.
data class PaidRow(val receipt_id: String, val type: String, val payment_type_id: String, val amount: Long)

// A payment as the Payments list shows it: with its receipt's number and time.
data class PaymentRow(val id: String, val receipt_id: String, val number: String, val type: String, val device_time: Long, val payment_type_id: String, val amount: Long)

// What was sold of each category in a period.
data class CategorySale(val name: String?, val qty: Long, val amount: Long)

@Dao
interface OpsDao {
    @Upsert suspend fun upsertPrinters(rows: List<PrinterEntity>)
    @Upsert suspend fun upsertSettings(row: SettingsEntity)
    @Upsert suspend fun upsertCashMoves(rows: List<CashMoveEntity>)
    @Upsert suspend fun upsertDayCloses(rows: List<DayCloseEntity>)
    @Upsert suspend fun upsertDrawerCounts(rows: List<DrawerCountEntity>)

    @Query("SELECT * FROM drawer_counts WHERE shift_id = :shift AND deleted_at IS NULL ORDER BY device_time")
    suspend fun drawerCounts(shift: String): List<DrawerCountEntity>

    @Query("SELECT * FROM printers WHERE store_id = :store AND deleted_at IS NULL AND is_active ORDER BY sort_order, name")
    suspend fun printers(store: String): List<PrinterEntity>

    @Query("SELECT * FROM printers WHERE store_id = :store AND deleted_at IS NULL ORDER BY sort_order, name")
    fun printersFlow(store: String): Flow<List<PrinterEntity>>

    @Query("SELECT data FROM pos_settings LIMIT 1")
    suspend fun settings(): String?

    @Query("SELECT data FROM pos_settings LIMIT 1")
    fun settingsFlow(): Flow<String?>

    @Query("SELECT * FROM cash_movements WHERE device_id = :device AND deleted_at IS NULL AND device_time > :from AND device_time <= :to ORDER BY device_time")
    suspend fun cashMoves(device: String, from: Long, to: Long): List<CashMoveEntity>

    @Query("SELECT * FROM day_closes WHERE device_id = :device AND deleted_at IS NULL ORDER BY closed_at DESC LIMIT 1")
    suspend fun lastDayClose(device: String): DayCloseEntity?

    @Query("SELECT * FROM day_closes WHERE device_id = :device AND deleted_at IS NULL ORDER BY closed_at DESC LIMIT :limit")
    suspend fun dayCloses(device: String, limit: Int = 10): List<DayCloseEntity>

    @Query(
        """SELECT p.id, p.receipt_id, r.number, r.type, r.device_time, p.payment_type_id, p.amount FROM receipt_payments p
           JOIN receipts r ON r.id = p.receipt_id
           WHERE r.device_id = :device AND r.deleted_at IS NULL AND r.device_time > :from ORDER BY r.device_time DESC""",
    )
    fun paymentsSince(device: String, from: Long): Flow<List<PaymentRow>>

    @Query("SELECT * FROM receipts WHERE device_id = :device AND deleted_at IS NULL AND device_time > :from AND device_time <= :to ORDER BY device_time")
    suspend fun receiptsBetween(device: String, from: Long, to: Long): List<ReceiptEntity>

    @Query(
        """SELECT p.receipt_id, r.type, p.payment_type_id, p.amount FROM receipt_payments p
           JOIN receipts r ON r.id = p.receipt_id
           WHERE r.device_id = :device AND r.deleted_at IS NULL AND r.device_time > :from AND r.device_time <= :to""",
    )
    suspend fun paidBetween(device: String, from: Long, to: Long): List<PaidRow>

    @Query("SELECT * FROM receipts WHERE id = :id")
    suspend fun receipt(id: String): ReceiptEntity?

    @Query("SELECT COALESCE(SUM(total), 0) FROM receipts WHERE refund_of = :id AND deleted_at IS NULL")
    suspend fun refundedOf(id: String): Long

    @Query("UPDATE receipt_payments SET payment_type_id = :to WHERE receipt_id = :receipt AND payment_type_id = :from")
    suspend fun retypePayments(receipt: String, from: String, to: String): Int

    @Query("UPDATE receipts SET doc = :doc WHERE id = :id")
    suspend fun setDoc(id: String, doc: String)

    @Query("SELECT * FROM payment_types WHERE id = :id")
    suspend fun paymentType(id: String): PaymentTypeEntity?

    @Query("SELECT * FROM payment_types WHERE deleted_at IS NULL")
    suspend fun allPaymentTypes(): List<PaymentTypeEntity>

    @Query("SELECT * FROM taxes")
    suspend fun allTaxes(): List<TaxEntity>

    @Query("SELECT c.* FROM categories c JOIN items i ON i.category_id = c.id WHERE i.id = :item")
    suspend fun categoryOfItem(item: String): CategoryEntity?

    @Query("SELECT * FROM dining_options WHERE id = :id")
    suspend fun dining(id: String): DiningOptionEntity?

    @Query("DELETE FROM item_taxes WHERE item_id = :item AND tax_id = :tax")
    suspend fun unlinkTax(item: String, tax: String)

    @Query("DELETE FROM item_modifier_groups WHERE item_id = :item AND group_id = :group")
    suspend fun unlinkGroup(item: String, group: String)

    @Query("DELETE FROM printers") suspend fun clearPrinters()
    @Query("DELETE FROM pos_settings") suspend fun clearSettings()
}

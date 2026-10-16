package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// A shop's deposit (server 0113): goods held for a customer who pays part
// now. Made on this tablet with its lines, its first payment and the stock it
// holds, in one transaction with its outbox op; or sent by the server (pulled)
// so a deposit taken at another till can be paid on or collected here. The
// money figures are what the tablet believes; the server's replace them on the
// next pull, as a credit note's balance does. "No variant" is "" here.
@Entity(tableName = "deposits", indices = [Index("number"), Index("status"), Index("customer_id")])
data class DepositEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val number: String,
    val customer_id: String? = null,
    val collect_by: String, // yyyy-mm-dd
    val status: String = "open", // open | collected | cancelled
    val total: Long = 0,
    val paid: Long = 0,
    val given_back: Long = 0,
    val used: Long = 0,
    val kept: Long = 0,
    val owed: Long = 0,
    val noted: Long = 0,
    val cancel_outcome: String? = null, // refund | credit | keep
    val cancel_reason: String? = null,
    val auto_cancelled: Boolean = false,
    val credit_note_id: String? = null,
    val created_by: String? = null,
    val device_time: Long = System.currentTimeMillis(),
    val cancelled_at: Long? = null,
    val server_seq: Long? = null,
    val pulled: Boolean = false,
)

// what is paid and not yet used, given back, kept, owed or put on a note
val DepositEntity.free: Long get() = paid - given_back - used - kept - owed - noted

@Entity(tableName = "deposit_lines", indices = [Index("deposit_id")])
data class DepositLineEntity(
    @PrimaryKey val id: String,
    val deposit_id: String,
    val item_id: String,
    val variant_id: String = "",
    val name: String,
    val qty: Int, // thousandths
    val qty_collected: Int = 0,
    val unit_price: Long, // the price kept: what the collection charges
    val list_price: Long? = null,
    val price_kind: String? = null,
    val price_label: String? = null,
    val price_by: String? = null,
    val sort: Int = 0,
)

// what of a line is still held for the customer
val DepositLineEntity.left: Int get() = (qty - qty_collected).coerceAtLeast(0)

@Entity(tableName = "deposit_payments", indices = [Index("deposit_id")])
data class DepositPaymentEntity(
    @PrimaryKey val id: String,
    val deposit_id: String,
    val payment_type_id: String,
    val kind: String, // in | back
    val amount: Long, // negative when money went back
    val tendered: Long? = null,
    val change: Long = 0,
    val shift_id: String? = null,
    val device_id: String? = null,
    val employee_id: String? = null,
    val device_time: Long = System.currentTimeMillis(),
)

// what a deposit's lines come to: all of them, and what is still held
data class DepositBases(val whole: Long, val held: Long)

@Dao
interface DepositDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(rows: List<DepositEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertLines(rows: List<DepositLineEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPayments(rows: List<DepositPaymentEntity>)

    @Query("DELETE FROM deposit_lines WHERE deposit_id = :deposit")
    suspend fun dropLines(deposit: String)

    @Query("DELETE FROM deposit_payments WHERE deposit_id = :deposit")
    suspend fun dropPayments(deposit: String)

    @Query("SELECT * FROM deposits WHERE id = :id")
    suspend fun deposit(id: String): DepositEntity?

    @Query("SELECT * FROM deposits WHERE id = :id")
    fun watch(id: String): Flow<DepositEntity?>

    @Query("SELECT * FROM deposits WHERE number = :number LIMIT 1")
    suspend fun byNumber(number: String): DepositEntity?

    @Query("SELECT * FROM deposit_lines WHERE deposit_id = :deposit ORDER BY sort")
    suspend fun lines(deposit: String): List<DepositLineEntity>

    @Query("SELECT * FROM deposit_lines WHERE deposit_id = :deposit ORDER BY sort")
    fun watchLines(deposit: String): Flow<List<DepositLineEntity>>

    @Query("SELECT * FROM deposit_lines WHERE id = :id")
    suspend fun line(id: String): DepositLineEntity?

    @Query("SELECT * FROM deposit_payments WHERE deposit_id = :deposit ORDER BY device_time")
    fun watchPayments(deposit: String): Flow<List<DepositPaymentEntity>>

    @Query("""SELECT COALESCE(SUM((unit_price * qty + 500) / 1000), 0) AS whole,
                     COALESCE(SUM((unit_price * MAX(qty - qty_collected, 0) + 500) / 1000), 0) AS held
              FROM deposit_lines WHERE deposit_id = :deposit""")
    suspend fun bases(deposit: String): DepositBases

    @Query("UPDATE deposit_lines SET qty_collected = qty_collected + :by WHERE id = :id")
    suspend fun collected(id: String, by: Int)

    // open ones first, then those with money owed back, then the rest; newest first in each
    @Query("""SELECT * FROM deposits
              ORDER BY CASE WHEN status = 'open' THEN 0 WHEN owed > 0 THEN 1 ELSE 2 END, device_time DESC LIMIT 500""")
    fun all(): Flow<List<DepositEntity>>

    @Query("SELECT * FROM deposits WHERE status = 'open'")
    suspend fun open(): List<DepositEntity>

    // deposits still to be dealt with: open, money owed back, or collected with money left over.
    // They stay reachable when the shop no longer takes new ones.
    @Query("""SELECT COUNT(*) FROM deposits WHERE status = 'open' OR owed > 0
              OR (status = 'collected' AND paid - given_back - used - kept - owed - noted > 0)""")
    suspend fun pending(): Int

    // the highest number this till has given, so a restored or moved tablet counts on
    @Query("SELECT number FROM deposits WHERE device_id = :device AND number LIKE :prefix || '%'")
    suspend fun numbersOf(device: String, prefix: String): List<String>

    // the shop's deposit type (server 0113): never active, found by its kind
    @Query("SELECT * FROM payment_types WHERE kind = 'deposit' AND deleted_at IS NULL LIMIT 1")
    suspend fun paymentType(): PaymentTypeEntity?

    // what of a period went in and out of deposits on this till, by payment type
    @Query("""SELECT * FROM deposit_payments WHERE device_id = :device AND device_time > :from AND device_time <= :to""")
    suspend fun paymentsBetween(device: String, from: Long, to: Long): List<DepositPaymentEntity>

    @Query("""SELECT * FROM deposits WHERE device_id = :device AND cancelled_at > :from AND cancelled_at <= :to""")
    suspend fun cancelledBetween(device: String, from: Long, to: Long): List<DepositEntity>

    // A deposit with something of its own still waiting to go up (one of its
    // operations, or a collection's bill naming it): the pull leaves it as the
    // tablet has it, since the server's copy is older.
    @Query("""SELECT COUNT(*) FROM outbox WHERE state = 'pending'
              AND ((type LIKE 'deposit.%' AND payload LIKE '%' || :id || '%')
                OR (type = 'receipt.create' AND payload LIKE '%"' || :number || '"%'))""")
    suspend fun waiting(id: String, number: String): Int
}

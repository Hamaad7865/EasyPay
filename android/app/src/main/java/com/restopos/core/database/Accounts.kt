package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// A shop's customer accounts (server 0114). A bill is the part of a sale paid
// "On account": its id is the sale receipt's. Written here with the sale, or
// sent by the server (pulled) so a customer can pay at any till. The figures
// are what the tablet believes; the server's replace them on the next pull,
// unless the tablet has a change of its own on the bill still waiting.
@Entity(tableName = "account_bills", indices = [Index("customer_id"), Index("number")])
data class AccountBillEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String? = null,
    val customer_id: String? = null,
    val number: String,
    val day: String, // yyyy-mm-dd, the store's day of the sale
    val amount: Long,
    val paid: Long = 0,
    val returned: Long = 0,
    val created_at: Long = System.currentTimeMillis(),
    val server_seq: Long? = null,
    val pulled: Boolean = false,
)

// what a bill still owes; below nothing it is paid over
val AccountBillEntity.owed: Long get() = amount - paid - returned

// Money taken at this till against a customer's bills.
@Entity(tableName = "account_payments", indices = [Index("customer_id"), Index("shift_id")])
data class AccountPaymentEntity(
    @PrimaryKey val id: String,
    val number: String,
    val customer_id: String,
    val store_id: String,
    val device_id: String,
    val shift_id: String? = null,
    val employee_id: String? = null,
    val payment_type_id: String,
    val amount: Long,
    val tendered: Long? = null,
    val change: Long = 0,
    val reference: String? = null,
    val device_time: Long = System.currentTimeMillis(),
)

// what one payment put on each bill
@Entity(tableName = "account_payment_lines", indices = [Index("payment_id"), Index("bill_id")])
data class AccountPaymentLineEntity(
    @PrimaryKey val id: String,
    val payment_id: String,
    val bill_id: String,
    val amount: Long,
)

// a customer who owes, as the Accounts screen lists them
data class AccountOwing(val customer_id: String, val name: String?, val phone: String?, val owed: Long, val bills: Int, val oldest: String?)

@Dao
interface AccountDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertBills(rows: List<AccountBillEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPayment(row: AccountPaymentEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPaymentLines(rows: List<AccountPaymentLineEntity>)

    @Query("SELECT * FROM account_bills WHERE id = :id")
    suspend fun bill(id: String): AccountBillEntity?

    @Query("DELETE FROM account_bills WHERE id = :id")
    suspend fun drop(id: String)

    @Query("SELECT * FROM account_bills WHERE id IN (:ids)")
    suspend fun bills(ids: List<String>): List<AccountBillEntity>

    // a customer's bills that still owe, oldest first
    @Query("SELECT * FROM account_bills WHERE customer_id = :customer AND amount - paid - returned > 0 ORDER BY day, number")
    fun open(customer: String): Flow<List<AccountBillEntity>>

    @Query("SELECT * FROM account_bills WHERE customer_id = :customer AND amount - paid - returned > 0 ORDER BY day, number")
    suspend fun openNow(customer: String): List<AccountBillEntity>

    @Query("SELECT COALESCE(SUM(amount - paid - returned), 0) FROM account_bills WHERE customer_id = :customer")
    suspend fun balance(customer: String): Long

    // everyone who owes, the most first
    @Query("""SELECT b.customer_id AS customer_id, c.name AS name, c.phone AS phone,
                     SUM(b.amount - b.paid - b.returned) AS owed, COUNT(*) AS bills, MIN(b.day) AS oldest
              FROM account_bills b LEFT JOIN customers c ON c.id = b.customer_id
              WHERE b.customer_id IS NOT NULL AND b.amount - b.paid - b.returned > 0
              GROUP BY b.customer_id ORDER BY owed DESC LIMIT 500""")
    fun owing(): Flow<List<AccountOwing>>

    @Query("SELECT COUNT(*) FROM account_bills WHERE amount - paid - returned > 0")
    suspend fun openCount(): Int

    @Query("SELECT * FROM account_payments WHERE id = :id")
    suspend fun payment(id: String): AccountPaymentEntity?

    @Query("SELECT * FROM account_payment_lines WHERE payment_id = :id")
    suspend fun paymentLines(id: String): List<AccountPaymentLineEntity>

    // the highest number this till has given, so a restored or moved tablet counts on
    @Query("SELECT number FROM account_payments WHERE device_id = :device AND number LIKE :prefix || '%'")
    suspend fun numbersOf(device: String, prefix: String): List<String>

    // the shop's account type (server 0114): never active, found by its kind
    @Query("SELECT * FROM payment_types WHERE kind = 'account' AND deleted_at IS NULL LIMIT 1")
    suspend fun paymentType(): PaymentTypeEntity?

    // what of a period was taken on accounts at this till
    @Query("SELECT * FROM account_payments WHERE device_id = :device AND device_time > :from AND device_time <= :to")
    suspend fun paymentsBetween(device: String, from: Long, to: Long): List<AccountPaymentEntity>

    // A bill with something of its own still waiting to go up (its sale, a
    // payment on it or a return off it): the pull leaves it as the tablet has
    // it, since the server's copy is older.
    @Query("""SELECT COUNT(*) FROM outbox WHERE state = 'pending'
              AND type IN ('receipt.create', 'refund.create', 'account.pay') AND payload LIKE '%' || :id || '%'""")
    suspend fun waiting(id: String): Int
}

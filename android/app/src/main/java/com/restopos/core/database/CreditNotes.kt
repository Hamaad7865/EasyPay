package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// A credit note (server 0109): what is left of a return once the new sale
// used its part. Made on this tablet with its refund, or sent by the server
// (pulled) so a note from another till can be spent here. balance is what
// the tablet believes; the server's figure replaces it on the next pull.
@Entity(tableName = "credit_notes", indices = [Index("number"), Index("refund_id")])
data class CreditNoteEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val number: String,
    val amount: Long,
    val balance: Long,
    val refund_id: String,
    val customer_id: String? = null,
    val valid_to: String? = null, // yyyy-mm-dd; null never expires
    val status: String = "open", // open | used | void
    val issued_by: String? = null,
    val created_at: Long = System.currentTimeMillis(),
    val server_seq: Long? = null,
    val pulled: Boolean = false,
)

@Dao
interface CreditNoteDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(rows: List<CreditNoteEntity>)

    @Query("SELECT * FROM credit_notes WHERE number = :number LIMIT 1")
    suspend fun byNumber(number: String): CreditNoteEntity?

    @Query("SELECT * FROM credit_notes WHERE id = :id")
    suspend fun note(id: String): CreditNoteEntity?

    @Query("SELECT * FROM credit_notes WHERE refund_id = :refund LIMIT 1")
    suspend fun ofRefund(refund: String): CreditNoteEntity?

    @Query("UPDATE credit_notes SET balance = :balance, status = :status WHERE id = :id")
    suspend fun setBalance(id: String, balance: Long, status: String)

    // the open notes, newest first, for the Receipts screen's list
    @Query("SELECT * FROM credit_notes WHERE status = 'open' ORDER BY created_at DESC LIMIT 200")
    fun open(): Flow<List<CreditNoteEntity>>

    // the shop's credit-note type (server 0109); a restaurant has none
    @Query("SELECT * FROM payment_types WHERE kind = 'credit_note' AND deleted_at IS NULL AND is_active LIMIT 1")
    suspend fun paymentType(): PaymentTypeEntity?
}

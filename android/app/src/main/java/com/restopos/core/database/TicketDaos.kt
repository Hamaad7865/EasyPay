package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

data class LineWithMods(
    val line: TicketLineEntity,
    val mods: String,
)

@Dao
interface TicketDao {
    @Query("SELECT * FROM tickets WHERE id = :id")
    suspend fun ticket(id: String): TicketEntity?

    @Query("SELECT * FROM tickets WHERE store_id = :store AND status = 'open' AND deleted_at IS NULL ORDER BY updated_at DESC")
    fun openTickets(store: String): Flow<List<TicketEntity>>

    @Query("SELECT * FROM ticket_lines WHERE ticket_id = :ticket AND voided_at IS NULL AND deleted_at IS NULL ORDER BY rowid")
    fun lines(ticket: String): Flow<List<TicketLineEntity>>

    @Query("SELECT group_concat(name_snapshot, ' · ') FROM ticket_line_modifiers WHERE line_id = :line")
    suspend fun modText(line: String): String?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTicket(t: TicketEntity)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertLines(rows: List<TicketLineEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertLineMods(rows: List<TicketLineModEntity>)

    @Query("UPDATE ticket_lines SET qty = :qty WHERE id = :id")
    suspend fun setQty(id: String, qty: Int)

    @Query("UPDATE ticket_lines SET voided_at = :at, void_reason = :reason WHERE id = :id")
    suspend fun voidLine(id: String, at: String, reason: String)

    @Query("UPDATE tickets SET status = :status WHERE id = :id")
    suspend fun setStatus(id: String, status: String)

    @Query("SELECT * FROM tickets WHERE id = :id AND status = 'open'")
    suspend fun openTicket(id: String): TicketEntity?

    @Query("SELECT modifier_id FROM ticket_line_modifiers WHERE line_id = :line")
    suspend fun modIds(line: String): List<String>

    @Query("SELECT COALESCE(SUM(price), 0) FROM ticket_line_modifiers WHERE line_id = :line")
    suspend fun modSum(line: String): Long

    @Query("UPDATE ticket_lines SET paid = 1 WHERE id IN (:ids)")
    suspend fun markPaid(ids: List<String>)
}

@Dao
interface ReceiptDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertReceipt(r: ReceiptEntity)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertPayments(rows: List<ReceiptPaymentEntity>)

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertLines(rows: List<ReceiptLineEntity>)

    @Query("SELECT * FROM receipts WHERE store_id = :store AND deleted_at IS NULL ORDER BY device_time DESC LIMIT :limit")
    fun receipts(store: String, limit: Int = 100): Flow<List<ReceiptEntity>>

    @Query("SELECT * FROM receipt_payments WHERE receipt_id = :receipt")
    suspend fun payments(receipt: String): List<ReceiptPaymentEntity>

    @Query("SELECT COALESCE(SUM(total), 0) FROM receipts WHERE ticket_id = :ticket AND type = 'sale'")
    suspend fun paidForTicket(ticket: String): Long
}

@Dao
interface OutboxDao {
    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun enqueue(op: OutboxEntity)

    @Query("SELECT * FROM outbox WHERE state = 'pending' ORDER BY created_at LIMIT 50")
    suspend fun pending(limit: Int = 50): List<OutboxEntity>

    @Query("DELETE FROM outbox WHERE op_id = :id")
    suspend fun remove(id: String)

    @Query("UPDATE outbox SET state = 'dead', last_error = :err WHERE op_id = :id")
    suspend fun dead(id: String, err: String)

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending'")
    suspend fun pendingCount(): Long
}

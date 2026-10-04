package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Upsert
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

    @Upsert
    suspend fun upsertTicket(t: TicketEntity)

    @Upsert
    suspend fun upsertLines(rows: List<TicketLineEntity>)

    @Upsert
    suspend fun upsertLineMods(rows: List<TicketLineModEntity>)

    @Query("UPDATE ticket_lines SET qty = :qty WHERE id = :id")
    suspend fun setQty(id: String, qty: Int)

    @Query("UPDATE ticket_lines SET voided_at = :at, void_reason = :reason WHERE id = :id")
    suspend fun voidLine(id: String, at: String, reason: String)

    @Query("UPDATE tickets SET status = :status WHERE id = :id")
    suspend fun setStatus(id: String, status: String)

    @Query("SELECT * FROM tickets WHERE id = :id AND status = 'open'")
    suspend fun openTicket(id: String): TicketEntity?

    // the order a table has open, newest first if (wrongly) there are several
    @Query("SELECT * FROM tickets WHERE table_id = :table AND status = 'open' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1")
    suspend fun openTicketForTable(table: String): TicketEntity?

    @Query("SELECT modifier_id FROM ticket_line_modifiers WHERE line_id = :line")
    suspend fun modIds(line: String): List<String>

    @Query("SELECT COALESCE(SUM(price), 0) FROM ticket_line_modifiers WHERE line_id = :line")
    suspend fun modSum(line: String): Long

    @Query("UPDATE ticket_lines SET paid = 1 WHERE id IN (:ids)")
    suspend fun markPaid(ids: List<String>)

    // Open orders that still have something to pay. They live on this tablet
    // only (the pull does not bring tickets back), so sign-out checks this.
    @Query(
        """SELECT COUNT(DISTINCT t.id) FROM tickets t JOIN ticket_lines l ON l.ticket_id = t.id
           WHERE t.status = 'open' AND t.deleted_at IS NULL
           AND l.voided_at IS NULL AND l.deleted_at IS NULL AND l.paid = 0""",
    )
    suspend fun unpaidOrderCount(): Long
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

    @Query("SELECT * FROM outbox WHERE state = 'pending' ORDER BY created_at, rowid LIMIT :limit")
    suspend fun pending(limit: Int = 50): List<OutboxEntity>

    @Query("DELETE FROM outbox WHERE op_id = :id")
    suspend fun remove(id: String)

    @Query("UPDATE outbox SET state = 'dead', last_error = :err WHERE op_id = :id")
    suspend fun dead(id: String, err: String)

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending'")
    suspend fun pendingCount(): Long

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'pending'")
    fun pendingCountFlow(): Flow<Long>

    // 'dead' = the server refused it (spec 5.4 dead-letter)
    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'dead'")
    suspend fun deadCount(): Long

    @Query("SELECT COUNT(*) FROM outbox WHERE state = 'dead'")
    fun deadCountFlow(): Flow<Long>

    @Query("SELECT * FROM outbox WHERE state = 'dead' ORDER BY created_at DESC")
    fun deadFlow(): Flow<List<OutboxEntity>>
}

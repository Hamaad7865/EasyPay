package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// What the service screens add: the kitchen display's tickets and the
// bookings. A kitchen ticket is one send of an order (what the kitchen
// printer gets as one paper); its lines are the order's own lines, which
// carry its id. Kitchen tickets are kept on this tablet; bookings come from
// the server and are the same on every till of the store.
@Entity(tableName = "kds_tickets", indices = [Index("ticket_id")])
data class KdsTicketEntity(
    @PrimaryKey val id: String,
    val ticket_id: String,
    val no: Int, // counts up through the day: #1, #2, ...
    val label: String, // the table, or the order's number
    val kind: String, // Dine-in, Takeaway, ... as the order type is called
    val covers: Int? = null,
    val created_at: Long = System.currentTimeMillis(),
    val bumped_at: Long? = null,
)

@Entity(tableName = "bookings", indices = [Index("store_id")])
data class BookingEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val booked_for: Long,
    val name: String,
    val size: Int,
    val phone: String? = null,
    val area: String? = null,
    val table_id: String? = null,
    val tags: String? = null,
    val status: String = "confirmed", // pending | confirmed | seated | noshow | cancelled
    val ticket_id: String? = null,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// A line with the name of its add-ons, for lists that show many orders at once.
data class LineSum(val line_id: String, val total: Long)
data class LineText(val line_id: String, val text: String?)
data class ItemGroups(val item_id: String, val names: String?)
data class SoldRow(val name: String, val qty: Long)
data class TicketCount(val ticket_id: String, val n: Int)

@Dao
interface ServiceDao {
    // ---- kitchen display ----
    @Upsert suspend fun upsertKds(row: KdsTicketEntity)

    @Query("SELECT * FROM kds_tickets WHERE bumped_at IS NULL ORDER BY created_at")
    fun kdsOpen(): Flow<List<KdsTicketEntity>>

    @Query("SELECT * FROM kds_tickets WHERE id = :id")
    suspend fun kds(id: String): KdsTicketEntity?

    @Query("SELECT * FROM kds_tickets WHERE bumped_at IS NOT NULL AND bumped_at > :since ORDER BY bumped_at DESC LIMIT 1")
    suspend fun lastBumped(since: Long): KdsTicketEntity?

    @Query("SELECT COUNT(*) FROM kds_tickets WHERE bumped_at IS NOT NULL AND bumped_at > :since")
    fun bumpedCount(since: Long): Flow<Int>

    @Query("UPDATE kds_tickets SET bumped_at = :at WHERE id = :id")
    suspend fun setBumped(id: String, at: Long?)

    @Query("SELECT COUNT(*) FROM kds_tickets WHERE ticket_id = :ticket AND bumped_at IS NULL")
    suspend fun kdsOpenFor(ticket: String): Int

    // the lines the kitchen still has on screen
    @Query(
        """SELECT l.* FROM ticket_lines l JOIN kds_tickets k ON k.id = l.kds_id
           WHERE k.bumped_at IS NULL AND l.voided_at IS NULL AND l.deleted_at IS NULL ORDER BY l.rowid""",
    )
    fun kdsLines(): Flow<List<TicketLineEntity>>

    @Query("SELECT * FROM ticket_lines WHERE kds_id = :kds AND voided_at IS NULL AND deleted_at IS NULL")
    suspend fun linesOfKds(kds: String): List<TicketLineEntity>

    @Query("UPDATE ticket_lines SET kds_id = :kds, kitchen_done = 0 WHERE id IN (:ids)")
    suspend fun putOnKds(ids: List<String>, kds: String)

    @Query("UPDATE ticket_lines SET kitchen_done = :done WHERE id = :id")
    suspend fun setKitchenDone(id: String, done: Boolean)

    @Query("DELETE FROM kds_tickets WHERE created_at < :before")
    suspend fun pruneKds(before: Long)

    // ---- many orders at once (the floor, the board, Orders) ----
    @Query(
        """SELECT l.* FROM ticket_lines l JOIN tickets t ON t.id = l.ticket_id
           WHERE t.store_id = :store AND t.deleted_at IS NULL AND l.voided_at IS NULL AND l.deleted_at IS NULL
           AND (t.status = 'open' OR (t.stage IS NOT NULL AND t.stage != 'done')) ORDER BY l.rowid""",
    )
    fun liveLines(store: String): Flow<List<TicketLineEntity>>

    @Query(
        """SELECT m.line_id AS line_id, COALESCE(SUM(m.price), 0) AS total FROM ticket_line_modifiers m
           WHERE m.line_id IN (:lines) GROUP BY m.line_id""",
    )
    suspend fun modSums(lines: List<String>): List<LineSum>

    @Query(
        """SELECT m.line_id AS line_id, group_concat(m.name_snapshot, ' · ') AS text FROM ticket_line_modifiers m
           WHERE m.line_id IN (:lines) GROUP BY m.line_id""",
    )
    suspend fun modTexts(lines: List<String>): List<LineText>

    @Query("SELECT * FROM ticket_line_taxes WHERE line_id IN (:lines)")
    suspend fun taxesOf(lines: List<String>): List<TicketLineTaxEntity>

    // takeaways and deliveries still on the board, paid or not
    @Query(
        """SELECT * FROM tickets WHERE store_id = :store AND deleted_at IS NULL AND status != 'cancelled'
           AND stage IS NOT NULL AND stage != 'done' ORDER BY due_at""",
    )
    fun board(store: String): Flow<List<TicketEntity>>

    // handed over and paid: not one that was cancelled, or turned into a counter sale
    @Query("SELECT COUNT(*) FROM tickets WHERE store_id = :store AND stage = 'done' AND status = 'paid' AND updated_at > :since")
    fun boardDone(store: String, since: Long): Flow<Int>

    @Query("SELECT * FROM tickets WHERE id IN (:ids)")
    suspend fun ticketsById(ids: List<String>): List<TicketEntity>

    @Query("UPDATE tickets SET stage = :stage, updated_at = :at WHERE id = :id")
    suspend fun setStage(id: String, stage: String?, at: Long)

    @Query("UPDATE tickets SET rider = :rider WHERE id = :id")
    suspend fun setRider(id: String, rider: String?)

    @Query("UPDATE tickets SET due_at = :at WHERE id = :id")
    suspend fun setDue(id: String, at: Long?)

    @Query("UPDATE tickets SET bill_at = :at WHERE id = :id")
    suspend fun setBill(id: String, at: Long?)

    // what earlier receipts of an order were paid with
    @Query(
        """SELECT p.* FROM receipt_payments p JOIN receipts r ON r.id = p.receipt_id
           WHERE r.ticket_id = :ticket AND r.type = 'sale' AND r.deleted_at IS NULL ORDER BY r.device_time""",
    )
    suspend fun paymentsForTicket(ticket: String): List<ReceiptPaymentEntity>

    // ---- bookings ----
    @Upsert suspend fun upsertBookings(rows: List<BookingEntity>)

    @Query("SELECT * FROM bookings WHERE store_id = :store AND deleted_at IS NULL AND status != 'cancelled' AND booked_for >= :from AND booked_for < :to ORDER BY booked_for, name")
    fun bookings(store: String, from: Long, to: Long): Flow<List<BookingEntity>>

    @Query("SELECT * FROM bookings WHERE id = :id")
    suspend fun booking(id: String): BookingEntity?

    @Query("DELETE FROM bookings") suspend fun clearBookings()

    // ---- the menu ----
    @Query(
        """SELECT * FROM items WHERE deleted_at IS NULL
           AND (:cat IS NULL OR category_id = :cat)
           AND (:q = '' OR name LIKE '%' || :q || '%' OR barcode = :q)
           ORDER BY name COLLATE NOCASE LIMIT 600""",
    )
    fun items(cat: String?, q: String): Flow<List<ItemEntity>>

    @Query(
        """SELECT x.item_id AS item_id, group_concat(g.name, ', ') AS names FROM item_modifier_groups x
           JOIN modifier_groups g ON g.id = x.group_id WHERE g.deleted_at IS NULL GROUP BY x.item_id""",
    )
    fun itemGroups(): Flow<List<ItemGroups>>

    @Query("UPDATE items SET is_available = :on WHERE id = :id")
    suspend fun setAvailable(id: String, on: Boolean)

    @Query("UPDATE items SET price = :price WHERE id = :id")
    suspend fun setPrice(id: String, price: Long)

    @Query("SELECT COUNT(*) FROM items WHERE deleted_at IS NULL")
    fun itemCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM items WHERE deleted_at IS NULL AND is_available = 0")
    fun soldOutCount(): Flow<Int>

    // ---- today ----
    @Query(
        """SELECT l.name_snapshot AS name, SUM(l.qty) AS qty FROM receipt_lines l JOIN receipts r ON r.id = l.receipt_id
           WHERE r.device_id = :device AND r.type = 'sale' AND r.deleted_at IS NULL AND r.device_time > :from
           GROUP BY l.name_snapshot ORDER BY qty DESC LIMIT 5""",
    )
    suspend fun bestSellers(device: String, from: Long): List<SoldRow>

    @Query("SELECT * FROM receipts WHERE device_id = :device AND deleted_at IS NULL AND device_time > :from ORDER BY device_time")
    fun receiptsSince(device: String, from: Long): Flow<List<ReceiptEntity>>
}

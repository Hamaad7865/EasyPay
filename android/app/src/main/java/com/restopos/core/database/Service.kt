package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
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
    // who took the order and what was said about the whole of it, as the
    // kitchen's paper has them; a kitchen screen shows them when asked to
    val waiter: String? = null,
    val remark: String? = null,
)

// One kitchen screen's part of a kitchen ticket (server 0086): the lines of
// that send that go to that screen, as they were sent. The till writes it
// down when the order is sent and keeps trying until the screen has it, so
// nothing depends on one message arriving.
@Entity(tableName = "kds_parts", primaryKeys = ["kds_id", "screen_id"], indices = [Index("screen_id")])
data class KdsPartEntity(
    val kds_id: String,
    val screen_id: String, // the printers row of kind screen
    val payload: String, // the ticket as it goes to the screen (WireTicket), frozen when sent
    val line_ids: String, // the order's lines in it, a JSON list
    val delivered: Boolean = false, // the screen has confirmed it holds it
    val bumped_at: Long? = null, // that screen's cooks have it at the pass
    val created_at: Long = System.currentTimeMillis(),
)

// A mark the till owes a kitchen screen: a line voided, or a tick, a bump or
// a recall made on the till's own Kitchen screen. Kept until the screen has
// answered a request that carried it.
@Entity(tableName = "kds_out", indices = [Index("screen_id")])
data class KdsOutEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val screen_id: String,
    val mark: String, // a WireMark
)

// What the till knows of a kitchen screen: which set-up of the tablet it last
// spoke to, how far it has read of what the cooks did, when it last answered
// and, when it does not, what is wrong in words.
@Entity(tableName = "kds_screens")
data class KdsScreenEntity(
    @PrimaryKey val screen_id: String,
    val epoch: String = "",
    val read_to: Long = 0,
    val heard_at: Long? = null,
    val trouble: String? = null,
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

    // An order put onto another takes its kitchen tickets with it; the ones
    // still on the screen say where the food goes now.
    @Query("UPDATE kds_tickets SET ticket_id = :into, label = CASE WHEN bumped_at IS NULL THEN :label ELSE label END WHERE ticket_id = :from")
    suspend fun moveKds(from: String, into: String, label: String)

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

    // ---- kitchen screens: each screen's part of a kitchen ticket ----
    @Upsert suspend fun upsertParts(rows: List<KdsPartEntity>)

    @Query("SELECT * FROM kds_parts WHERE kds_id = :kds")
    suspend fun partsOf(kds: String): List<KdsPartEntity>

    // what a screen still has to cook, the oldest first
    @Query("SELECT * FROM kds_parts WHERE screen_id = :screen AND bumped_at IS NULL ORDER BY created_at")
    suspend fun partsOpen(screen: String): List<KdsPartEntity>

    @Query("SELECT * FROM kds_parts WHERE bumped_at IS NULL")
    fun partsOpenFlow(): Flow<List<KdsPartEntity>>

    @Query("UPDATE kds_parts SET delivered = 1 WHERE screen_id = :screen AND kds_id IN (:kds)")
    suspend fun setDelivered(screen: String, kds: List<String>)

    // the tablet was set up afresh: it holds nothing it was sent
    @Query("UPDATE kds_parts SET delivered = 0 WHERE screen_id = :screen AND bumped_at IS NULL")
    suspend fun undeliver(screen: String)

    // the screen confirmed these once and no longer holds them
    @Query("UPDATE kds_parts SET delivered = 0 WHERE screen_id = :screen AND kds_id IN (:kds)")
    suspend fun setUndelivered(screen: String, kds: List<String>)

    @Query("UPDATE kds_parts SET bumped_at = :at WHERE kds_id = :kds AND screen_id = :screen")
    suspend fun setPartBumped(kds: String, screen: String, at: Long?)

    @Query("UPDATE kds_parts SET bumped_at = :at WHERE kds_id = :kds")
    suspend fun setPartsBumped(kds: String, at: Long?)

    @Query("DELETE FROM kds_parts WHERE created_at < :before")
    suspend fun pruneParts(before: Long)

    @Insert suspend fun addOut(rows: List<KdsOutEntity>)

    @Query("SELECT * FROM kds_out WHERE screen_id = :screen ORDER BY id")
    suspend fun outOf(screen: String): List<KdsOutEntity>

    @Query("DELETE FROM kds_out WHERE id IN (:ids)")
    suspend fun removeOut(ids: List<Long>)

    @Query("DELETE FROM kds_out WHERE screen_id = :screen")
    suspend fun clearOut(screen: String)

    @Query("SELECT * FROM kds_screens WHERE screen_id = :screen")
    suspend fun screenState(screen: String): KdsScreenEntity?

    @Query("SELECT * FROM kds_screens")
    fun screenStates(): Flow<List<KdsScreenEntity>>

    @Upsert suspend fun saveScreenState(row: KdsScreenEntity)

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

    // Which of these items the tablet holds. A screen that has just had the
    // server make some (the first-run set-up) shows them itself until the
    // pull has brought them, and asks this to know when that is.
    @Query("SELECT id FROM items WHERE id IN (:ids)")
    fun itemsHeld(ids: List<String>): Flow<List<String>>

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

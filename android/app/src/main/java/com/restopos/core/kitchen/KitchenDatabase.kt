package com.restopos.core.kitchen

import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.RoomDatabase
import androidx.room.Upsert
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import javax.inject.Inject
import javax.inject.Singleton

// What a tablet set up as a kitchen screen keeps: the tickets the tills sent
// it and what the cooks did. A small database of its own (kitchen.db), apart
// from a till's: a kitchen tablet has no menu, no orders and no sales, and a
// till has none of this. Switched off and on, the kitchen tablet shows what
// it showed.

// One till's ticket as this screen holds it, its lines as JSON beside it:
// they are only ever read and written whole.
@Entity(tableName = "screen_tickets")
data class ScreenTicketRow(
    @PrimaryKey val id: String,
    val till: String,
    val till_name: String,
    val till_code: String,
    val screen: String,
    val no: Int,
    val label: String,
    val kind: String,
    val covers: Int?,
    val waiter: String?,
    val remark: String?,
    val sent_at: Long,
    val received_at: Long,
    val bumped_at: Long?,
    val lines: String,
)

// What a cook did, for the till it concerns, numbered as it is written. A
// till asks for what came after the number it last had.
@Entity(tableName = "screen_marks", indices = [Index("till")])
data class ScreenMarkRow(
    @PrimaryKey(autoGenerate = true) val seq: Long = 0,
    val till: String,
    val mark: String, // a WireMark
    val at: Long,
)

@Dao
interface ScreenDao {
    @Query("SELECT * FROM screen_tickets WHERE id = :id")
    suspend fun ticket(id: String): ScreenTicketRow?

    @Query("SELECT * FROM screen_tickets")
    suspend fun tickets(): List<ScreenTicketRow>

    @Query("SELECT * FROM screen_tickets")
    fun watch(): Flow<List<ScreenTicketRow>>

    @Upsert suspend fun save(row: ScreenTicketRow)

    @Insert suspend fun log(row: ScreenMarkRow): Long

    @Query("SELECT * FROM screen_marks WHERE till = :till AND seq > :after ORDER BY seq")
    suspend fun logged(till: String, after: Long): List<ScreenMarkRow>

    @Query("SELECT COALESCE(MAX(seq), 0) FROM screen_marks WHERE till = :till")
    suspend fun lastSeq(till: String): Long

    @Query("DELETE FROM screen_tickets WHERE received_at < :before")
    suspend fun pruneTickets(before: Long)

    @Query("DELETE FROM screen_marks WHERE at < :before")
    suspend fun pruneMarks(before: Long)

    @Query("DELETE FROM screen_tickets") suspend fun clearTickets()
    @Query("DELETE FROM screen_marks") suspend fun clearMarks()
}

@Database(entities = [ScreenTicketRow::class, ScreenMarkRow::class], version = 1, exportSchema = true)
abstract class KitchenDatabase : RoomDatabase() {
    abstract fun screen(): ScreenDao
}

// The shelf ScreenBook is handed on a kitchen tablet. It only keeps: every
// rule is ScreenBook's, and is tested there against a shelf in memory.
@Singleton
class RoomScreenShelf @Inject constructor(private val db: KitchenDatabase, private val session: SessionStore) : ScreenShelf {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val lineList = ListSerializer(ScreenLine.serializer())

    private fun ScreenTicketRow.ticket() = ScreenTicket(
        id, till, till_name, till_code, screen, no, label, kind, covers, waiter, remark, sent_at, received_at, bumped_at,
        runCatching { json.decodeFromString(lineList, lines) }.getOrDefault(emptyList()),
    )

    private fun ScreenTicket.row() = ScreenTicketRow(
        id, till, tillName, tillCode, screen, no, label, kind, covers, waiter, remark, sentAt, receivedAt, bumpedAt, json.encodeToString(lineList, lines),
    )

    override suspend fun epoch(): String = session.kitchenEpoch()
    override suspend fun ticket(id: String): ScreenTicket? = db.screen().ticket(id)?.ticket()
    override suspend fun tickets(): List<ScreenTicket> = db.screen().tickets().map { it.ticket() }
    override suspend fun save(ticket: ScreenTicket) = db.screen().save(ticket.row())
    override suspend fun log(till: String, mark: WireMark): Long = db.screen().log(ScreenMarkRow(till = till, mark = Wire.encodeMark(mark), at = System.currentTimeMillis()))
    override suspend fun logged(till: String, after: Long): List<Pair<Long, WireMark>> =
        db.screen().logged(till, after).mapNotNull { r -> Wire.decodeMark(r.mark)?.let { r.seq to it } }
    override suspend fun lastSeq(till: String): Long = db.screen().lastSeq(till)
    override suspend fun prune(before: Long) { db.screen().pruneTickets(before); db.screen().pruneMarks(before) }

    // everything the tablet holds, as it changes: what the board is drawn from
    fun watch(): Flow<List<ScreenTicket>> = db.screen().watch().map { rows -> rows.map { it.ticket() } }

    // the tablet stops being a kitchen screen: nothing it was sent is kept
    suspend fun wipe() { db.screen().clearTickets(); db.screen().clearMarks() }
}

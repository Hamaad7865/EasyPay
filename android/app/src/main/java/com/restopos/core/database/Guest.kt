package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// An order a guest sent from the code on their table (core/guest), as the till
// keeps it: which table, its lines as they came (dishes, options, notes, no
// price), and how it stands. It waits until the cashier accepts or declines
// it; the answer is kept until the ordering site has it (`told`), so an answer
// given while the line was down is given again when it is back. Another till
// may have answered first, or the site may no longer hold it: then it is gone.
@Entity(tableName = "guest_orders", indices = [Index("status")])
data class GuestOrderEntity(
    @PrimaryKey val id: String,
    val table_id: String,
    val lines: String, // JSON, as GuestWire writes it
    val placed_at: Long, // by the ordering site's clock
    val received_at: Long, // by this tablet's
    val status: String = "waiting", // waiting, accepted, declined, gone
    val reason: String? = null, // what the guest is told when it is declined
    val answered_at: Long? = null,
    val told: Boolean = false,
)

@Dao
interface GuestDao {
    @Query("SELECT * FROM guest_orders WHERE status = 'waiting' ORDER BY placed_at, received_at")
    fun waiting(): Flow<List<GuestOrderEntity>>

    @Query("SELECT * FROM guest_orders WHERE id = :id")
    suspend fun order(id: String): GuestOrderEntity?

    // -1 when the till already has it: the site hands over what waits each time a till connects
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun add(row: GuestOrderEntity): Long

    // The cashier's answer. Only an order that still waits takes one.
    @Query("UPDATE guest_orders SET status = :status, reason = :reason, answered_at = :at, told = 0 WHERE id = :id AND status = 'waiting'")
    suspend fun answer(id: String, status: String, reason: String?, at: Long): Int

    @Query("SELECT * FROM guest_orders WHERE status IN ('accepted', 'declined') AND told = 0 ORDER BY answered_at")
    suspend fun untold(): List<GuestOrderEntity>

    @Query("UPDATE guest_orders SET told = 1 WHERE id = :id")
    suspend fun told(id: String)

    // answered on another till, or no longer held by the site
    @Query("UPDATE guest_orders SET status = 'gone', told = 1 WHERE id = :id AND status = 'waiting'")
    suspend fun gone(id: String): Int

    // what nobody answered in time: the site has dropped it too
    @Query("UPDATE guest_orders SET status = 'gone', told = 1 WHERE status = 'waiting' AND received_at < :before")
    suspend fun stale(before: Long)

    @Query("DELETE FROM guest_orders WHERE status <> 'waiting' AND told = 1 AND received_at < :before")
    suspend fun forget(before: Long)

    // ---- the menu, read whole for what the till publishes ----

    @Query("SELECT * FROM items WHERE deleted_at IS NULL")
    suspend fun items(): List<ItemEntity>

    @Query("SELECT * FROM categories WHERE deleted_at IS NULL")
    suspend fun categories(): List<CategoryEntity>

    @Query("SELECT * FROM modifier_groups WHERE deleted_at IS NULL")
    suspend fun groups(): List<ModifierGroupEntity>

    @Query("SELECT * FROM modifiers WHERE deleted_at IS NULL")
    suspend fun options(): List<ModifierEntity>

    @Query("SELECT * FROM item_modifier_groups")
    suspend fun links(): List<ItemModGroupCrossRef>

    // A number that is said again whenever anything the menu is made of is
    // written: a dish, a category, an option, a table, the settings. What it
    // counts does not matter; that it is said does.
    @Query(
        """SELECT (SELECT COUNT(*) FROM items) + (SELECT COUNT(*) FROM categories) + (SELECT COUNT(*) FROM modifiers)
                + (SELECT COUNT(*) FROM modifier_groups) + (SELECT COUNT(*) FROM item_modifier_groups)
                + (SELECT COUNT(*) FROM tables) + (SELECT COUNT(*) FROM pos_settings)""",
    )
    fun pulse(): Flow<Long>
}

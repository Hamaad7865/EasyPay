package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// A table on the store's floor plan, as designed in the back office. x, y, w
// and h are grid units on a 100 x 60 plan; the till scales them to its screen.
@Entity(tableName = "tables", indices = [Index("store_id")])
data class TableEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val name: String,
    val area: String = "Main",
    val seats: Int = 4,
    val shape: String = "square", // "square" or "round"
    val x: Int = 0,
    val y: Int = 0,
    val w: Int = 10,
    val h: Int = 10,
    val sort_order: Int = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
    // the angle it is set at, in whole degrees (server 0102): its rectangle is turned about its middle
    val rotation: Int = 0,
)

// What stands in a room beside its tables (server 0102): a wall, a door, a
// window, a bar counter. Drawn on the plan and never tapped: nothing of it is
// a table's. Its rectangle is on the same 100 x 60 plan, before it is turned.
@Entity(tableName = "floor_elements", indices = [Index("store_id")])
data class FloorElementEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val area: String = "Main",
    val kind: String = "wall", // "wall", "door", "window" or "bar"
    val x: Int = 0,
    val y: Int = 0,
    val w: Int = 10,
    val h: Int = 1,
    val rotation: Int = 0,
    val sort_order: Int = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Dao
interface TableDao {
    @Upsert suspend fun upsertTables(rows: List<TableEntity>)

    @Query("SELECT * FROM tables WHERE store_id = :store AND deleted_at IS NULL ORDER BY sort_order, name COLLATE NOCASE")
    fun tables(store: String): Flow<List<TableEntity>>

    @Query("SELECT * FROM tables WHERE store_id = :store AND deleted_at IS NULL ORDER BY sort_order, name COLLATE NOCASE")
    suspend fun tablesNow(store: String): List<TableEntity>

    @Query("SELECT * FROM tables WHERE id = :id")
    suspend fun table(id: String): TableEntity?

    @Query("DELETE FROM tables") suspend fun clearTables()

    @Upsert suspend fun upsertElements(rows: List<FloorElementEntity>)

    @Query("SELECT * FROM floor_elements WHERE store_id = :store AND deleted_at IS NULL ORDER BY sort_order, id")
    fun elements(store: String): Flow<List<FloorElementEntity>>

    @Query("DELETE FROM floor_elements") suspend fun clearElements()
}

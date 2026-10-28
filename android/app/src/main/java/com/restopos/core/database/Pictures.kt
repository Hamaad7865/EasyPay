package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// A product's picture, as the card on the till shows it: a small JPEG, kept
// in the till's own database. One chosen on the tablet is kept under the
// product's id and is the tablet's alone: nothing sends it. One the back
// office set (server 0143) is fetched once and kept under "p:" and its id,
// for every product and variant that names it. Kept in the database
// rather than as a file beside it so that a backup, which is the database,
// carries the pictures with no more said, and a restore brings them back.
@Entity(tableName = "item_pictures")
class ItemPictureEntity(
    @PrimaryKey val item_id: String,
    val jpeg: ByteArray,
    // when it was set: a card draws again when this changes
    val updated_at: Long,
)

data class PictureStamp(val item_id: String, val updated_at: Long)

@Dao
interface PictureDao {
    // which products have a picture, without the pictures themselves
    @Query("SELECT item_id, updated_at FROM item_pictures") fun stamps(): Flow<List<PictureStamp>>
    @Query("SELECT jpeg FROM item_pictures WHERE item_id = :item") suspend fun jpeg(item: String): ByteArray?
    @Upsert suspend fun put(row: ItemPictureEntity)
    @Query("DELETE FROM item_pictures WHERE item_id = :item") suspend fun drop(item: String)

    // The pictures the back office set (server 0143) that the products and
    // variants name and this till has not fetched yet: kept as "p:" and the id.
    @Query(
        "SELECT p FROM (SELECT picture_id AS p FROM items WHERE picture_id IS NOT NULL AND deleted_at IS NULL " +
            "UNION SELECT picture_id AS p FROM item_variants WHERE picture_id IS NOT NULL AND deleted_at IS NULL) " +
            "WHERE 'p:' || p NOT IN (SELECT item_id FROM item_pictures)",
    )
    suspend fun unfetched(): List<String>

    // the fetched ones nothing names any more
    @Query(
        "DELETE FROM item_pictures WHERE item_id LIKE 'p:%' AND substr(item_id, 3) NOT IN " +
            "(SELECT picture_id FROM items WHERE picture_id IS NOT NULL AND deleted_at IS NULL " +
            "UNION SELECT picture_id FROM item_variants WHERE picture_id IS NOT NULL AND deleted_at IS NULL)",
    )
    suspend fun dropUnnamed()
}

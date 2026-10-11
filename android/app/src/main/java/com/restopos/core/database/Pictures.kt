package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// A product's picture, as the card on the till shows it: a small JPEG, kept
// in the till's own database. It is the tablet's and nothing of the
// server's: no pull writes it and nothing sends it. Kept in the database
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
}

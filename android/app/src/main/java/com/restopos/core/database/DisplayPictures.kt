package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// The pictures a customer display shows in turn (the shop's posters, its
// promotions), picked on this till from the tablet's photos. Kept in the
// till's database, as product pictures are, so that a backup carries them.
// `owner` is the display they are for: a customer display's printer row, or
// "cable" for the screen joined to this tablet by a cable. At most 5 each.
@Entity(tableName = "display_pictures", indices = [Index("owner")])
class DisplayPictureEntity(
    @PrimaryKey val id: String,
    val owner: String,
    val jpeg: ByteArray,
    // the first 16 hex digits of the jpeg's SHA-256: how a display says which it holds
    val hash: String,
    val sort_order: Int,
)

@Dao
interface DisplayPictureDao {
    @Query("SELECT * FROM display_pictures WHERE owner = :owner ORDER BY sort_order, id")
    fun of(owner: String): Flow<List<DisplayPictureEntity>>

    @Query("SELECT * FROM display_pictures WHERE owner = :owner ORDER BY sort_order, id")
    suspend fun all(owner: String): List<DisplayPictureEntity>

    @Upsert suspend fun put(row: DisplayPictureEntity)

    @Query("DELETE FROM display_pictures WHERE id = :id") suspend fun drop(id: String)
}

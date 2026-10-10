package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.PrimaryKey
import androidx.room.Query

// What was changed on this till that leaves no other trace on the tablet, for
// its reports (Price Change, Resettlement): a product's price changed, where
// only the new price is kept; and a payment type corrected after the sale,
// where the payment is rewritten. Written in the same transaction as the
// change. It is the tablet's own: nothing of it is sent to the server and the
// server sends none of it, so it starts with the build that brought it.
// kind "price": item_id (and variant_id for a variant), was and became in cents.
// kind "payment": receipt_id, was and became are the payment types' names.
@Entity(tableName = "till_log", indices = [Index("at")])
data class TillLogEntity(
    @PrimaryKey val id: String,
    val at: Long,
    val kind: String,
    val employee_id: String? = null,
    val approved_by: String? = null,
    val item_id: String? = null,
    val variant_id: String? = null,
    val receipt_id: String? = null,
    val was: String,
    val became: String,
)

@Dao
interface TillLogDao {
    @Insert suspend fun add(row: TillLogEntity)

    // from is not in the period and to is, as the reports read every period; newest first
    @Query("SELECT * FROM till_log WHERE kind = :kind AND at > :from AND at <= :to ORDER BY at DESC")
    suspend fun between(kind: String, from: Long, to: Long): List<TillLogEntity>

    // When the first thing was written down: the reports know nothing of before.
    @Query("SELECT MIN(at) FROM till_log") suspend fun first(): Long?
}

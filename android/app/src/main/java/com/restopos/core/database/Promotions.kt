package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// A shop's promotion (server 0110): a line of a product (variant_id "" for a
// product without variants, as stock_levels has it) marked down from
// original_price to promo_price, until it is lifted. Made on this tablet or
// sent by the server; the line itself carries promo_was while one is live.
@Entity(tableName = "promotions", indices = [Index("item_id")])
data class PromotionEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val item_id: String,
    val variant_id: String = "",
    val original_price: Long,
    val promo_price: Long,
    val status: String = "active", // active | lifted
    val note: String? = null,
    val applied_by: String? = null,
    val applied_at: Long = System.currentTimeMillis(),
    val server_seq: Long? = null,
)

// when a line of a product last sold on this tablet, as it knows it
data class LastSale(val item_id: String, val variant_id: String, val at: Long)

@Dao
interface PromotionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(rows: List<PromotionEntity>)

    @Query("SELECT * FROM promotions WHERE status = 'active' ORDER BY applied_at DESC")
    fun active(): Flow<List<PromotionEntity>>

    @Query("SELECT * FROM promotions WHERE status = 'active'")
    suspend fun activeNow(): List<PromotionEntity>

    @Query("SELECT * FROM promotions WHERE item_id = :item AND variant_id = :variant AND status = 'active' LIMIT 1")
    suspend fun activeFor(item: String, variant: String): PromotionEntity?

    @Query("SELECT * FROM promotions WHERE id = :id")
    suspend fun promotion(id: String): PromotionEntity?

    @Query("UPDATE promotions SET promo_price = :price, note = COALESCE(:note, note) WHERE id = :id")
    suspend fun reduce(id: String, price: Long, note: String?)

    @Query("UPDATE promotions SET status = 'lifted' WHERE id = :id")
    suspend fun lift(id: String)

    // the last sale of each line this tablet holds a receipt for: a sale's
    // lines name the order's lines, which name the product and its variant
    @Query(
        """SELECT tl.item_id AS item_id, COALESCE(tl.variant_id, '') AS variant_id, MAX(r.device_time) AS at
           FROM receipt_lines rl JOIN receipts r ON r.id = rl.receipt_id JOIN ticket_lines tl ON tl.id = rl.ticket_line_id
           WHERE r.type = 'sale' AND r.deleted_at IS NULL AND tl.item_id IS NOT NULL
           GROUP BY tl.item_id, COALESCE(tl.variant_id, '')""",
    )
    suspend fun lastSales(): List<LastSale>

    // when stock of each line first came in here: what "idle since" counts from for a line that never sold
    @Query("SELECT item_id AS item_id, variant_id AS variant_id, MIN(created_at) AS at FROM stock_movements WHERE qty > 0 GROUP BY item_id, variant_id")
    suspend fun firstIn(): List<LastSale>

    @Query("UPDATE items SET price = :price, promo_was = :was WHERE id = :id")
    suspend fun setItemPromo(id: String, price: Long, was: Long?)

    @Query("UPDATE item_variants SET price = :price, promo_was = :was WHERE id = :id")
    suspend fun setVariantPromo(id: String, price: Long, was: Long?)
}

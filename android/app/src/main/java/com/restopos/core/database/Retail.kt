package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// What a shop's till needs beyond a restaurant's: the variants of a product
// (a size, a colour: each with its own price, SKU and barcode) and what the
// shop holds of each product. Both come from the server; a restaurant's till
// keeps them too and never shows them.

@Entity(tableName = "item_variants", indices = [Index("item_id"), Index("barcode"), Index("sku")])
data class ItemVariantEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val item_id: String,
    val name: String, // "M / Navy"
    val price: Long,
    val sku: String? = null,
    val barcode: String? = null,
    // what it is made of, in the order of the product's option names, as a JSON array: ["M","Navy"]
    val option_values: String = "[]",
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// What this shop holds of one product, or of one variant of it, in
// thousandths. variant_id is "" for a product that has no variants: the three
// columns together say which line of stock it is, so the server's figure and
// what this till takes off when it sells always land on the same row.
// The figure is the server's as of the last sync, less what this till sold
// since (and plus what it took back): see TicketRepository.pay.
@Entity(tableName = "stock_levels", primaryKeys = ["store_id", "item_id", "variant_id"], indices = [Index("item_id")])
data class StockLevelEntity(
    val store_id: String,
    val item_id: String,
    val variant_id: String = "",
    val qty: Int = 0,
    val server_seq: Long? = null,
)

// What a product holds over all its variants, and how many lines of stock that is.
data class ItemLeft(val item_id: String, val qty: Long, val lines: Int)
data class VariantCount(val item_id: String, val n: Int)

@Dao
interface RetailDao {
    @Upsert suspend fun upsertVariants(rows: List<ItemVariantEntity>)
    @Upsert suspend fun upsertLevels(rows: List<StockLevelEntity>)

    @Query("DELETE FROM stock_levels WHERE store_id = :store AND item_id = :item AND variant_id = :variant")
    suspend fun dropLevel(store: String, item: String, variant: String)

    @Query("SELECT * FROM item_variants WHERE item_id = :item AND deleted_at IS NULL ORDER BY rowid")
    suspend fun variantsOf(item: String): List<ItemVariantEntity>

    @Query("SELECT * FROM item_variants WHERE id = :id")
    suspend fun variant(id: String): ItemVariantEntity?

    @Query("SELECT item_id, COUNT(*) AS n FROM item_variants WHERE deleted_at IS NULL GROUP BY item_id")
    fun variantCounts(): Flow<List<VariantCount>>

    @Query("SELECT * FROM item_variants WHERE deleted_at IS NULL")
    fun variants(): Flow<List<ItemVariantEntity>>

    // what a scanner read, or what was typed whole: a variant's barcode or SKU first (it names more), then a product's
    @Query("SELECT * FROM item_variants WHERE deleted_at IS NULL AND (barcode = :code OR LOWER(sku) = LOWER(:code)) LIMIT 2")
    suspend fun variantsByCode(code: String): List<ItemVariantEntity>

    @Query("SELECT * FROM items WHERE deleted_at IS NULL AND (barcode = :code OR LOWER(sku) = LOWER(:code)) LIMIT 2")
    suspend fun itemsByCode(code: String): List<ItemEntity>

    // The tiles: a category's products, or the whole catalog searched by
    // name, SKU or barcode, a variant's included.
    @Query(
        """SELECT * FROM items WHERE deleted_at IS NULL
           AND (:cat IS NULL OR category_id = :cat)
           AND (:q = '' OR name LIKE '%' || :q || '%' OR sku LIKE '%' || :q || '%' OR barcode LIKE '%' || :q || '%'
                OR id IN (SELECT item_id FROM item_variants WHERE deleted_at IS NULL
                          AND (sku LIKE '%' || :q || '%' OR barcode LIKE '%' || :q || '%' OR name LIKE '%' || :q || '%')))
           ORDER BY name COLLATE NOCASE LIMIT 400""",
    )
    fun products(cat: String?, q: String): Flow<List<ItemEntity>>

    @Query("SELECT item_id, SUM(qty) AS qty, COUNT(*) AS lines FROM stock_levels WHERE store_id = :store GROUP BY item_id")
    fun leftByItem(store: String): Flow<List<ItemLeft>>

    @Query("SELECT * FROM stock_levels WHERE store_id = :store AND item_id = :item")
    suspend fun levelsOf(store: String, item: String): List<StockLevelEntity>

    @Query("SELECT * FROM stock_levels WHERE store_id = :store")
    fun levels(store: String): Flow<List<StockLevelEntity>>

    @Query("UPDATE stock_levels SET qty = qty + :by WHERE store_id = :store AND item_id = :item AND variant_id = :variant")
    suspend fun moveLevel(store: String, item: String, variant: String, by: Int): Int

    @Query("UPDATE item_variants SET price = :price WHERE id = :id")
    suspend fun setVariantPrice(id: String, price: Long)

    @Query("DELETE FROM item_variants") suspend fun clearVariants()
    @Query("DELETE FROM stock_levels") suspend fun clearLevels()
}

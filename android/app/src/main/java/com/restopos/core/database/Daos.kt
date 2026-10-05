package com.restopos.core.database

import androidx.paging.PagingSource
import androidx.room.Dao
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert

// Pulled rows are written with @Upsert (insert, or update in place). REPLACE
// deletes the old row first, which loses whatever hangs off it.
@Dao
interface CatalogDao {
    // Sale grid + search read from Room with paging (spec 7.3, 2,000 items).
    @Query(
        """SELECT * FROM items WHERE deleted_at IS NULL
           AND (:cat IS NULL OR category_id = :cat)
           AND (:q = '' OR name LIKE '%' || :q || '%')
           ORDER BY name""",
    )
    fun itemsPaged(cat: String?, q: String): PagingSource<Int, ItemEntity>

    @Query("SELECT * FROM categories WHERE deleted_at IS NULL ORDER BY sort_order, name")
    fun categories(): kotlinx.coroutines.flow.Flow<List<CategoryEntity>>

    @Upsert
    suspend fun upsertCategories(rows: List<CategoryEntity>)

    @Upsert
    suspend fun upsertItems(rows: List<ItemEntity>)

    @Upsert
    suspend fun upsertGroups(rows: List<ModifierGroupEntity>)

    @Upsert
    suspend fun upsertModifiers(rows: List<ModifierEntity>)

    @Upsert
    suspend fun upsertTaxes(rows: List<TaxEntity>)

    @Upsert
    suspend fun upsertDining(rows: List<DiningOptionEntity>)

    @Upsert
    suspend fun upsertPayments(rows: List<PaymentTypeEntity>)

    @Upsert
    suspend fun upsertStores(rows: List<StoreEntity>)

    @Upsert
    suspend fun upsertDevices(rows: List<DeviceEntity>)

    @Query("SELECT * FROM items WHERE id = :id")
    suspend fun item(id: String): ItemEntity?

    @Query("SELECT * FROM items WHERE barcode = :code AND deleted_at IS NULL LIMIT 1")
    suspend fun itemByBarcode(code: String): ItemEntity?

    @Query("SELECT * FROM pos_devices WHERE id = :id")
    suspend fun device(id: String): DeviceEntity?

    @Query("SELECT * FROM stores WHERE id = :id")
    suspend fun store(id: String): StoreEntity?

    @Upsert
    suspend fun upsertItemTaxes(rows: List<ItemTaxCrossRef>)

    @Upsert
    suspend fun upsertItemModGroups(rows: List<ItemModGroupCrossRef>)

    @Query("SELECT t.* FROM taxes t JOIN item_taxes it ON it.tax_id = t.id WHERE it.item_id = :item AND t.deleted_at IS NULL")
    suspend fun taxesForItem(item: String): List<TaxEntity>

    @Upsert
    suspend fun upsertLineTaxes(rows: List<TicketLineTaxEntity>)

    @Query("SELECT * FROM ticket_line_taxes WHERE line_id = :line")
    suspend fun lineTaxes(line: String): List<TicketLineTaxEntity>

    @Query("SELECT * FROM modifiers WHERE deleted_at IS NULL AND group_id IN (SELECT group_id FROM item_modifier_groups WHERE item_id = :item)")
    suspend fun modifiersForItem(item: String): List<ModifierEntity>

    @Query("SELECT * FROM modifier_groups WHERE deleted_at IS NULL AND id IN (SELECT group_id FROM item_modifier_groups WHERE item_id = :item)")
    suspend fun groupsForItem(item: String): List<ModifierGroupEntity>

    @Query("SELECT * FROM dining_options WHERE deleted_at IS NULL ORDER BY sort_order, name")
    suspend fun diningOptions(): List<DiningOptionEntity>

    @Query("SELECT * FROM payment_types WHERE deleted_at IS NULL AND is_active ORDER BY sort_order")
    fun paymentTypes(): kotlinx.coroutines.flow.Flow<List<PaymentTypeEntity>>

    @Query("SELECT * FROM discounts WHERE deleted_at IS NULL ORDER BY name")
    suspend fun discounts(): List<DiscountEntity>

    @Query("SELECT * FROM discounts WHERE id = :id")
    suspend fun discount(id: String): DiscountEntity?

    @Upsert
    suspend fun upsertDiscounts(rows: List<DiscountEntity>)

    @Query("DELETE FROM categories") suspend fun clearCategories()
    @Query("DELETE FROM items") suspend fun clearItems()
    @Query("DELETE FROM modifier_groups") suspend fun clearGroups()
    @Query("DELETE FROM modifiers") suspend fun clearModifiers()
    @Query("DELETE FROM taxes") suspend fun clearTaxes()
    @Query("DELETE FROM dining_options") suspend fun clearDining()
    @Query("DELETE FROM payment_types") suspend fun clearPayments()
    @Query("DELETE FROM discounts") suspend fun clearDiscounts()
    @Query("DELETE FROM item_taxes") suspend fun clearItemTaxes()
    @Query("DELETE FROM item_modifier_groups") suspend fun clearItemModGroups()

    // The catalog mirror only. Stores and devices stay: open tickets point at
    // the store, and the device row carries this till's receipt sequence.
    @Transaction
    suspend fun clearCatalog() {
        clearItemTaxes(); clearItemModGroups(); clearItems(); clearCategories()
        clearModifiers(); clearGroups(); clearTaxes(); clearDining()
        clearPayments(); clearDiscounts()
    }
}

@Dao
interface SyncDao {
    @Query("SELECT * FROM sync_state WHERE store_id = :store")
    suspend fun cursor(store: String): SyncStateEntity?

    @Upsert
    suspend fun saveCursor(state: SyncStateEntity)
}

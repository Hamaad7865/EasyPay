package com.restopos.core.database

import androidx.paging.PagingSource
import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

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

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertCategories(rows: List<CategoryEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertItems(rows: List<ItemEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertGroups(rows: List<ModifierGroupEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertModifiers(rows: List<ModifierEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertTaxes(rows: List<TaxEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertDining(rows: List<DiningOptionEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertPayments(rows: List<PaymentTypeEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertStores(rows: List<StoreEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertDevices(rows: List<DeviceEntity>)

    @Query("SELECT * FROM items WHERE id = :id")
    suspend fun item(id: String): ItemEntity?

    @Query("SELECT * FROM pos_devices WHERE id = :id")
    suspend fun device(id: String): DeviceEntity?

    @Query("SELECT * FROM stores WHERE id = :id")
    suspend fun store(id: String): StoreEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertItemTaxes(rows: List<ItemTaxCrossRef>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertItemModGroups(rows: List<ItemModGroupCrossRef>)

    @Query("SELECT t.* FROM taxes t JOIN item_taxes it ON it.tax_id = t.id WHERE it.item_id = :item AND t.deleted_at IS NULL")
    suspend fun taxesForItem(item: String): List<TaxEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertLineTaxes(rows: List<TicketLineTaxEntity>)

    @Query("SELECT * FROM ticket_line_taxes WHERE line_id = :line")
    suspend fun lineTaxes(line: String): List<TicketLineTaxEntity>

    @Query("SELECT * FROM modifiers WHERE group_id IN (SELECT group_id FROM item_modifier_groups WHERE item_id = :item)")
    suspend fun modifiersForItem(item: String): List<ModifierEntity>

    @Query("SELECT * FROM modifier_groups WHERE id IN (SELECT group_id FROM item_modifier_groups WHERE item_id = :item)")
    suspend fun groupsForItem(item: String): List<ModifierGroupEntity>

    @Query("SELECT * FROM payment_types WHERE deleted_at IS NULL AND is_active ORDER BY sort_order")
    fun paymentTypes(): kotlinx.coroutines.flow.Flow<List<PaymentTypeEntity>>

    @Query("SELECT * FROM discounts WHERE deleted_at IS NULL ORDER BY name")
    suspend fun discounts(): List<DiscountEntity>

    @Query("SELECT * FROM discounts WHERE id = :id")
    suspend fun discount(id: String): DiscountEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertDiscounts(rows: List<DiscountEntity>)
}

@Dao
interface SyncDao {
    @Query("SELECT * FROM sync_state WHERE store_id = :store")
    suspend fun cursor(store: String): SyncStateEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveCursor(state: SyncStateEntity)
}

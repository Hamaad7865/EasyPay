package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert

// What a tablet that works on its own reads and writes when it answers a
// change itself (core/data/LocalAnswers): the rows the server would have
// written, in the tablet's own copy of them. Kept apart from the other DAOs
// so that the rules can be run against a stand-in on the JVM: each rule is
// the server's own, and the test of it is that stand-in.
@Dao
interface AloneDao {
    // ---- items ----
    @Query("SELECT * FROM items WHERE id = :id") suspend fun item(id: String): ItemEntity?
    @Upsert suspend fun putItem(row: ItemEntity)
    @Query("SELECT COUNT(*) FROM items WHERE barcode = :code AND deleted_at IS NULL AND id <> :not") suspend fun itemsWithBarcode(code: String, not: String): Int
    @Query("SELECT COUNT(*) FROM item_variants v JOIN items i ON i.id = v.item_id WHERE v.barcode = :code AND v.deleted_at IS NULL AND i.deleted_at IS NULL AND v.id <> :not")
    suspend fun variantsWithBarcode(code: String, not: String): Int
    @Query("SELECT COUNT(*) FROM items WHERE LOWER(sku) = LOWER(:sku) AND deleted_at IS NULL AND id <> :not") suspend fun itemsWithSku(sku: String, not: String): Int
    @Query("SELECT COUNT(*) FROM item_variants v JOIN items i ON i.id = v.item_id WHERE LOWER(v.sku) = LOWER(:sku) AND v.deleted_at IS NULL AND i.deleted_at IS NULL AND v.id <> :not")
    suspend fun variantsWithSku(sku: String, not: String): Int
    @Query("SELECT COUNT(*) FROM items WHERE category_id = :category AND deleted_at IS NULL") suspend fun itemsIn(category: String): Int

    // ---- categories ----
    @Query("SELECT * FROM categories WHERE id = :id") suspend fun category(id: String): CategoryEntity?
    @Upsert suspend fun putCategory(row: CategoryEntity)
    @Query("SELECT COALESCE(MAX(sort_order), -1) FROM categories WHERE deleted_at IS NULL") suspend fun lastCategoryPlace(): Int

    // ---- taxes ----
    @Query("SELECT * FROM taxes") suspend fun taxes(): List<TaxEntity>
    @Upsert suspend fun putTaxes(rows: List<TaxEntity>)
    @Query("SELECT tax_id FROM item_taxes WHERE item_id = :item") suspend fun taxesOf(item: String): List<String>
    @Query("DELETE FROM item_taxes WHERE item_id = :item") suspend fun dropTaxesOf(item: String)
    @Upsert suspend fun putItemTax(row: ItemTaxCrossRef)

    // ---- variants and stock ----
    @Query("SELECT * FROM item_variants WHERE item_id = :item AND deleted_at IS NULL") suspend fun variantsOf(item: String): List<ItemVariantEntity>
    @Query("SELECT * FROM stock_levels WHERE store_id = :store AND item_id = :item") suspend fun levelsOf(store: String, item: String): List<StockLevelEntity>
    @Upsert suspend fun putLevels(rows: List<StockLevelEntity>)
    @Upsert suspend fun putMovement(row: StockMovementEntity)

    // ---- suppliers ----
    @Query("SELECT * FROM suppliers WHERE id = :id") suspend fun supplier(id: String): SupplierEntity?
    @Query("SELECT COUNT(*) FROM suppliers WHERE LOWER(name) = LOWER(:name) AND deleted_at IS NULL AND id <> :not") suspend fun suppliersNamed(name: String, not: String): Int
    @Upsert suspend fun putSupplier(row: SupplierEntity)

    // ---- tables ----
    @Query("SELECT * FROM tables WHERE store_id = :store AND deleted_at IS NULL") suspend fun tables(store: String): List<TableEntity>
    @Upsert suspend fun putTables(rows: List<TableEntity>)

    // ---- printers ----
    @Query("SELECT * FROM printers WHERE id = :id") suspend fun printer(id: String): PrinterEntity?
    @Query("SELECT * FROM printers WHERE deleted_at IS NULL") suspend fun printers(): List<PrinterEntity>
    @Upsert suspend fun putPrinter(row: PrinterEntity)

    // ---- settings ----
    @Query("SELECT * FROM pos_settings LIMIT 1") suspend fun settings(): SettingsEntity?
    @Upsert suspend fun putSettings(row: SettingsEntity)

    // ---- staff ----
    @Query("SELECT * FROM employees WHERE id = :id") suspend fun employee(id: String): EmployeeEntity?
    @Upsert suspend fun putEmployee(row: EmployeeEntity)
    @Upsert suspend fun putEmployeeStores(rows: List<EmployeeStoreEntity>)
    @Query("SELECT * FROM roles WHERE id = :id") suspend fun role(id: String): RoleEntity?
    @Query("SELECT id FROM stores WHERE deleted_at IS NULL") suspend fun storeIds(): List<String>
    @Query("SELECT * FROM roles") suspend fun roles(): List<RoleEntity>
    @Upsert suspend fun putRole(row: RoleEntity)
    @Query("SELECT COUNT(*) FROM employees WHERE role_id = :role AND deleted_at IS NULL") suspend fun staffOn(role: String): Int

    // ---- discounts ----
    @Query("SELECT * FROM discounts") suspend fun discounts(): List<DiscountEntity>
    @Upsert suspend fun putDiscount(row: DiscountEntity)
}

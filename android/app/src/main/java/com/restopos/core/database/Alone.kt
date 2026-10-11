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
    // The highest 13-digit code beginning as EasyPay's own do that this tablet
    // has ever held, removed lines included: a number is not given out twice.
    @Query("SELECT MAX(barcode) FROM items WHERE barcode LIKE :like AND LENGTH(barcode) = 13") suspend fun topItemBarcode(like: String): String?
    @Query("SELECT MAX(barcode) FROM item_variants WHERE barcode LIKE :like AND LENGTH(barcode) = 13") suspend fun topVariantBarcode(like: String): String?
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
    @Query("SELECT * FROM item_variants WHERE id = :id") suspend fun variant(id: String): ItemVariantEntity?
    @Upsert suspend fun putVariants(rows: List<ItemVariantEntity>)
    // what a product holds, in every shop
    @Query("SELECT * FROM stock_levels WHERE item_id = :item") suspend fun levelsOfItem(item: String): List<StockLevelEntity>
    @Upsert suspend fun putMovement(row: StockMovementEntity)

    // ---- suppliers ----
    @Query("SELECT * FROM suppliers WHERE id = :id") suspend fun supplier(id: String): SupplierEntity?
    @Query("SELECT COUNT(*) FROM suppliers WHERE LOWER(name) = LOWER(:name) AND deleted_at IS NULL AND id <> :not") suspend fun suppliersNamed(name: String, not: String): Int
    @Upsert suspend fun putSupplier(row: SupplierEntity)

    // ---- orders to suppliers, and what arrives (server 0074, 0092) ----
    @Query("SELECT * FROM purchase_orders WHERE id = :id") suspend fun order(id: String): PurchaseOrderEntity?
    @Upsert suspend fun putOrder(row: PurchaseOrderEntity)
    @Query("SELECT * FROM purchase_order_lines WHERE order_id = :order") suspend fun orderLines(order: String): List<PurchaseOrderLineEntity>
    @Query("DELETE FROM purchase_order_lines WHERE order_id = :order") suspend fun dropOrderLines(order: String)
    @Upsert suspend fun putOrderLines(rows: List<PurchaseOrderLineEntity>)
    @Query("SELECT * FROM deliveries WHERE id = :id") suspend fun delivery(id: String): DeliveryEntity?
    @Query("SELECT COUNT(*) FROM deliveries WHERE order_id = :order") suspend fun deliveriesOf(order: String): Int
    @Upsert suspend fun putDelivery(row: DeliveryEntity)
    @Upsert suspend fun putDeliveryLines(rows: List<DeliveryLineEntity>)
    // every number this tablet holds, to give the next one: PO-0007, D-0012
    @Query("SELECT number FROM purchase_orders") suspend fun orderNumbers(): List<String>
    @Query("SELECT number FROM deliveries") suspend fun deliveryNumbers(): List<String>

    // ---- counts of the shelves (server 0074, 0092) ----
    @Query("SELECT * FROM stock_counts WHERE id = :id") suspend fun count(id: String): StockCountEntity?
    @Upsert suspend fun putCount(row: StockCountEntity)
    @Query("SELECT * FROM stock_count_lines WHERE count_id = :count") suspend fun countLines(count: String): List<StockCountLineEntity>
    @Query("DELETE FROM stock_count_lines WHERE count_id = :count") suspend fun dropCountLines(count: String)
    @Upsert suspend fun putCountLines(rows: List<StockCountLineEntity>)
    // a count this tablet began has no number until it is completed
    @Query("SELECT number FROM stock_counts WHERE number IS NOT NULL") suspend fun countNumbers(): List<String>

    // ---- tables ----
    @Query("SELECT * FROM tables WHERE store_id = :store AND deleted_at IS NULL") suspend fun tables(store: String): List<TableEntity>
    // any table of that id: another store's, or one that was removed
    @Query("SELECT * FROM tables WHERE id = :id") suspend fun table(id: String): TableEntity?
    @Upsert suspend fun putTables(rows: List<TableEntity>)
    // what stands in a store's rooms beside the tables (0102)
    @Query("SELECT * FROM floor_elements WHERE store_id = :store AND deleted_at IS NULL") suspend fun elements(store: String): List<FloorElementEntity>
    @Query("SELECT * FROM floor_elements WHERE id = :id") suspend fun element(id: String): FloorElementEntity?
    @Upsert suspend fun putElements(rows: List<FloorElementEntity>)

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

    // ---- add-ons ----
    @Query("SELECT * FROM modifier_groups") suspend fun groups(): List<ModifierGroupEntity>
    @Upsert suspend fun putGroup(row: ModifierGroupEntity)
    @Query("SELECT * FROM modifiers WHERE group_id = :group") suspend fun choicesOf(group: String): List<ModifierEntity>
    @Query("SELECT * FROM modifiers WHERE id = :id") suspend fun choice(id: String): ModifierEntity?
    @Upsert suspend fun putChoices(rows: List<ModifierEntity>)
    @Query("SELECT group_id FROM item_modifier_groups WHERE item_id = :item") suspend fun groupsOf(item: String): List<String>
    @Query("DELETE FROM item_modifier_groups WHERE item_id = :item") suspend fun dropGroupsOf(item: String)
    @Query("DELETE FROM item_modifier_groups WHERE group_id = :group") suspend fun dropLinksTo(group: String)
    @Upsert suspend fun putItemGroups(rows: List<ItemModGroupCrossRef>)

    // ---- discounts ----
    @Query("SELECT * FROM discounts") suspend fun discounts(): List<DiscountEntity>
    @Upsert suspend fun putDiscount(row: DiscountEntity)
}

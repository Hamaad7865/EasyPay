package com.restopos.core.database

import androidx.room.Database
import androidx.room.RoomDatabase

// Version 1 is the first schema that was ever built: catalog, devices, sync
// state, tickets, receipts and the outbox. From here on every schema change
// ships a Migration + test, never a destructive fallback (spec 15).
@Database(
    entities = [
        StoreEntity::class, CategoryEntity::class, ItemEntity::class,
        ModifierGroupEntity::class, ModifierEntity::class, TaxEntity::class,
        DiningOptionEntity::class, PaymentTypeEntity::class, DeviceEntity::class,
        SyncStateEntity::class, OutboxEntity::class,
        TicketEntity::class, TicketLineEntity::class, TicketLineModEntity::class,
        ReceiptEntity::class, ReceiptPaymentEntity::class, ReceiptLineEntity::class,
        ItemTaxCrossRef::class, TicketLineTaxEntity::class,
        ItemModGroupCrossRef::class, DiscountEntity::class,
    ],
    version = 1,
    exportSchema = true,
)
abstract class TillDatabase : RoomDatabase() {
    abstract fun catalog(): CatalogDao
    abstract fun sync(): SyncDao
    abstract fun tickets(): TicketDao
    abstract fun receipts(): ReceiptDao
    abstract fun outbox(): OutboxDao
}

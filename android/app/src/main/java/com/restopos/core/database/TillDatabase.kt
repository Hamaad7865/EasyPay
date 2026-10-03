package com.restopos.core.database

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("CREATE TABLE tickets (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, store_id TEXT NOT NULL, table_id TEXT, dining_option_id TEXT, name TEXT, status TEXT NOT NULL DEFAULT 'open', note TEXT, covers INTEGER, deleted_at TEXT, server_seq INTEGER, updated_at INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE ticket_lines (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, item_id TEXT, variant_id TEXT, name_snapshot TEXT NOT NULL, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL, note TEXT, course INTEGER, paid INTEGER NOT NULL DEFAULT 0, sent_to_kitchen_at TEXT, voided_at TEXT, void_reason TEXT, deleted_at TEXT, server_seq INTEGER)");
        db.execSQL("CREATE TABLE ticket_line_modifiers (line_id TEXT NOT NULL, modifier_id TEXT NOT NULL, name_snapshot TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(line_id, modifier_id))");
        db.execSQL("CREATE TABLE receipts (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, store_id TEXT NOT NULL, device_id TEXT NOT NULL, ticket_id TEXT NOT NULL, number TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'sale', refund_of TEXT, subtotal INTEGER NOT NULL DEFAULT 0, discount_total INTEGER NOT NULL DEFAULT 0, tax_total INTEGER NOT NULL DEFAULT 0, service_charge INTEGER NOT NULL DEFAULT 0, rounding INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, needs_review INTEGER NOT NULL DEFAULT 0, device_time INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, server_seq INTEGER)");
        db.execSQL("CREATE TABLE receipt_payments (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE, payment_type_id TEXT NOT NULL, amount INTEGER NOT NULL, tendered INTEGER, change INTEGER NOT NULL DEFAULT 0, reference TEXT)");
        db.execSQL("CREATE TABLE receipt_lines (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE, name_snapshot TEXT NOT NULL, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE item_taxes (item_id TEXT NOT NULL, tax_id TEXT NOT NULL, PRIMARY KEY(item_id, tax_id))");
        db.execSQL("CREATE TABLE item_modifier_groups (item_id TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY(item_id, group_id))");
        db.execSQL("CREATE TABLE ticket_line_taxes (line_id TEXT NOT NULL, tax_id TEXT NOT NULL, rate_bp INTEGER NOT NULL, type TEXT NOT NULL, PRIMARY KEY(line_id, tax_id))");
        db.execSQL("CREATE TABLE discounts (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0, requires_approval INTEGER NOT NULL DEFAULT 0, deleted_at TEXT, server_seq INTEGER)");
        db.execSQL("CREATE INDEX index_ticket_lines_ticket_id ON ticket_lines(ticket_id)");
    }
};

// v1: catalog + devices + sync plumbing. v2 adds tickets/receipts (Phase 2).
// Every schema change ships a Migration + test, never destructive fallback (15).
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
    version = 2,
    exportSchema = true,
    autoMigrations = [],
)
abstract class TillDatabase : RoomDatabase() {
    abstract fun catalog(): CatalogDao
    abstract fun sync(): SyncDao
    abstract fun tickets(): TicketDao
    abstract fun receipts(): ReceiptDao
    abstract fun outbox(): OutboxDao
}

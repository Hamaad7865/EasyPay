package com.restopos.core.database

import androidx.room.Database
import androidx.room.RoomDatabase

// Version 1 is the first schema that was ever built: catalog, devices, sync
// state, tickets, receipts and the outbox. From here on every schema change
// ships a Migration, never a destructive fallback (spec 15).
// Version 2 adds staff (roles, employees, their stores), sales periods
// (shifts), clock punches, and who made each outbox op.
// Version 3 adds the floor plan's tables and who opened each order.
// Version 4 adds printers, the restaurant's settings, cash movements, day
// closings, where a category prints, when an order type goes to the kitchen,
// which payment types open the drawer, and what each receipt printed.
// Version 5 adds the check a line is on, for a split check.
// Version 6 adds drawer counts, seats and customers.
// Version 7 adds what the service screens need: an order type's kind, the
// takeaway board's details on an order, kitchen display tickets and bookings.
// Version 8 adds an item's barcode and which order line a receipt line paid.
// Version 9 adds what a shop sells with: a product's variants and what the
// shop holds of each, a product's SKU and how it is sold, and on a line of a
// sale the price it was listed at when it is charged something else; and the
// shop's receipts of the last 30 days as the server sends them, so a sale
// rung up on another till can be found and refunded here.
// Version 10 adds an item whose price is typed at the sale.
// Version 11 adds kitchen screens: a screen's pairing code and whether it
// shows everything, on its printers row; each screen's part of a kitchen
// ticket, the marks a screen is owed and what the till knows of each screen;
// and on a kitchen ticket the waiter and the order's remark.
// Version 12 changes no table: it makes a tablet read its products again.
// Version 13 adds what the back office asked of a till (server 0091): close
// its day, or write down cash taken out, which the till carries out itself.
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
        RoleEntity::class, EmployeeEntity::class, EmployeeStoreEntity::class,
        ShiftEntity::class, PunchEntity::class, TableEntity::class,
        PrinterEntity::class, SettingsEntity::class, CashMoveEntity::class, DayCloseEntity::class, DrawerCountEntity::class,
        CustomerEntity::class, KdsTicketEntity::class, BookingEntity::class,
        ItemVariantEntity::class, StockLevelEntity::class, ReceiptLineTaxEntity::class, ReceiptLineModEntity::class,
        KdsPartEntity::class, KdsOutEntity::class, KdsScreenEntity::class,
        TillRequestEntity::class,
    ],
    version = 13,
    exportSchema = true,
)
abstract class TillDatabase : RoomDatabase() {
    abstract fun catalog(): CatalogDao
    abstract fun sync(): SyncDao
    abstract fun tickets(): TicketDao
    abstract fun receipts(): ReceiptDao
    abstract fun outbox(): OutboxDao
    abstract fun staff(): StaffDao
    abstract fun tables(): TableDao
    abstract fun ops(): OpsDao
    abstract fun customers(): CustomerDao
    abstract fun service(): ServiceDao
    abstract fun retail(): RetailDao
}

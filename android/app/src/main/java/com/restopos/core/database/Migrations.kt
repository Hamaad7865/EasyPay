package com.restopos.core.database

import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

// Schema changes are applied in place: a tablet's open orders and unsynced
// sales survive an update. The statements are the ones Room generates for the
// entities (app/schemas/...); Room checks the result against them.
object Migrations {
    // 1 -> 2: staff, sales periods, clock punches, and who made each outbox op.
    val V1_V2 = object : Migration(1, 2) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `roles` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `name` TEXT NOT NULL, `permissions` TEXT NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `employees` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `name` TEXT NOT NULL, `pin_hash` TEXT, `role_id` TEXT, `is_active` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `employee_stores` (`employee_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`employee_id`, `store_id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `shifts` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `device_id` TEXT NOT NULL, `opened_by` TEXT, `opened_at` INTEGER NOT NULL, `opening_float` INTEGER NOT NULL, `closed_by` TEXT, `closed_at` INTEGER, `expected_cash` INTEGER, `counted_cash` INTEGER, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_shifts_device_id` ON `shifts` (`device_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `timeclock_punches` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `device_id` TEXT, `employee_id` TEXT NOT NULL, `kind` TEXT NOT NULL, `device_time` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_timeclock_punches_store_id` ON `timeclock_punches` (`store_id`)")
            db.execSQL("ALTER TABLE `outbox` ADD COLUMN `employee_id` TEXT")
            // The server has been sending staff and roles all along and version 1
            // discarded them; the cursor is already past those rows. Start the
            // pull again from the beginning so they arrive. Rows already here
            // are written over with the same values.
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // 2 -> 3: the floor plan's tables, and who opened each order.
    val V2_V3 = object : Migration(2, 3) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `tables` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `name` TEXT NOT NULL, `area` TEXT NOT NULL, `seats` INTEGER NOT NULL, `shape` TEXT NOT NULL, `x` INTEGER NOT NULL, `y` INTEGER NOT NULL, `w` INTEGER NOT NULL, `h` INTEGER NOT NULL, `sort_order` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_tables_store_id` ON `tables` (`store_id`)")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `opened_by` TEXT")
            // Tables laid out before this build was installed were sent and
            // discarded, like staff in version 1: pull again from the start.
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // 3 -> 4: printing, settings, cash movements and day closings.
    val V3_V4 = object : Migration(3, 4) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `printers` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `name` TEXT NOT NULL, `kind` TEXT NOT NULL, `address` TEXT, `paper_mm` INTEGER NOT NULL, `is_receipt` INTEGER NOT NULL, `feed_lines` INTEGER NOT NULL, `cut` INTEGER NOT NULL, `is_active` INTEGER NOT NULL, `sort_order` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_printers_store_id` ON `printers` (`store_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `pos_settings` (`tenant_id` TEXT NOT NULL, `data` TEXT NOT NULL, PRIMARY KEY(`tenant_id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `cash_movements` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `device_id` TEXT NOT NULL, `shift_id` TEXT, `employee_id` TEXT, `type` TEXT NOT NULL, `amount` INTEGER NOT NULL, `reason` TEXT, `device_time` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_cash_movements_device_id` ON `cash_movements` (`device_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `day_closes` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `device_id` TEXT NOT NULL, `number` INTEGER NOT NULL, `closed_by` TEXT, `from_time` INTEGER, `closed_at` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_day_closes_device_id` ON `day_closes` (`device_id`)")
            db.execSQL("ALTER TABLE `categories` ADD COLUMN `printer_ids` TEXT NOT NULL DEFAULT '[]'")
            db.execSQL("ALTER TABLE `categories` ADD COLUMN `is_stock` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE `dining_options` ADD COLUMN `needs_table` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE `dining_options` ADD COLUMN `kitchen` TEXT NOT NULL DEFAULT 'save'")
            db.execSQL("ALTER TABLE `payment_types` ADD COLUMN `opens_drawer` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE `receipts` ADD COLUMN `doc` TEXT")
            // The server has been sending these all along; pull again from the
            // start so they arrive with their new columns.
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // 4 -> 5: which check of a split check a line is on.
    val V4_V5 = object : Migration(4, 5) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `ticket_lines` ADD COLUMN `check_no` INTEGER NOT NULL DEFAULT 1")
        }
    }

    // 5 -> 6: the drawer counted during a shift, the seat an item is for, and
    // customers.
    val V5_V6 = object : Migration(5, 6) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `ticket_lines` ADD COLUMN `seat` INTEGER")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `customer_id` TEXT")
            db.execSQL("CREATE TABLE IF NOT EXISTS `customers` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `name` TEXT NOT NULL, `phone` TEXT, `email` TEXT, `note` TEXT, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `drawer_counts` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `device_id` TEXT NOT NULL, `shift_id` TEXT NOT NULL, `employee_id` TEXT, `counted` INTEGER NOT NULL, `expected` INTEGER NOT NULL, `device_time` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_drawer_counts_shift_id` ON `drawer_counts` (`shift_id`)")
        }
    }

    // 6 -> 7: an order type's kind, an item's tags, the takeaway board's
    // details on an order, kitchen display tickets and bookings.
    val V6_V7 = object : Migration(6, 7) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `items` ADD COLUMN `tags` TEXT NOT NULL DEFAULT ''")
            db.execSQL("ALTER TABLE `dining_options` ADD COLUMN `kind` TEXT NOT NULL DEFAULT 'counter'")
            db.execSQL("UPDATE `dining_options` SET `kind` = 'dine' WHERE `needs_table` = 1")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `order_no` TEXT")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `phone` TEXT")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `address` TEXT")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `due_at` INTEGER")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `stage` TEXT")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `rider` TEXT")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `source` TEXT")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `bill_at` INTEGER")
            db.execSQL("ALTER TABLE `ticket_lines` ADD COLUMN `kds_id` TEXT")
            db.execSQL("ALTER TABLE `ticket_lines` ADD COLUMN `kitchen_done` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("CREATE TABLE IF NOT EXISTS `kds_tickets` (`id` TEXT NOT NULL, `ticket_id` TEXT NOT NULL, `no` INTEGER NOT NULL, `label` TEXT NOT NULL, `kind` TEXT NOT NULL, `covers` INTEGER, `created_at` INTEGER NOT NULL, `bumped_at` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_kds_tickets_ticket_id` ON `kds_tickets` (`ticket_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `bookings` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `booked_for` INTEGER NOT NULL, `name` TEXT NOT NULL, `size` INTEGER NOT NULL, `phone` TEXT, `area` TEXT, `table_id` TEXT, `tags` TEXT, `status` TEXT NOT NULL, `ticket_id` TEXT, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_bookings_store_id` ON `bookings` (`store_id`)")
            // The server has more to say about what is already here (each order
            // type's kind, each item's tags) and bookings to send: pull again
            // from the start.
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // 7 -> 8: an item's barcode (for a scanner plugged into the tablet), and
    // which line of the order each line of a receipt paid for (to refund part
    // of a receipt).
    val V7_V8 = object : Migration(7, 8) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `items` ADD COLUMN `barcode` TEXT")
            db.execSQL("ALTER TABLE `receipt_lines` ADD COLUMN `ticket_line_id` TEXT")
            // the barcodes are on the server already: pull the menu again
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // 8 -> 9: what a shop sells with. A product's variants and what the shop
    // holds of each product; a product's SKU, how it is sold and whether its
    // stock is counted; and, on a line of a sale and of a receipt, the price
    // it was listed at when it is charged something else.
    val V8_V9 = object : Migration(8, 9) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `item_variants` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `item_id` TEXT NOT NULL, `name` TEXT NOT NULL, `price` INTEGER NOT NULL, `sku` TEXT, `barcode` TEXT, `option_values` TEXT NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_item_variants_item_id` ON `item_variants` (`item_id`)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_item_variants_barcode` ON `item_variants` (`barcode`)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_item_variants_sku` ON `item_variants` (`sku`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `stock_levels` (`store_id` TEXT NOT NULL, `item_id` TEXT NOT NULL, `variant_id` TEXT NOT NULL, `qty` INTEGER NOT NULL, `server_seq` INTEGER, PRIMARY KEY(`store_id`, `item_id`, `variant_id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_stock_levels_item_id` ON `stock_levels` (`item_id`)")
            db.execSQL("ALTER TABLE `items` ADD COLUMN `sku` TEXT")
            db.execSQL("ALTER TABLE `items` ADD COLUMN `sold_by` TEXT NOT NULL DEFAULT 'each'")
            db.execSQL("ALTER TABLE `items` ADD COLUMN `track_stock` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE `items` ADD COLUMN `option_names` TEXT NOT NULL DEFAULT '[]'")
            db.execSQL("ALTER TABLE `ticket_lines` ADD COLUMN `list_price` INTEGER")
            db.execSQL("ALTER TABLE `ticket_lines` ADD COLUMN `price_kind` TEXT")
            db.execSQL("ALTER TABLE `ticket_lines` ADD COLUMN `price_label` TEXT")
            db.execSQL("ALTER TABLE `ticket_lines` ADD COLUMN `price_by` TEXT")
            db.execSQL("ALTER TABLE `receipt_lines` ADD COLUMN `list_price` INTEGER")
            db.execSQL("ALTER TABLE `receipt_lines` ADD COLUMN `price_kind` TEXT")
            db.execSQL("ALTER TABLE `receipt_lines` ADD COLUMN `price_label` TEXT")
            // the shop's receipts as the server sends them: found and refunded on any till
            db.execSQL("ALTER TABLE `receipts` ADD COLUMN `pulled` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("CREATE TABLE IF NOT EXISTS `receipt_line_taxes` (`id` TEXT NOT NULL, `receipt_line_id` TEXT NOT NULL, `tax_id` TEXT NOT NULL, `name` TEXT NOT NULL, `rate_bp` INTEGER NOT NULL, `type` TEXT NOT NULL, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_receipt_line_taxes_receipt_line_id` ON `receipt_line_taxes` (`receipt_line_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `receipt_line_mods` (`id` TEXT NOT NULL, `receipt_line_id` TEXT NOT NULL, `price` INTEGER NOT NULL, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_receipt_line_mods_receipt_line_id` ON `receipt_line_mods` (`receipt_line_id`)")
            // The server has been sending variants all along and this till
            // read past them; stock levels and the products' new columns are
            // there too. Pull again from the start so they arrive.
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // 9 -> 10: an item whose price is typed at the sale (server 0083).
    val V9_V10 = object : Migration(9, 10) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `items` ADD COLUMN `open_price` INTEGER NOT NULL DEFAULT 0")
            // An item marked before this build was installed has been pulled
            // already, without its mark, and would be sold at nothing. Pull
            // again from the start so the mark arrives.
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // 10 -> 11: kitchen screens (server 0086). A screen is a printers row
    // with a pairing code; the till writes down each screen's part of a
    // kitchen ticket, the marks it owes a screen, and what it knows of each.
    val V10_V11 = object : Migration(10, 11) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `printers` ADD COLUMN `pair_code` TEXT")
            db.execSQL("ALTER TABLE `printers` ADD COLUMN `all_items` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE `kds_tickets` ADD COLUMN `waiter` TEXT")
            db.execSQL("ALTER TABLE `kds_tickets` ADD COLUMN `remark` TEXT")
            db.execSQL("CREATE TABLE IF NOT EXISTS `kds_parts` (`kds_id` TEXT NOT NULL, `screen_id` TEXT NOT NULL, `payload` TEXT NOT NULL, `line_ids` TEXT NOT NULL, `delivered` INTEGER NOT NULL, `bumped_at` INTEGER, `created_at` INTEGER NOT NULL, PRIMARY KEY(`kds_id`, `screen_id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_kds_parts_screen_id` ON `kds_parts` (`screen_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `kds_out` (`id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, `screen_id` TEXT NOT NULL, `mark` TEXT NOT NULL)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_kds_out_screen_id` ON `kds_out` (`screen_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `kds_screens` (`screen_id` TEXT NOT NULL, `epoch` TEXT NOT NULL, `read_to` INTEGER NOT NULL, `heard_at` INTEGER, `trouble` TEXT, PRIMARY KEY(`screen_id`))")
            // A kitchen screen entered before this build was installed has
            // been pulled already, without its code: nothing could be sent to
            // it. Pull again from the start so the code arrives.
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // Nothing of the database changes. Until this build the till did not
    // read, off a product arriving from the back office, that its price is
    // typed at the sale: every such product is stored as one with a fixed
    // price, and a tap rings it up without asking. The products are read
    // again from the start, so the mark arrives.
    val V11_V12 = object : Migration(11, 12) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // What the back office asked of a till (server 0091): one new table, and
    // nothing else changes. A pull fills it.
    val V12_V13 = object : Migration(12, 13) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `till_requests` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `device_id` TEXT NOT NULL, `shift_id` TEXT NOT NULL, `kind` TEXT NOT NULL, `counted_cash` INTEGER, `amount` INTEGER, `reason` TEXT, `requested_by` TEXT, `requested_at` INTEGER NOT NULL, `status` TEXT NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, `answered` INTEGER NOT NULL, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_till_requests_device_id` ON `till_requests` (`device_id`)")
        }
    }
}

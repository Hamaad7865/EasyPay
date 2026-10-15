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

    // A shop's stock papers (server 0092): suppliers, orders and deliveries
    // with their lines, counts and theirs, every movement of stock, and an
    // order or a delivery being typed. And three tables keep what the server
    // already sent and the till dropped: a product's cost, supplier and brand,
    // a variant's cost, and on a line of stock its average cost and the level
    // to order again at. The products were stored without them, so everything
    // is read again from the start.
    val V13_V14 = object : Migration(13, 14) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `items` ADD COLUMN `cost` INTEGER")
            db.execSQL("ALTER TABLE `items` ADD COLUMN `supplier_id` TEXT")
            db.execSQL("ALTER TABLE `items` ADD COLUMN `brand` TEXT")
            db.execSQL("ALTER TABLE `item_variants` ADD COLUMN `cost` INTEGER")
            db.execSQL("ALTER TABLE `stock_levels` ADD COLUMN `avg_cost` REAL NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE `stock_levels` ADD COLUMN `reorder_point` INTEGER")
            db.execSQL("ALTER TABLE `stock_levels` ADD COLUMN `reorder_qty` INTEGER")
            db.execSQL("CREATE TABLE IF NOT EXISTS `suppliers` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `name` TEXT NOT NULL, `contact` TEXT, `phone` TEXT, `email` TEXT, `address` TEXT, `note` TEXT, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `purchase_orders` (`id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `number` TEXT NOT NULL, `supplier_id` TEXT NOT NULL, `status` TEXT NOT NULL, `expected_on` TEXT, `note` TEXT, `created_by` TEXT, `sent_at` INTEGER, `created_at` INTEGER NOT NULL, `updated_at` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_purchase_orders_store_id` ON `purchase_orders` (`store_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `purchase_order_lines` (`order_id` TEXT NOT NULL, `item_id` TEXT NOT NULL, `variant_id` TEXT NOT NULL, `qty` INTEGER NOT NULL, `unit_cost` INTEGER NOT NULL, `received` INTEGER NOT NULL, PRIMARY KEY(`order_id`, `item_id`, `variant_id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `deliveries` (`id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `number` TEXT NOT NULL, `order_id` TEXT, `supplier_id` TEXT, `arrived_on` TEXT NOT NULL, `invoice_no` TEXT, `note` TEXT, `received_by` TEXT, `created_at` INTEGER NOT NULL, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_deliveries_store_id` ON `deliveries` (`store_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `delivery_lines` (`delivery_id` TEXT NOT NULL, `item_id` TEXT NOT NULL, `variant_id` TEXT NOT NULL, `qty` INTEGER NOT NULL, `unit_cost` INTEGER NOT NULL, PRIMARY KEY(`delivery_id`, `item_id`, `variant_id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `stock_counts` (`id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `number` TEXT, `scope_kind` TEXT NOT NULL, `scope_id` TEXT, `scope_text` TEXT, `title` TEXT NOT NULL, `status` TEXT NOT NULL, `uncounted` TEXT, `started_by` TEXT, `completed_by` TEXT, `completed_at` INTEGER, `created_at` INTEGER NOT NULL, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_stock_counts_store_id` ON `stock_counts` (`store_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `stock_count_lines` (`count_id` TEXT NOT NULL, `item_id` TEXT NOT NULL, `variant_id` TEXT NOT NULL, `counted` INTEGER, `counted_at` INTEGER, `left_out` INTEGER NOT NULL, `expected` INTEGER, `diff` INTEGER, `unit_cost` REAL, `server_seq` INTEGER, PRIMARY KEY(`count_id`, `item_id`, `variant_id`))")
            db.execSQL("CREATE TABLE IF NOT EXISTS `stock_movements` (`id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `item_id` TEXT NOT NULL, `variant_id` TEXT NOT NULL, `qty` INTEGER NOT NULL, `reason` TEXT NOT NULL, `unit_cost` REAL, `ref_type` TEXT, `ref_id` TEXT, `receipt_id` TEXT, `employee_id` TEXT, `note` TEXT, `created_at` INTEGER NOT NULL, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_stock_movements_store_id_created_at` ON `stock_movements` (`store_id`, `created_at`)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_stock_movements_item_id` ON `stock_movements` (`item_id`)")
            db.execSQL("CREATE TABLE IF NOT EXISTS `stock_drafts` (`kind` TEXT NOT NULL, `body` TEXT NOT NULL, `updated_at` INTEGER NOT NULL, PRIMARY KEY(`kind`))")
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }

    // The orders guests send from the codes on their tables (server 0093,
    // core/guest): which table, the lines as they came, and how each stands.
    val V14_V15 = object : Migration(14, 15) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `guest_orders` (`id` TEXT NOT NULL, `table_id` TEXT NOT NULL, `lines` TEXT NOT NULL, `placed_at` INTEGER NOT NULL, `received_at` INTEGER NOT NULL, `status` TEXT NOT NULL, `reason` TEXT, `answered_at` INTEGER, `told` INTEGER NOT NULL, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_guest_orders_status` ON `guest_orders` (`status`)")
        }
    }

    // The tablet's own log, for its reports (Price Change, Resettlement): one
    // new table, and nothing else changes. It starts empty: what was changed
    // before this build was not written down.
    val V15_V16 = object : Migration(15, 16) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `till_log` (`id` TEXT NOT NULL, `at` INTEGER NOT NULL, `kind` TEXT NOT NULL, `employee_id` TEXT, `approved_by` TEXT, `item_id` TEXT, `variant_id` TEXT, `receipt_id` TEXT, `was` TEXT NOT NULL, `became` TEXT NOT NULL, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_till_log_at` ON `till_log` (`at`)")
        }
    }

    // 17: the fuller product sheet (server 0094). The supplier's own code
    // for a product always came with the product and was dropped; the sheet
    // shows it now. Empty until the next pull that carries the product.
    val V16_V17 = object : Migration(16, 17) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `items` ADD COLUMN `supplier_code` TEXT")
        }
    }

    // 18: roles and staff from the till (server 0095). Whether someone has a
    // login of their own always came with a pull and was dropped; the Staff
    // page needs it, because such a person is not changed from a till. False
    // until the next pull that carries them.
    val V17_V18 = object : Migration(17, 18) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `employees` ADD COLUMN `has_login` INTEGER NOT NULL DEFAULT 0")
        }
    }

    // 19: the floor plan's new pieces (server 0102). A table may be set at an
    // angle, and a room has what stands in it beside the tables: walls, doors,
    // windows, a bar. Every table there is straight, and no room has anything,
    // until a plan is saved or a pull brings them.
    val V18_V19 = object : Migration(18, 19) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `tables` ADD COLUMN `rotation` INTEGER NOT NULL DEFAULT 0")
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS `floor_elements` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, " +
                    "`area` TEXT NOT NULL, `kind` TEXT NOT NULL, `x` INTEGER NOT NULL, `y` INTEGER NOT NULL, `w` INTEGER NOT NULL, `h` INTEGER NOT NULL, " +
                    "`rotation` INTEGER NOT NULL, `sort_order` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))",
            )
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_floor_elements_store_id` ON `floor_elements` (`store_id`)")
        }
    }

    // 20: a product's picture for its card on the till (item_pictures). The
    // tablet's own: nothing of the server's is touched, and no product has a
    // picture until one is chosen for it on its sheet.
    val V19_V20 = object : Migration(19, 20) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `item_pictures` (`item_id` TEXT NOT NULL, `jpeg` BLOB NOT NULL, `updated_at` INTEGER NOT NULL, PRIMARY KEY(`item_id`))")
        }
    }

    // 21: how many of an add-on a line takes (server 0105): three sausages on
    // a grillade. Every add-on already on a line is one of it, as it was.
    val V20_V21 = object : Migration(20, 21) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `ticket_line_modifiers` ADD COLUMN `qty` INTEGER NOT NULL DEFAULT 1")
        }
    }

    // 22: a choice that is picked alone (server 0106): All among the sauces
    // takes the others off, and another takes All off. A choice already
    // called All or None is marked, as the server marks it, so a tablet that
    // works on its own has it too; any other is marked on the add-on sheet.
    val V21_V22 = object : Migration(21, 22) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `modifiers` ADD COLUMN `alone` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("UPDATE `modifiers` SET `alone` = 1 WHERE `deleted_at` IS NULL AND lower(trim(`name`)) IN ('all', 'none')")
        }
    }

    // 23: when a takeaway is picked up, on its kitchen tickets: what the
    // kitchen's paper says of it, kept for this till's Kitchen screen. A
    // ticket sent before this says nothing, as its paper did.
    val V22_V23 = object : Migration(22, 23) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `kds_tickets` ADD COLUMN `pickup` TEXT")
        }
    }

    // 24: a takeaway nobody came for (server 0107): when it was marked a
    // no-show, what was still to pay, and who marked it. No order has any of
    // them until one is marked.
    val V23_V24 = object : Migration(23, 24) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `no_show_at` INTEGER")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `no_show_total` INTEGER")
            db.execSQL("ALTER TABLE `tickets` ADD COLUMN `no_show_by` TEXT")
        }
    }

    // 25: how many of a choice one line may take (server 0108). Every choice
    // already on a menu is one or none, as the server makes it: the ones that
    // are counted (eggs, sausages) are marked Several by hand.
    val V24_V25 = object : Migration(24, 25) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `modifiers` ADD COLUMN `max_qty` INTEGER NOT NULL DEFAULT 1")
        }
    }

    // 25 -> 26: a shop's credit notes (server 0109).
    val V25_V26 = object : Migration(25, 26) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `credit_notes` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `device_id` TEXT NOT NULL, `number` TEXT NOT NULL, `amount` INTEGER NOT NULL, `balance` INTEGER NOT NULL, `refund_id` TEXT NOT NULL, `customer_id` TEXT, `valid_to` TEXT, `status` TEXT NOT NULL, `issued_by` TEXT, `created_at` INTEGER NOT NULL, `server_seq` INTEGER, `pulled` INTEGER NOT NULL, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_credit_notes_number` ON `credit_notes` (`number`)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_credit_notes_refund_id` ON `credit_notes` (`refund_id`)")
        }
    }

    // 26 -> 27: a shop's promotions (server 0110), and the price before one on a product and a variant.
    val V26_V27 = object : Migration(26, 27) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `items` ADD COLUMN `promo_was` INTEGER")
            db.execSQL("ALTER TABLE `item_variants` ADD COLUMN `promo_was` INTEGER")
            db.execSQL("CREATE TABLE IF NOT EXISTS `promotions` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `item_id` TEXT NOT NULL, `variant_id` TEXT NOT NULL, `original_price` INTEGER NOT NULL, `promo_price` INTEGER NOT NULL, `status` TEXT NOT NULL, `note` TEXT, `applied_by` TEXT, `applied_at` INTEGER NOT NULL, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_promotions_item_id` ON `promotions` (`item_id`)")
        }
    }

    // 27 -> 28: "See the day's payments" became a tick of its own (server
    // 0111). A tablet that works on its own never hears of the server's
    // migration, so the roles it holds are given it here by the same rule
    // (Perms.grantPayments); a tablet that syncs has the server's roles back
    // at its next pull.
    val V27_V28 = object : Migration(27, 28) {
        override fun migrate(db: SupportSQLiteDatabase) {
            val changed = ArrayList<Pair<String, String>>()
            db.query("SELECT `id`, `permissions` FROM `roles`").use { c ->
                while (c.moveToNext()) com.restopos.core.data.Perms.grantPayments(c.getString(1))?.let { changed += c.getString(0) to it }
            }
            changed.forEach { (id, perms) -> db.execSQL("UPDATE `roles` SET `permissions` = ? WHERE `id` = ?", arrayOf<Any>(perms, id)) }
        }
    }
}

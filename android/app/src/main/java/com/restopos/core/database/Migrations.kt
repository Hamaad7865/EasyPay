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

    // 5 -> 6: the drawer counted during a shift.
    val V5_V6 = object : Migration(5, 6) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `drawer_counts` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `device_id` TEXT NOT NULL, `shift_id` TEXT NOT NULL, `employee_id` TEXT, `counted` INTEGER NOT NULL, `expected` INTEGER NOT NULL, `device_time` INTEGER NOT NULL, `deleted_at` TEXT, `server_seq` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_drawer_counts_shift_id` ON `drawer_counts` (`shift_id`)")
        }
    }
}

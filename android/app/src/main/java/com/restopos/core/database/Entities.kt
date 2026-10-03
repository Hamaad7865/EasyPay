package com.restopos.core.database

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

// Room mirrors the server tables one to one, same names and columns (spec 6).
// Money: Long cents. serverSeq: pull ordering. deletedAt: soft delete.
// No foreign keys between mirrored tables: a pull page can deliver an item
// before its category, and the server already guarantees the references.

@Entity(tableName = "stores")
data class StoreEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val code: String,
    val timezone: String = "Indian/Mauritius",
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "categories")
data class CategoryEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val color: String? = null,
    val sort_order: Int = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(
    tableName = "items",
    indices = [Index("category_id"), Index("tenant_id")],
)
data class ItemEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val category_id: String? = null,
    val name: String,
    val price: Long,
    val is_available: Boolean = true,
    val tile_color: String? = null,
    val image_path: String? = null,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "modifier_groups")
data class ModifierGroupEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val min_select: Int = 0,
    val max_select: Int = 1,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "modifiers")
data class ModifierEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val group_id: String,
    val name: String,
    val price: Long = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "taxes")
data class TaxEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val rate_bp: Int,
    val type: String,
    val is_default: Boolean = false,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "dining_options")
data class DiningOptionEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val is_default: Boolean = false,
    val sort_order: Int = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "payment_types")
data class PaymentTypeEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val kind: String,
    val is_active: Boolean = true,
    val sort_order: Int = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "pos_devices")
data class DeviceEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val name: String,
    val code: String,
    val last_receipt_seq: Long = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// Pull cursor per store. Saved in the SAME txn as the page it came with (5.5).
// epochs is the server's per-table epoch map as last seen; when it changes the
// server rewrote history, so the mirror is cleared and pulled again from 0.
@Entity(tableName = "sync_state")
data class SyncStateEntity(
    @PrimaryKey val store_id: String,
    val cursor: Long = 0,
    val epochs: String = "",
)

// Outbox lands in Phase 2 with ticket mutations. Table created now so the
// schema (and its migration test) exists before first use.
@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val op_id: String,
    val type: String,
    val payload: String,
    val created_at: Long = System.currentTimeMillis(),
    val attempts: Int = 0,
    val state: String = "pending",
    val last_error: String? = null,
)

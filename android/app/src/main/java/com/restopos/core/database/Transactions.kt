package com.restopos.core.database

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

// Phase 2: tickets + receipts mirror (spec 6). Snapshots freeze catalog values;
// quantities are Int thousandths; money is Long cents.

@Entity(
    tableName = "tickets",
    foreignKeys = [ForeignKey(
        entity = StoreEntity::class, parentColumns = ["id"], childColumns = ["store_id"],
        onDelete = ForeignKey.RESTRICT,
    )],
    indices = [Index("store_id"), Index("status")],
)
data class TicketEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val table_id: String? = null,
    val dining_option_id: String? = null,
    val name: String? = null,
    val status: String = "open",
    val note: String? = null,
    val covers: Int? = null,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
    val updated_at: Long = System.currentTimeMillis(),
    // who opened the order (its waiter); null on an order made before staff PINs
    val opened_by: String? = null,
)

@Entity(
    tableName = "ticket_lines",
    foreignKeys = [ForeignKey(
        entity = TicketEntity::class, parentColumns = ["id"], childColumns = ["ticket_id"],
        onDelete = ForeignKey.CASCADE,
    )],
    indices = [Index("ticket_id")],
)
data class TicketLineEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val ticket_id: String,
    val item_id: String? = null,
    val variant_id: String? = null,
    val name_snapshot: String,
    val unit_price: Long,
    val qty: Int,
    val note: String? = null,
    val course: Int? = null,
    val paid: Boolean = false,
    val sent_to_kitchen_at: String? = null,
    val voided_at: String? = null,
    val void_reason: String? = null,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "ticket_line_modifiers", primaryKeys = ["line_id", "modifier_id"])
data class TicketLineModEntity(
    val line_id: String,
    val modifier_id: String,
    val name_snapshot: String,
    val price: Long = 0,
)

@Entity(tableName = "item_taxes", primaryKeys = ["item_id", "tax_id"])
data class ItemTaxCrossRef(
    val item_id: String,
    val tax_id: String,
)

@Entity(tableName = "item_modifier_groups", primaryKeys = ["item_id", "group_id"])
data class ItemModGroupCrossRef(
    val item_id: String,
    val group_id: String,
)

@Entity(tableName = "discounts")
data class DiscountEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val type: String,
    val value: Long,
    val requires_approval: Boolean = false,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

@Entity(tableName = "ticket_line_taxes", primaryKeys = ["line_id", "tax_id"])
data class TicketLineTaxEntity(
    val line_id: String,
    val tax_id: String,
    val rate_bp: Int,
    val type: String,
)

@Entity(tableName = "receipts")
data class ReceiptEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val ticket_id: String,
    val number: String,
    val type: String = "sale",
    val refund_of: String? = null,
    val subtotal: Long = 0,
    val discount_total: Long = 0,
    val tax_total: Long = 0,
    val service_charge: Long = 0,
    val rounding: Long = 0,
    val total: Long = 0,
    val needs_review: Boolean = false,
    val device_time: Long = System.currentTimeMillis(),
    val deleted_at: String? = null,
    val server_seq: Long? = null,
    // what was printed, as JSON (ReceiptDoc): a reprint prints this again
    val doc: String? = null,
)

@Entity(tableName = "receipt_payments")
data class ReceiptPaymentEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val receipt_id: String,
    val payment_type_id: String,
    val amount: Long,
    val tendered: Long? = null,
    val change: Long = 0,
    val reference: String? = null,
)

@Entity(tableName = "receipt_lines")
data class ReceiptLineEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val receipt_id: String,
    val name_snapshot: String,
    val unit_price: Long,
    val qty: Int,
)

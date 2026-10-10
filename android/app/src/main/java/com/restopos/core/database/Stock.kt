package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

// A shop's stock papers on the tablet: who it buys from, what it ordered,
// what arrived, what it counted, and every movement of its stock (server
// 0092). A linked till is sent them; the screens read them here and never
// from the network. Quantities are thousandths (one unit is 1000), money is
// cents, and "no variant" is "" as on stock_levels, so that a line of a
// document and a line of stock are named the same way.
// Nothing is removed from these tables as it ages: on a tablet that stands
// alone they will be the only copy.

@Entity(tableName = "suppliers")
data class SupplierEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val name: String,
    val contact: String? = null,
    val phone: String? = null,
    val email: String? = null,
    val address: String? = null,
    val note: String? = null,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// status: draft, sent, part (some of it arrived), received, closed, cancelled.
// expected_on is a day as the server writes it ("2026-10-20").
@Entity(tableName = "purchase_orders", indices = [Index("store_id")])
data class PurchaseOrderEntity(
    @PrimaryKey val id: String,
    val store_id: String,
    val number: String,
    val supplier_id: String,
    val status: String,
    val expected_on: String? = null,
    val note: String? = null,
    val created_by: String? = null,
    val sent_at: Long? = null,
    val created_at: Long = 0,
    val updated_at: Long = 0,
    val deleted_at: String? = null,
    val server_seq: Long? = null,
)

// received: how much of the line has arrived, over all its deliveries. An
// order arrives from the server with its lines, and they take the place of
// the ones kept here: a draft saved again has other lines, not more.
@Entity(tableName = "purchase_order_lines", primaryKeys = ["order_id", "item_id", "variant_id"])
data class PurchaseOrderLineEntity(
    val order_id: String,
    val item_id: String,
    val variant_id: String = "",
    val qty: Int,
    val unit_cost: Long,
    val received: Int = 0,
)

@Entity(tableName = "deliveries", indices = [Index("store_id")])
data class DeliveryEntity(
    @PrimaryKey val id: String,
    val store_id: String,
    val number: String,
    val order_id: String? = null,
    val supplier_id: String? = null,
    val arrived_on: String,
    val invoice_no: String? = null,
    val note: String? = null,
    val received_by: String? = null,
    val created_at: Long = 0,
    val server_seq: Long? = null,
)

@Entity(tableName = "delivery_lines", primaryKeys = ["delivery_id", "item_id", "variant_id"])
data class DeliveryLineEntity(
    val delivery_id: String,
    val item_id: String,
    val variant_id: String = "",
    val qty: Int,
    val unit_cost: Long,
)

// A count. One the tablet started has no number and no server_seq until it
// has gone up: the server numbers it, and its rows then take the place of
// these by their keys. status: open, completed, cancelled.
@Entity(tableName = "stock_counts", indices = [Index("store_id")])
data class StockCountEntity(
    @PrimaryKey val id: String,
    val store_id: String,
    val number: String? = null,
    val scope_kind: String,
    val scope_id: String? = null,
    val scope_text: String? = null,
    val title: String,
    val status: String,
    val uncounted: String? = null,
    val started_by: String? = null,
    val completed_by: String? = null,
    val completed_at: Long? = null,
    val created_at: Long = 0,
    val server_seq: Long? = null,
)

// counted null: nobody counted it. On the tablet's own count, expected is
// what the tablet held of the line when it was last counted; on a finished
// count it is what the server wrote, with the difference and the cost.
@Entity(tableName = "stock_count_lines", primaryKeys = ["count_id", "item_id", "variant_id"])
data class StockCountLineEntity(
    val count_id: String,
    val item_id: String,
    val variant_id: String = "",
    val counted: Int? = null,
    val counted_at: Long? = null,
    val left_out: Boolean = false,
    val expected: Int? = null,
    val diff: Int? = null,
    val unit_cost: Double? = null,
    val server_seq: Long? = null,
)

// reason: sale, refund, receive, count, adjust, damaged, expired, lost,
// internal, supplier_return, found, opening. ref_id is the delivery or the
// count it belongs to; receipt_id the sale.
@Entity(tableName = "stock_movements", indices = [Index("store_id", "created_at"), Index("item_id")])
data class StockMovementEntity(
    @PrimaryKey val id: String,
    val store_id: String,
    val item_id: String,
    val variant_id: String = "",
    val qty: Int,
    val reason: String,
    val unit_cost: Double? = null,
    val ref_type: String? = null,
    val ref_id: String? = null,
    val receipt_id: String? = null,
    val employee_id: String? = null,
    val note: String? = null,
    val created_at: Long = 0,
    val server_seq: Long? = null,
)

// An order or a delivery being typed that has not been sent: one of each
// (kind: "order", "delivery"), as text, so that closing the app or losing the
// connection in the middle of a long delivery costs nothing.
@Entity(tableName = "stock_drafts")
data class StockDraftEntity(
    @PrimaryKey val kind: String,
    val body: String,
    val updated_at: Long,
)

// How many live products name a supplier.
data class SupplierUse(val supplier_id: String, val n: Int)

// Something's id and what it is called: a member of staff, a receipt's number.
data class IdName(val id: String, val name: String)

@Dao
interface StockDao {
    @Upsert suspend fun upsertSuppliers(rows: List<SupplierEntity>)
    @Upsert suspend fun upsertOrders(rows: List<PurchaseOrderEntity>)
    @Upsert suspend fun upsertOrderLines(rows: List<PurchaseOrderLineEntity>)
    @Upsert suspend fun upsertDeliveries(rows: List<DeliveryEntity>)
    @Upsert suspend fun upsertDeliveryLines(rows: List<DeliveryLineEntity>)
    @Upsert suspend fun upsertCounts(rows: List<StockCountEntity>)
    @Upsert suspend fun upsertCountLines(rows: List<StockCountLineEntity>)
    @Upsert suspend fun upsertMovements(rows: List<StockMovementEntity>)

    @Query("DELETE FROM purchase_order_lines WHERE order_id = :order") suspend fun dropOrderLines(order: String)
    @Query("DELETE FROM delivery_lines WHERE delivery_id = :delivery") suspend fun dropDeliveryLines(delivery: String)

    // A document arrives whole: its lines are the ones given, not those and the ones before.
    @Transaction
    suspend fun replaceOrderLines(order: String, rows: List<PurchaseOrderLineEntity>) {
        dropOrderLines(order)
        upsertOrderLines(rows)
    }

    @Transaction
    suspend fun replaceDeliveryLines(delivery: String, rows: List<DeliveryLineEntity>) {
        dropDeliveryLines(delivery)
        upsertDeliveryLines(rows)
    }

    @Query("SELECT * FROM suppliers WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE")
    fun suppliers(): Flow<List<SupplierEntity>>

    // removed ones too: an old order still names its supplier
    @Query("SELECT * FROM suppliers") fun everySupplier(): Flow<List<SupplierEntity>>

    @Query("SELECT * FROM suppliers WHERE id = :id") suspend fun supplier(id: String): SupplierEntity?

    @Query("SELECT supplier_id, COUNT(*) AS n FROM items WHERE supplier_id IS NOT NULL AND deleted_at IS NULL GROUP BY supplier_id")
    fun supplierUse(): Flow<List<SupplierUse>>

    @Query("SELECT * FROM purchase_orders WHERE store_id = :store AND deleted_at IS NULL ORDER BY created_at DESC, number DESC")
    fun orders(store: String): Flow<List<PurchaseOrderEntity>>

    @Query("SELECT * FROM purchase_orders WHERE id = :id") suspend fun order(id: String): PurchaseOrderEntity?
    @Query("SELECT * FROM purchase_order_lines WHERE order_id = :order") suspend fun orderLines(order: String): List<PurchaseOrderLineEntity>
    @Query("SELECT * FROM purchase_order_lines") fun everyOrderLine(): Flow<List<PurchaseOrderLineEntity>>

    @Query("SELECT * FROM deliveries WHERE store_id = :store ORDER BY created_at DESC, number DESC")
    fun deliveries(store: String): Flow<List<DeliveryEntity>>

    @Query("SELECT * FROM deliveries WHERE id = :id") suspend fun delivery(id: String): DeliveryEntity?
    @Query("SELECT * FROM delivery_lines WHERE delivery_id = :delivery") suspend fun deliveryLines(delivery: String): List<DeliveryLineEntity>
    @Query("SELECT * FROM delivery_lines") fun everyDeliveryLine(): Flow<List<DeliveryLineEntity>>

    @Query("SELECT * FROM stock_counts WHERE store_id = :store ORDER BY created_at DESC")
    fun counts(store: String): Flow<List<StockCountEntity>>

    @Query("SELECT * FROM stock_counts WHERE id = :id") suspend fun count(id: String): StockCountEntity?
    @Query("SELECT * FROM stock_count_lines WHERE count_id = :count") fun countLines(count: String): Flow<List<StockCountLineEntity>>
    @Query("SELECT * FROM stock_count_lines WHERE count_id = :count") suspend fun countLinesNow(count: String): List<StockCountLineEntity>

    // The count this tablet started and has not completed: it has not been to the server.
    @Query("SELECT * FROM stock_counts WHERE store_id = :store AND status = 'open' AND server_seq IS NULL LIMIT 1")
    suspend fun openOwnCount(store: String): StockCountEntity?

    @Query("SELECT * FROM stock_counts WHERE store_id = :store AND status = 'open' AND server_seq IS NULL LIMIT 1")
    fun openOwnCountFlow(store: String): Flow<StockCountEntity?>

    // The lines the tablet itself wrote for a count: the server's take their place when the count comes back.
    @Query("DELETE FROM stock_count_lines WHERE count_id = :count AND server_seq IS NULL") suspend fun dropOwnCountLines(count: String)

    @Query("DELETE FROM stock_counts WHERE id = :id") suspend fun dropCount(id: String)
    @Query("DELETE FROM stock_count_lines WHERE count_id = :count") suspend fun dropCountLines(count: String)
    @Query("DELETE FROM stock_count_lines WHERE count_id = :count AND item_id = :item AND variant_id = :variant")
    suspend fun dropCountLine(count: String, item: String, variant: String)

    @Query("SELECT * FROM stock_movements WHERE store_id = :store ORDER BY created_at DESC, server_seq DESC LIMIT :limit")
    fun movements(store: String, limit: Int): Flow<List<StockMovementEntity>>

    // What a movement or a line of a document is named by. Removed products
    // and variants too: an old movement still says what it moved.
    @Query("SELECT * FROM items") fun everyItem(): Flow<List<ItemEntity>>
    @Query("SELECT * FROM item_variants") fun everyVariant(): Flow<List<ItemVariantEntity>>
    @Query("SELECT id, name FROM employees") fun staffNames(): Flow<List<IdName>>
    @Query("SELECT id, number AS name FROM receipts") fun receiptNumbers(): Flow<List<IdName>>

    @Query("SELECT * FROM stock_drafts WHERE kind = :kind") suspend fun draft(kind: String): StockDraftEntity?
    @Upsert suspend fun saveDraft(row: StockDraftEntity)
    @Query("DELETE FROM stock_drafts WHERE kind = :kind") suspend fun dropDraft(kind: String)
    @Query("SELECT kind FROM stock_drafts") fun draftKinds(): Flow<List<String>>

    // What the server sent, for when it says its history was rewritten and
    // everything is read again. The tablet's own count (it has no server_seq)
    // and its drafts are not the server's, and stay.
    @Query("DELETE FROM suppliers") suspend fun clearSuppliers()
    @Query("DELETE FROM purchase_orders") suspend fun clearOrders()
    @Query("DELETE FROM purchase_order_lines") suspend fun clearOrderLines()
    @Query("DELETE FROM deliveries") suspend fun clearDeliveries()
    @Query("DELETE FROM delivery_lines") suspend fun clearDeliveryLines()
    @Query("DELETE FROM stock_count_lines WHERE count_id IN (SELECT id FROM stock_counts WHERE server_seq IS NOT NULL)")
    suspend fun clearCountLines()
    @Query("DELETE FROM stock_counts WHERE server_seq IS NOT NULL") suspend fun clearCounts()
    @Query("DELETE FROM stock_movements") suspend fun clearMovements()

    @Transaction
    suspend fun clearFromServer() {
        clearSuppliers(); clearOrderLines(); clearOrders(); clearDeliveryLines(); clearDeliveries()
        clearCountLines(); clearCounts(); clearMovements()
    }
}

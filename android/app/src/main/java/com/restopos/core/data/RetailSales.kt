package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Money
import com.restopos.core.common.Uuid7
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.TicketLineEntity
import com.restopos.core.database.TicketLineTaxEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

// What a code that was scanned or typed whole turned out to be.
sealed class Found {
    data class Product(val item: ItemEntity, val variant: ItemVariantEntity?) : Found()
    // a product that comes in several variants, scanned by its own code: which one has to be picked
    data class Pick(val item: ItemEntity) : Found()
    // two things carry this code (the server refuses that, so it is an old tablet's leftover)
    data class Several(val code: String) : Found()
    data class Nothing(val code: String) : Found()
}

// A line's price, changed or put back.
sealed class PriceEdit {
    data class To(val change: LinePrice.Change) : PriceEdit()
    object Back : PriceEdit()
}

// The stock mirror moves with what this till sells and takes back: `by` is in
// thousandths, negative for a sale. Only what is counted in stock has a
// figure (the product's own switch, or its category's). The server's figure
// replaces this one at every sync.
suspend fun TillDatabase.moveStock(store: String, lines: List<Pair<TicketLineEntity, Int>>) {
    lines.forEach { (l, by) ->
        val itemId = l.item_id ?: return@forEach
        val item = catalog().item(itemId) ?: return@forEach
        if (!item.track_stock && ops().categoryOfItem(itemId)?.is_stock != true) return@forEach
        val variant = l.variant_id ?: ""
        if (retail().moveLevel(store, itemId, variant, by) == 0) retail().upsertLevels(listOf(StockLevelEntity(store, itemId, variant, by)))
    }
}

// What a shop's sell screen does to a sale. A sale is an order of the kind
// "counter", so it is paid on the payment screen that exists, parks under the
// orders that are open, and is refunded like any receipt. What is different
// from a restaurant's order: a line can be one variant of a product, can be a
// weight, can carry a price of its own, and is changed in place (one
// operation, ticket.edit_line) because no kitchen ever holds it.
// Like every write on the till: the row and its outbox op in one transaction.
@Singleton
class RetailSales @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val tickets: TicketRepository,
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    // The sale on the screen is a counter order. One left from before that is
    // of another kind (a table's, a takeaway's: a tablet that was a
    // restaurant's) is set aside, and a new sale starts with the first product.
    suspend fun open() {
        val t = tickets.activeTicket()
        val kind = t?.dining_option_id?.let { db.ops().dining(it)?.kind } ?: if (t?.table_id != null) "dine" else "counter"
        if (t == null || kind != "counter") tickets.startOrder(tickets.counterTypeId())
    }

    // A whole code: a variant's barcode or SKU first, then a product's.
    suspend fun find(raw: String): Found {
        val code = raw.trim()
        if (code.isEmpty()) return Found.Nothing(code)
        val variants = db.retail().variantsByCode(code)
        if (variants.size > 1) return Found.Several(code)
        variants.firstOrNull()?.let { v ->
            val item = db.catalog().item(v.item_id)?.takeIf { it.deleted_at == null } ?: return Found.Nothing(code)
            return Found.Product(item, v)
        }
        val items = db.retail().itemsByCode(code)
        if (items.size > 1) return Found.Several(code)
        val item = items.firstOrNull() ?: return Found.Nothing(code)
        return if (db.retail().variantsOf(item.id).isEmpty()) Found.Product(item, null) else Found.Pick(item)
    }

    fun nameOf(item: ItemEntity, variant: ItemVariantEntity?): String = if (variant == null) item.name else "${item.name}, ${variant.name}"

    // Rings a product up: one more on the line it is already on, or a new
    // line. qty is in thousandths (1000 is one; a weight is its grams). What
    // is weighed is always a line of its own: two weighings are two packets.
    // price: what was typed for a product whose price is typed at the sale.
    // It is the line's price, and that too is a line of its own each time.
    // Returns the line it is on.
    suspend fun add(item: ItemEntity, variant: ItemVariantEntity?, qty: Int = 1000, price: Long? = null): Result<String> = runCatching {
        require(qty > 0) { "Type how many" }
        require(item.is_available) { "${item.name} is not on sale" }
        require(variant != null || db.retail().variantsOf(item.id).isEmpty()) { "Pick which ${item.name}" }
        open()
        val t = tickets.ensureTicket()
        val tenant = session.tenantId() ?: error("no tenant")
        val unit = price ?: variant?.price ?: item.price
        val weighed = item.sold_by == "weight"
        if (!weighed) {
            db.tickets().lines(t.id).first().firstOrNull { LinePrice.sameLine(it, item.id, variant?.id, unit, typed = price != null) }?.let { same ->
                edit(same.id, qty = same.qty + qty).getOrThrow()
                return@runCatching same.id
            }
        }
        val lineId = Uuid7.next()
        val name = nameOf(item, variant)
        val taxes = db.catalog().taxesForItem(item.id)
        db.withTransaction {
            db.tickets().upsertLines(listOf(TicketLineEntity(lineId, tenant, t.id, item.id, variant?.id, name, unit, qty)))
            db.catalog().upsertLineTaxes(taxes.map { TicketLineTaxEntity(lineId, it.id, it.rate_bp, it.type) })
            db.outbox().enqueue(op("ticket.add_line", buildJsonObject {
                put("id", lineId); put("ticket_id", t.id); put("item_id", item.id)
                variant?.let { put("variant_id", it.id) }
                put("qty", qty); put("unit_price", unit); put("name_snapshot", name)
            }))
        }
        pushNow(context)
        lineId
    }

    // Changes a line in place: how many, its note ("" takes it off), its
    // price. A discount needs someone allowed to discount, a changed price
    // someone allowed to change one: the person at the till, or whoever
    // approves, who is then named on the line.
    suspend fun edit(lineId: String, qty: Int? = null, note: String? = null, price: PriceEdit? = null, approver: StaffMember? = null): Result<Unit> = runCatching {
        val l = db.tickets().line(lineId) ?: error("That line is gone")
        require(!l.paid && l.voided_at == null && l.sent_to_kitchen_at == null) { "That line can no longer be changed" }
        require(qty == null || qty > 0) { "Type how many" }
        var next = l.copy(qty = qty ?: l.qty, note = if (note == null) l.note else note.trim().ifEmpty { null })
        var by: String? = null
        when (price) {
            is PriceEdit.To -> {
                val c = price.change
                val permission = if (c.kind == "discount") "sale.apply_discount" else "sale.change_price"
                staff.allow(permission, if (c.kind == "discount") "give a discount" else "change a price", approver)
                by = staff.approvedBy(permission, approver)
                next = next.copy(unit_price = c.unit, list_price = c.list, price_kind = c.kind, price_label = c.label, price_by = by ?: staff.id())
            }
            // back to what it was listed at: the line says nothing about its price any more
            PriceEdit.Back -> next = next.copy(unit_price = l.list_price ?: l.unit_price, list_price = null, price_kind = null, price_label = null, price_by = null)
            null -> {}
        }
        if (next == l) return@runCatching
        db.withTransaction {
            db.tickets().upsertLines(listOf(next))
            db.outbox().enqueue(op("ticket.edit_line", buildJsonObject {
                put("line_id", lineId)
                if (qty != null) put("qty", next.qty)
                if (note != null) put("note", next.note ?: "")
                if (price != null) {
                    put("unit_price", next.unit_price)
                    if (next.price_kind == null) { put("list_price", JsonNull); put("price_kind", JsonNull); put("price_label", JsonNull) }
                    else { put("list_price", next.list_price); put("price_kind", next.price_kind); put("price_label", next.price_label ?: "") }
                    by?.let { put("approved_by", it) }
                }
            }))
        }
        pushNow(context)
    }

    // What a discount or a price change did to the lines of a sale, in all.
    fun saved(lines: List<TicketLineEntity>): Long = lines.filter { it.voided_at == null }.sumOf { LinePrice.saved(it.list_price, it.unit_price, it.qty) }

    fun money(cents: Long) = Money.format(cents)
}

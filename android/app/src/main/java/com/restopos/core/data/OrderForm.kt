package com.restopos.core.data

import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.PurchaseOrderEntity
import com.restopos.core.database.PurchaseOrderLineEntity
import com.restopos.core.database.StockLevelEntity
import kotlin.math.max
import kotlin.math.roundToLong

// The words for a refusal that is about one line of an order, a delivery or a
// count: the product has to be put right or taken off before it is sent again.
internal fun lineRefused(code: String?): String? = when (code) {
    "unknown-item" -> "A product on it is no longer there. Take it off and try again."
    "not-counted" -> "The stock of a product on it is not counted. Take it off, or switch on \"Count its stock\" for it."
    "pick-variant" -> "A product on it comes in variants. Take it off and add the variant that is meant."
    "unknown-line" -> "A variant on it is no longer there. Take it off and try again."
    "bad-line" -> "A line has no quantity, or no cost. Check each line."
    else -> null
}

// An order to a supplier as the till writes it: who it is for, when it is
// expected, a note, and its lines. The id is made when the order is begun, so
// that sending it twice is one order (server 0092, po_save_as).
object OrderForm {
    data class Order(val id: String, val supplier: String? = null, val expectedOn: String = "", val note: String = "", val lines: List<DocLines.Line> = emptyList())

    // What a line starts at: what the product last cost. A variant's own
    // cost, else the product's, else what the shelf cost on average.
    fun startCost(item: ItemEntity, variant: ItemVariantEntity?, level: StockLevelEntity?): Long =
        variant?.cost ?: item.cost ?: level?.avg_cost?.takeIf { it > 0 }?.roundToLong() ?: 0L

    // Why it cannot be saved (or, toSend, sent) yet, or null.
    fun problem(o: Order, toSend: Boolean): String? = when {
        o.supplier == null -> "Pick the supplier."
        toSend && o.lines.none { it.qty > 0 } -> "Add at least one product."
        else -> null
    }

    // The server's refusal of po.save, po.send, po.cancel or po.close, in words.
    fun refused(code: String?): String = lineRefused(code) ?: when (code) {
        "unknown-supplier" -> "That supplier is no longer there. Pick another."
        "unknown-store" -> "This till's store is no longer there. Set the till up again."
        "unknown-order" -> "That order is no longer there."
        "not-draft" -> "This order was already sent: it can no longer be changed."
        "no-lines" -> "An order with nothing on it cannot be sent. Add at least one product."
        "already-received" -> "Something has arrived for this order. It can be closed, not cancelled."
        "not-open" -> "This order is not waiting any more."
        "not-part" -> "Only an order that part of has arrived can be closed."
        "forbidden" -> "You are not allowed to order from suppliers. Ask a manager."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before orders can be written on a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }
}

// "Add what is low": the supplier's lines of stock at or below the level to
// order them again at, that are not on the draft yet. The rule is the
// server's (po_fill_low, migration 0074), worked out here from what the
// tablet holds so that it needs no connection: how much is the line's order
// quantity when it has one, else what brings it back to its level and never
// less than one unit; the cost is what the shelf cost on average.
object PoFill {
    fun low(
        supplier: String, on: List<DocLines.Line>, items: List<ItemEntity>, variants: List<ItemVariantEntity>,
        levels: List<StockLevelEntity>, counted: (ItemEntity) -> Boolean,
    ): List<DocLines.Line> {
        val live = variants.filter { it.deleted_at == null }.groupBy { it.item_id }
        val held = levels.associateBy { it.item_id to it.variant_id }
        val there = on.map { it.item to it.variant }.toSet()
        return items.filter { it.deleted_at == null && it.supplier_id == supplier && counted(it) }.flatMap { item ->
            // a line of stock is the product itself, or each of its variants
            val lines = live[item.id]?.map { it.id } ?: listOf("")
            lines.mapNotNull { variant ->
                val level = held[item.id to variant] ?: return@mapNotNull null
                val point = level.reorder_point ?: return@mapNotNull null
                if (level.qty > point || (item.id to variant) in there) return@mapNotNull null
                val qty = level.reorder_qty?.takeIf { it != 0 } ?: max(point - level.qty, 1000)
                DocLines.Line(item.id, variant, qty, max(level.avg_cost.roundToLong(), 0L))
            }
        }
    }
}

// A delivery as the till receives it: against an order or not, from a
// supplier or not, the day, the invoice's number, a note, and what arrived.
// The id is made when it is begun: the same delivery sent twice is written
// once (delivery_receive, migration 0074).
object DeliveryForm {
    data class Delivery(
        val id: String, val order: String? = null, val supplier: String? = null, val arrivedOn: String,
        val invoice: String = "", val note: String = "", val lines: List<DocLines.Line> = emptyList(),
    )

    // A delivery for an order that is waiting: each line what is still due of it, at the order's cost.
    fun fromOrder(id: String, order: PurchaseOrderEntity, lines: List<PurchaseOrderLineEntity>, today: String): Delivery =
        Delivery(id, order.id, order.supplier_id, today, lines = lines.filter { it.qty > it.received }.map { DocLines.Line(it.item_id, it.variant_id, it.qty - it.received, it.unit_cost) })

    fun problem(d: Delivery): String? = if (d.lines.none { it.qty > 0 }) "Nothing has been received yet." else null

    // The server's refusal of delivery.receive, in words.
    fun refused(code: String?): String = lineRefused(code) ?: when (code) {
        "nothing-received" -> "Nothing has been received yet."
        "not-open" -> "This order is not waiting any more: receive this without an order."
        "unknown-order" -> "That order is no longer there: receive this without an order."
        "unknown-supplier" -> "That supplier is no longer there. Pick another, or none."
        "unknown-store" -> "This till's store is no longer there. Set the till up again."
        "bad-delivery" -> "That did not work. Close this and try again."
        "forbidden" -> "You are not allowed to receive deliveries. Ask a manager."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before deliveries can be received on a till."
        null -> "The server refused it."
        else -> "The server refused it ($code)."
    }

    // How many labels each line gets when what arrived is labelled: one a
    // whole unit and at least one, one for a line sold by weight (not one a
    // gram), and never more than one run prints of one product.
    // soldBy: how a product is sold, "each" or "weight".
    fun labels(lines: List<DocLines.Line>, soldBy: (String) -> String): List<Pair<DocLines.Line, Int>> =
        lines.filter { it.qty > 0 }.map { l ->
            l to if (soldBy(l.item) == "weight") 1 else (l.qty / 1000).coerceIn(1, LabelList.MOST_EACH)
        }
}

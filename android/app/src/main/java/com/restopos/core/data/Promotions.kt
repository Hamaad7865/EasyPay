package com.restopos.core.data

import android.content.Context
import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import com.restopos.core.database.OutboxEntity
import com.restopos.core.database.PromotionEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.database.TillLogEntity
import com.restopos.core.sync.SessionStore
import com.restopos.core.sync.pushNow
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import javax.inject.Inject
import javax.inject.Singleton

// One line a promotion can be on: a product, or one of its variants.
data class PromoLine(val item: ItemEntity, val variant: ItemVariantEntity?, val qty: Int, val promotion: PromotionEntity?) {
    val variantId: String get() = variant?.id ?: ""
    val price: Long get() = variant?.price ?: item.price
    val cost: Long? get() = variant?.cost ?: item.cost
    val was: Long? get() = variant?.promo_was ?: item.promo_was
}

// A shop's promotions on this tablet (server 0110): a line marked down, never
// below its cost, with the price before it kept on the line; reduced again;
// lifted. Each is written here at once, as a price change is, and queued for
// the server, which answers with the same rules; a tablet that works on its
// own keeps the queue. The two detections read this tablet's own tables: its
// stock levels, and the sales it holds receipts for.
@Singleton
class Promotions @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    @ApplicationContext private val context: Context,
) {
    private fun op(type: String, payload: JsonObject) = OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())

    private suspend fun line(itemId: String, variantId: String?): PromoLine {
        val item = db.catalog().item(itemId)?.takeIf { it.deleted_at == null } ?: error("That product is gone")
        val variant = variantId?.takeIf { it.isNotEmpty() }?.let { db.retail().variant(it)?.takeIf { v -> v.item_id == itemId && v.deleted_at == null } ?: error("That size or colour is gone") }
        if (variant == null && db.retail().variantsOf(itemId).isNotEmpty()) error("A product with variants is put on promotion by the variant")
        val store = session.storeId() ?: error("no store")
        val qty = db.retail().levelsOf(store, itemId).firstOrNull { it.variant_id == (variant?.id ?: "") }?.qty ?: 0
        return PromoLine(item, variant, qty, db.promotions().activeFor(itemId, variant?.id ?: ""))
    }

    private suspend fun setPrice(l: PromoLine, price: Long, was: Long?) {
        if (l.variant != null) db.promotions().setVariantPromo(l.variant.id, price, was) else db.promotions().setItemPromo(l.item.id, price, was)
    }

    private suspend fun log(l: PromoLine, from: Long, to: Long, approver: StaffMember?) {
        db.log().add(TillLogEntity(Uuid7.next(), System.currentTimeMillis(), "price", staff.id(), staff.approvedBy("items.edit", approver), item_id = l.item.id, variant_id = l.variant?.id, was = from.toString(), became = to.toString()))
    }

    suspend fun apply(itemId: String, variantId: String?, price: Long, note: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "put a product on promotion", approver)
        val l = line(itemId, variantId)
        require(l.promotion == null) { "It is already on promotion. Reduce it again, or lift it first." }
        PromotionRules.check(l.cost, l.price, price)?.let { error(it) }
        val tenant = session.tenantId() ?: error("no tenant")
        val id = Uuid7.next()
        val said = note.trim().take(120).ifEmpty { null }
        db.withTransaction {
            db.promotions().upsert(listOf(PromotionEntity(id, tenant, itemId, l.variantId, l.price, price, "active", said, staff.id())))
            setPrice(l, price, l.price)
            log(l, l.price, price, approver)
            db.outbox().enqueue(op("promotion.apply", buildJsonObject {
                put("id", id); put("item_id", itemId); l.variant?.let { put("variant_id", it.id) }; put("price", price); said?.let { put("note", it) }
                staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
    }

    suspend fun reduce(itemId: String, variantId: String?, price: Long, note: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("items.edit", "reduce a promotion", approver)
        val l = line(itemId, variantId)
        val p = l.promotion ?: error("It is not on promotion")
        PromotionRules.reduceCheck(l.cost, p.promo_price, price)?.let { error(it) }
        val said = note.trim().take(120).ifEmpty { null }
        db.withTransaction {
            db.promotions().reduce(p.id, price, said)
            setPrice(l, price, p.original_price)
            log(l, l.price, price, approver)
            db.outbox().enqueue(op("promotion.reduce", buildJsonObject {
                put("item_id", itemId); l.variant?.let { put("variant_id", it.id) }; put("price", price); said?.let { put("note", it) }
                staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
    }

    // true when the price was put back; false when it was left, having been changed by hand since
    suspend fun lift(promotionId: String, approver: StaffMember? = null): Result<Boolean> = runCatching {
        staff.allow("items.edit", "lift a promotion", approver)
        val p = db.promotions().promotion(promotionId)?.takeIf { it.status == "active" } ?: error("That promotion is not running")
        val l = line(p.item_id, p.variant_id.ifEmpty { null })
        val restore = l.price == p.promo_price
        db.withTransaction {
            db.promotions().lift(p.id)
            setPrice(l, if (restore) p.original_price else l.price, null)
            if (restore) log(l, l.price, p.original_price, approver)
            db.outbox().enqueue(op("promotion.lift", buildJsonObject {
                put("id", p.id); put("item_id", p.item_id); if (p.variant_id.isNotEmpty()) put("variant_id", p.variant_id)
                staff.approvedBy("items.edit", approver)?.let { put("approved_by", it) }
            }))
        }
        pushNow(context)
        restore
    }

    // Every line of the shop's catalogue with what this tablet knows of it:
    // what is left (this store), when it last sold here, since when it has
    // been idle (its first stock in, when it never sold: the tablet does not
    // know when a product was made), and its live promotion.
    suspend fun lines(): List<Pair<PromoLine, PromotionRules.Line>> {
        val store = session.storeId() ?: return emptyList()
        val items = db.retail().products(null, "").first().filter { it.is_available && !it.open_price && it.sold_by != "weight" }
        val variants = db.retail().variants().first().groupBy { it.item_id }
        val levels = db.retail().levels(store).first().associateBy { it.item_id to it.variant_id }
        val sold = db.promotions().lastSales().associate { (it.item_id to it.variant_id) to it.at }
        val firstIn = db.promotions().firstIn().associate { (it.item_id to it.variant_id) to it.at }
        val live = db.promotions().activeNow().associateBy { it.item_id to it.variant_id }
        val now = System.currentTimeMillis()
        // a line with no stock movement of its own (stock that came with the
        // set-up, say) is idle since the earliest movement or sale the tablet
        // knows of at all: the shop's start, as far as this tablet can tell;
        // and from now, flagged never, when it knows of none
        val earliest = (firstIn.values + sold.values).minOrNull() ?: now
        return items.flatMap { i ->
            val vs = variants[i.id].orEmpty()
            (if (vs.isEmpty()) listOf<ItemVariantEntity?>(null) else vs).map { v ->
                val key = i.id to (v?.id ?: "")
                val p = live[key]
                val l = PromoLine(i, v, levels[key]?.qty ?: 0, p)
                l to PromotionRules.Line(i.id, v?.id ?: "", l.qty, firstIn[key] ?: earliest, sold[key], p != null, p?.applied_at)
            }
        }
    }
}

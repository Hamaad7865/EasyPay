package com.restopos.core.data

import androidx.room.withTransaction
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.StockCountEntity
import com.restopos.core.database.StockCountLineEntity
import com.restopos.core.database.StockDraftEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.flow.first
import javax.inject.Inject
import javax.inject.Singleton

// A shop's stock work done from the till (server 0092): its suppliers here;
// orders, deliveries and counts as their screens arrive. Every save is asked
// of the server now and waited for, through the one place such a change
// leaves the tablet (ServiceRepository.ask), and a sync brings the rows. The
// ids are the caller's, made when its form opened, so a second try after a
// lost answer sends the same ones and the server writes nothing twice.
@Singleton
class StockRepository @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
    private val service: ServiceRepository,
    private val api: com.restopos.core.network.ApiClient,
    @dagger.hilt.android.qualifiers.ApplicationContext private val context: android.content.Context,
) {
    suspend fun saveSupplier(id: String, s: SupplierForm.Supplier, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("suppliers.edit", "change suppliers", approver)
        val kept = SupplierForm.clean(s)
        SupplierForm.problem(kept)?.let { error(it) }
        service.ask("supplier.save", SupplierForm::refused, StockPayloads.supplierSave(id, kept, staff.approvedBy("suppliers.edit", approver)))
    }

    // Marked removed on the server: it stays on its old orders.
    suspend fun removeSupplier(id: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("suppliers.edit", "change suppliers", approver)
        service.ask("supplier.remove", SupplierForm::refused, StockPayloads.supplierRemove(id, staff.approvedBy("suppliers.edit", approver)))
    }

    // ---- an order or a delivery being typed ----
    // Kept on the tablet at every change and dropped when its save is answered
    // done: closing the app or losing the connection in the middle costs
    // nothing. One of each. Signing the tablet out empties its database, and
    // these with it.
    suspend fun orderDraft(): OrderForm.Order? = StockDrafts.order(db.stock().draft(ORDER)?.body)
    suspend fun keepOrderDraft(o: OrderForm.Order) = db.stock().saveDraft(StockDraftEntity(ORDER, StockDrafts.write(o), System.currentTimeMillis()))
    suspend fun dropOrderDraft() = db.stock().dropDraft(ORDER)
    suspend fun deliveryDraft(): DeliveryForm.Delivery? = StockDrafts.delivery(db.stock().draft(DELIVERY)?.body)
    suspend fun keepDeliveryDraft(d: DeliveryForm.Delivery) = db.stock().saveDraft(StockDraftEntity(DELIVERY, StockDrafts.write(d), System.currentTimeMillis()))
    suspend fun dropDeliveryDraft() = db.stock().dropDraft(DELIVERY)

    private suspend fun store() = session.storeId() ?: error("This till is not set up for a store yet.")

    // ---- orders to suppliers ----
    // A draft, new or saved again: its lines are the ones given.
    suspend fun saveOrder(o: OrderForm.Order, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow(RECEIVE, "order from suppliers", approver)
        OrderForm.problem(o, toSend = false)?.let { error(it) }
        service.ask("po.save", OrderForm::refused, StockPayloads.poSave(o, store(), staff.approvedBy(RECEIVE, approver)))
    }

    private suspend fun state(type: String, id: String, approver: StaffMember?) {
        staff.allow(RECEIVE, "order from suppliers", approver)
        service.ask(type, OrderForm::refused, StockPayloads.poState(id, staff.approvedBy(RECEIVE, approver)))
    }
    suspend fun sendOrder(id: String, approver: StaffMember? = null): Result<Unit> = runCatching { state("po.send", id, approver) }
    // While nothing has arrived for it.
    suspend fun cancelOrder(id: String, approver: StaffMember? = null): Result<Unit> = runCatching { state("po.cancel", id, approver) }
    // The rest of a part-received order will not come.
    suspend fun closeOrder(id: String, approver: StaffMember? = null): Result<Unit> = runCatching { state("po.close", id, approver) }

    // Send is save, then send. A second tap of Send after its answer was lost
    // finds the order sent already, and the save is refused as "no longer a
    // draft": here that means the first tap got through, so the send is asked
    // again and answers done. SavedNotSent: it is a draft on the server now,
    // and did not go out; the screen says so and keeps nothing of its own.
    class SavedNotSent(message: String) : Exception(message)
    suspend fun saveAndSend(o: OrderForm.Order, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow(RECEIVE, "order from suppliers", approver)
        OrderForm.problem(o, toSend = true)?.let { error(it) }
        val by = staff.approvedBy(RECEIVE, approver)
        var late = false
        try {
            service.ask("po.save", { code -> if (code == "not-draft") late = true; OrderForm.refused(code) }, StockPayloads.poSave(o, store(), by))
        } catch (e: Exception) {
            if (!late) throw e
        }
        try {
            service.ask("po.send", OrderForm::refused, StockPayloads.poState(o.id, by))
        } catch (e: Exception) {
            // it is a draft on the server now: say so, with why it did not go out
            if (late) throw e
            throw SavedNotSent("The order is saved as a draft, but it was not sent: ${e.message}")
        }
    }

    // ---- what arrives ----
    // Written once and never changed: the stock goes up and each product costs what was paid.
    suspend fun receive(d: DeliveryForm.Delivery, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow(RECEIVE, "receive a delivery", approver)
        DeliveryForm.problem(d)?.let { error(it) }
        service.ask("delivery.receive", DeliveryForm::refused, StockPayloads.deliveryReceive(d, store(), staff.approvedBy(RECEIVE, approver)))
    }

    // ---- a count of the shelves ----
    // Kept on this tablet from the moment it is begun, with no number and no
    // row on any server, until it is completed as one change: a count takes
    // an afternoon, and nothing of it may depend on a connection. Every tap
    // and every typed figure is written at once (CountBook says what each
    // does), with what the tablet holds of the line at that moment.
    suspend fun ownCount(): StockCountEntity? = db.stock().openOwnCount(store())
    private fun line(e: StockCountLineEntity) = CountBook.Line(e.item_id, e.variant_id, e.counted, e.counted_at, e.expected, e.left_out)
    private suspend fun counts(item: ItemEntity): Boolean = item.track_stock || item.category_id?.let { c -> db.alone().category(c)?.is_stock } == true

    // Begins one: of the whole shop ("all"), a category or a supplier (scopeId), or a brand. Returns its id.
    suspend fun startCount(kind: String, scopeId: String?, brand: String?, approver: StaffMember? = null): Result<String> = runCatching {
        staff.allow(COUNT, "count stock", approver)
        val at = store()
        if (db.stock().openOwnCount(at) != null) error("A count is already open on this tablet. Carry on with it, or throw it away first.")
        val items = db.stock().everyItem().first()
        val counted = items.filter { counts(it) }.map { it.id }.toSet()
        val lines = CountBook.scope(kind, scopeId, brand, items, { it.id in counted }, db.stock().everyVariant().first())
        if (lines.isEmpty()) error("There is nothing to count there: no product of it has its stock counted.")
        val title = CountBook.title(kind, scopeId?.let { db.alone().category(it)?.name }, scopeId?.let { db.stock().supplier(it)?.name }, brand) ?: error("Pick what to count.")
        val id = com.restopos.core.common.Uuid7.next()
        db.withTransaction {
            db.stock().upsertCounts(listOf(StockCountEntity(
                id, at, null, kind, if (kind == "category" || kind == "supplier") scopeId else null, if (kind == "brand") title else null,
                title, "open", started_by = staff.id(), created_at = System.currentTimeMillis(),
            )))
            db.stock().upsertCountLines(lines.map { StockCountLineEntity(id, it.item, it.variant) })
        }
        id
    }

    // One line changed and written back, with what the tablet holds of it now.
    private suspend fun change(count: String, s: CountBook.Stock, how: (List<CountBook.Line>, Int) -> List<CountBook.Line>) = db.withTransaction {
        val held = db.retail().levelsOf(store(), s.item).firstOrNull { it.variant_id == s.variant }?.qty ?: 0
        val next = how(db.stock().countLinesNow(count).map(::line), held).firstOrNull { it.item == s.item && it.variant == s.variant } ?: return@withTransaction
        db.stock().upsertCountLines(listOf(StockCountLineEntity(count, next.item, next.variant, next.counted, next.countedAt, next.leftOut, expected = next.expected)))
    }
    // a scan or a tap: `by` more of it
    suspend fun counted(count: String, s: CountBook.Stock, by: Int) = change(count, s) { lines, held -> CountBook.add(lines, s, by, System.currentTimeMillis(), held) }
    // a figure typed for it
    suspend fun typed(count: String, s: CountBook.Stock, units: Int) = change(count, s) { lines, held -> CountBook.set(lines, s, units, System.currentTimeMillis(), held) }
    suspend fun uncount(count: String, s: CountBook.Stock) = change(count, s) { lines, _ -> CountBook.clear(lines, s) }
    suspend fun leaveOut(count: String, s: CountBook.Stock, out: Boolean) = change(count, s) { lines, _ -> CountBook.leaveOut(lines, s, out) }
    // thrown away: it was never anywhere but here
    suspend fun dropCount(count: String) = db.withTransaction { db.stock().dropCountLines(count); db.stock().dropCount(count) }

    // Completed as one change, with exactly its lines. uncounted: "leave" what
    // nobody counted as it is, or set it to "zero".
    suspend fun completeCount(count: String, uncounted: String, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow(COUNT, "count stock", approver)
        val c = db.stock().count(count) ?: error("That count is no longer on this tablet.")
        val lines = db.stock().countLinesNow(count).map(::line)
        val alone = PosSettings.parse(db.ops().settings()).alone
        var ahead = 0L
        if (!alone) {
            // A linked till: the server works the count out with every till's
            // sales, so what this one still holds goes up first; and it sets
            // the tablet's moments right by how far the tablet's clock is
            // from its own, which has to have been measured, not assumed.
            if (db.outbox().pendingCount() > 0) {
                com.restopos.core.sync.pushNow(context)
                error("The sales this till is holding have to go up first. Complete the count in a moment, with the tablet online.")
            }
            runCatching { api.latestTill() }
            ahead = api.clockAhead.value ?: error("This needs a connection: the server has to answer first. Complete the count when the tablet is online.")
        }
        service.ask("count.complete", CountBook::refused, StockPayloads.countComplete(
            count, c.store_id, c.scope_kind, c.scope_id, c.scope_text, c.created_at, ahead, uncounted, lines, staff.approvedBy(COUNT, approver),
        ))
        // a linked till: the server's rows take the tablet's place at the sync that follows; until then it is not open here any more
        if (!alone) db.stock().count(count)?.takeIf { it.status == "open" }?.let { db.stock().upsertCounts(listOf(it.copy(status = "completed", uncounted = uncounted, completed_at = System.currentTimeMillis()))) }
    }

    private companion object {
        const val ORDER = "order"
        const val DELIVERY = "delivery"
        const val RECEIVE = "stock.receive"
        const val COUNT = "stock.count"
    }
}

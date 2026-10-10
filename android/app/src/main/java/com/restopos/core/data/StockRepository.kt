package com.restopos.core.data

import com.restopos.core.database.StockDraftEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
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

    private companion object {
        const val ORDER = "order"
        const val DELIVERY = "delivery"
        const val RECEIVE = "stock.receive"
    }
}

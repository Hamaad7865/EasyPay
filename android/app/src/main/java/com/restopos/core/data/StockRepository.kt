package com.restopos.core.data

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
}

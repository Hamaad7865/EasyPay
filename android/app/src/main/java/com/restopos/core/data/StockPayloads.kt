package com.restopos.core.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// What the till sends for each of a shop's stock changes (server 0092), built
// in one place and from plain values, so that a test can hold each against
// the example the server's own suite sends: db/tests/fixtures/till-stock.
// Something left empty goes as "" and the server reads that as none.
// approvedBy: who gave their word, when the person at the till could not have
// done it alone; left out otherwise.
object StockPayloads {
    private fun JsonObject.approved(by: String?): JsonObject =
        if (by == null) this else JsonObject(this + ("approved_by" to kotlinx.serialization.json.JsonPrimitive(by)))

    fun supplierSave(id: String, s: SupplierForm.Supplier, approvedBy: String?): JsonObject = buildJsonObject {
        put("id", id); put("name", s.name); put("contact", s.contact); put("phone", s.phone)
        put("email", s.email); put("address", s.address); put("note", s.note)
    }.approved(approvedBy)

    fun supplierRemove(id: String, approvedBy: String?): JsonObject = buildJsonObject { put("id", id) }.approved(approvedBy)

    // One line a product, as the server would make them anyway.
    private fun lines(of: List<DocLines.Line>) = buildJsonArray {
        DocLines.merged(of).forEach { l ->
            add(buildJsonObject { put("item_id", l.item); put("variant_id", l.variant); put("qty", l.qty); put("unit_cost", l.cost) })
        }
    }

    // po.save: a draft, new or saved again.
    fun poSave(o: OrderForm.Order, store: String, approvedBy: String?): JsonObject = buildJsonObject {
        put("id", o.id); put("store_id", store); put("supplier_id", o.supplier.orEmpty()); put("expected_on", o.expectedOn); put("note", o.note.trim())
        put("lines", lines(o.lines))
    }.approved(approvedBy)

    // po.send, po.cancel and po.close carry the same: which order.
    fun poState(id: String, approvedBy: String?): JsonObject = buildJsonObject { put("id", id) }.approved(approvedBy)

    // delivery.receive. With an order the supplier is the order's, and none is sent.
    fun deliveryReceive(d: DeliveryForm.Delivery, store: String, approvedBy: String?): JsonObject = buildJsonObject {
        put("id", d.id); put("store_id", store); put("order_id", d.order.orEmpty()); put("supplier_id", if (d.order != null) "" else d.supplier.orEmpty())
        put("arrived_on", d.arrivedOn); put("invoice_no", d.invoice.trim()); put("note", d.note.trim())
        put("lines", lines(d.lines))
    }.approved(approvedBy)
}

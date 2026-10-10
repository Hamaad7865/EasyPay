package com.restopos.core.data

import kotlinx.serialization.json.JsonObject
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
}

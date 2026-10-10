package com.restopos.core.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add

// What the tablet sends for the setting-up a till does as the back office
// does (server 0094 on). Each is held against an example in
// db/tests/fixtures/till-office by the tests, and the server's own suite
// sends the same examples: what is built here is what the server was tested
// with.
object OfficePayloads {
    fun taxSave(id: String, tax: TaxForm.Tax, approvedBy: String?): JsonObject = buildJsonObject {
        put("id", id); put("name", tax.name); put("rate_bp", tax.rateBp)
        put("type", if (tax.added) "added" else "included"); put("is_default", tax.usual)
        approvedBy?.let { put("approved_by", it) }
    }

    // An item as its sheet saves it. more: the sheet's second page, when it
    // was there; a key that is not sent is left as it is by the server.
    // countStock: null leaves it as it is. store: the till's own, for the
    // reorder level, which is one store's.
    fun itemSave(
        id: String, item: ItemForm.Item, categoryId: String?, available: Boolean, countStock: Boolean?,
        more: ItemForm.More?, store: String?, approvedBy: String?,
    ): JsonObject = buildJsonObject {
        put("id", id); put("name", item.name); put("price", item.price); put("open_price", item.open)
        put("category_id", categoryId ?: ""); put("barcode", item.barcode ?: ""); put("available", available)
        countStock?.let { put("track_stock", it) }
        more?.let { m ->
            // only what the page says is to be sent: for an item being changed, what the person changed
            fun sent(what: String) = what in m.sent
            if (sent(ItemForm.TAX)) m.taxId?.let { put("tax_id", it) }
            if (m.shop) {
                // a product with variants keeps its codes on its lines: its sheet shows no SKU
                if (m.skuShown && sent(ItemForm.SKU)) put("sku", m.sku ?: "")
                // only from a sheet that showed the cost: the server would ignore it from anyone else
                if (m.costShown && sent(ItemForm.COST)) put("cost", m.cost)
                if (sent(ItemForm.BRAND)) put("brand", m.brand ?: "")
                if (sent(ItemForm.SUPPLIER)) put("supplier_id", m.supplierId ?: "")
                if (sent(ItemForm.SUPPLIER_CODE)) put("supplier_code", m.supplierCode ?: "")
                if (store != null && sent(ItemForm.REORDER)) { put("store_id", store); put("reorder_point", m.reorder); put("reorder_qty", m.orderQty) }
            }
        }
        approvedBy?.let { put("approved_by", it) }
    }

    // A role's sheet: its ticks, and the list the sheet offered them from, in
    // the sheet's order. What the role holds outside that list is kept by
    // whoever takes this (the server, or LocalAnswers).
    fun roleSave(id: String, name: String, ticked: Set<String>, offered: List<String>, approvedBy: String?): JsonObject = buildJsonObject {
        put("id", id); put("name", name)
        putJsonArray("permissions") { offered.filter { it in ticked }.forEach { add(it) } }
        putJsonArray("offered") { offered.forEach { add(it) } }
        approvedBy?.let { put("approved_by", it) }
    }

    fun roleRemove(id: String, approvedBy: String?): JsonObject = buildJsonObject {
        put("role_id", id)
        approvedBy?.let { put("approved_by", it) }
    }

    // A member of staff with no login: what is not given is left as it is.
    fun staffUpdate(id: String, name: String?, roleId: String?, active: Boolean?, approvedBy: String?): JsonObject = buildJsonObject {
        put("employee_id", id)
        name?.let { put("name", it) }
        roleId?.let { put("role_id", it) }
        active?.let { put("active", it) }
        approvedBy?.let { put("approved_by", it) }
    }

    fun discountSave(id: String, d: DiscountForm.Discount, approvedBy: String?): JsonObject = buildJsonObject {
        put("id", id); put("name", d.name); put("type", if (d.percent) "percent" else "amount"); put("value", d.value)
        put("requires_approval", d.needsManager)
        approvedBy?.let { put("approved_by", it) }
    }

    fun discountRemove(id: String, approvedBy: String?): JsonObject = buildJsonObject {
        put("discount_id", id)
        approvedBy?.let { put("approved_by", it) }
    }
}

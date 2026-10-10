package com.restopos.core.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

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
            m.taxId?.let { put("tax_id", it) }
            if (m.shop) {
                // a product with variants keeps its codes on its lines: its sheet shows no SKU
                if (m.skuShown) put("sku", m.sku ?: "")
                // only from a sheet that showed the cost: the server would ignore it from anyone else
                if (m.costShown) put("cost", m.cost)
                put("brand", m.brand ?: ""); put("supplier_id", m.supplierId ?: ""); put("supplier_code", m.supplierCode ?: "")
                if (store != null) { put("store_id", store); put("reorder_point", m.reorder); put("reorder_qty", m.orderQty) }
            }
        }
        approvedBy?.let { put("approved_by", it) }
    }
}

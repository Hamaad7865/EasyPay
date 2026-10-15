package com.restopos.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.math.BigDecimal
import java.math.RoundingMode

// What one of an item is made of (server 0112): a Mix grill is one Chicken
// BBQ and one Lamb BBQ. Kept on the item as the server sends it, a JSON list
// of {"item_id", "qty"}, the quantity in thousandths as every quantity of
// stock is (1000 is one, 500 is half). Empty for everything else.
object Parts {
    data class Part(val item: String, val qty: Int)

    fun parse(json: String?): List<Part> {
        if (json.isNullOrBlank() || json == "[]") return emptyList()
        return runCatching {
            (Json.parseToJsonElement(json) as JsonArray).mapNotNull { e ->
                val o = e as? JsonObject ?: return@mapNotNull null
                val id = o["item_id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                val qty = o["qty"]?.jsonPrimitive?.intOrNull ?: return@mapNotNull null
                Part(id, qty)
            }
        }.getOrDefault(emptyList())
    }

    fun encode(parts: List<Part>): JsonArray = buildJsonArray {
        parts.forEach { p -> add(buildJsonObject { put("item_id", p.item); put("qty", p.qty) }) }
    }

    // What `by` (thousandths) of the item takes of one part, rounded half away
    // from zero as the server's round() does (stock_parts).
    fun share(by: Int, part: Part): Int =
        BigDecimal(by.toLong() * part.qty).divide(BigDecimal(1000), 0, RoundingMode.HALF_UP).toInt()
}

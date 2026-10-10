package com.restopos.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// An order or a delivery being typed, as the text the tablet keeps it in
// until it is sent (stock_drafts). A sixty-line delivery must not be lost to
// a closed app or a dropped connection. Text that cannot be read is no draft.
object StockDrafts {
    private fun lines(of: List<DocLines.Line>) = buildJsonArray {
        of.forEach { l -> add(buildJsonObject { put("item", l.item); put("variant", l.variant); put("qty", l.qty); put("cost", l.cost) }) }
    }
    private fun lines(e: JsonObject): List<DocLines.Line> = e["lines"]!!.jsonArray.map {
        val l = it.jsonObject
        DocLines.Line(l.str("item")!!, l.str("variant").orEmpty(), l["qty"]!!.jsonPrimitive.intOrNull!!, l["cost"]!!.jsonPrimitive.longOrNull!!)
    }
    private fun JsonObject.str(k: String): String? = (this[k] as? JsonElement)?.takeIf { it !is kotlinx.serialization.json.JsonNull }?.jsonPrimitive?.contentOrNull
    private fun read(text: String?): JsonObject? = text?.let { runCatching { Json.parseToJsonElement(it).jsonObject }.getOrNull() }

    fun write(o: OrderForm.Order): String = buildJsonObject {
        put("id", o.id); put("supplier", o.supplier); put("expected_on", o.expectedOn); put("note", o.note); put("lines", lines(o.lines))
    }.toString()

    fun order(text: String?): OrderForm.Order? = runCatching {
        val e = read(text) ?: return null
        OrderForm.Order(e.str("id")!!, e.str("supplier"), e.str("expected_on").orEmpty(), e.str("note").orEmpty(), lines(e))
    }.getOrNull()

    fun write(d: DeliveryForm.Delivery): String = buildJsonObject {
        put("id", d.id); put("order", d.order); put("supplier", d.supplier); put("arrived_on", d.arrivedOn); put("invoice", d.invoice); put("note", d.note)
        put("lines", lines(d.lines))
    }.toString()

    fun delivery(text: String?): DeliveryForm.Delivery? = runCatching {
        val e = read(text) ?: return null
        DeliveryForm.Delivery(e.str("id")!!, e.str("order"), e.str("supplier"), e.str("arrived_on")!!, e.str("invoice").orEmpty(), e.str("note").orEmpty(), lines(e))
    }.getOrNull()
}

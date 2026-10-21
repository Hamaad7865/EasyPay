package com.restopos.core.mra

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// A till's chains, as pos_devices.mra_chain keeps them on the till and on the
// server (0132): for each document type, the last invoice of it this till
// issued, {"STD": {counter, dateTime, totalAmtPaid, brn, invoiceIdentifier}}.
// The next invoice of that type hashes it. Merged by the higher counter, so a
// pull never takes a chain back, as last_receipt_seq is kept.
object MraChain {
    private val json = Json { ignoreUnknownKeys = true }

    private fun parse(text: String?): JsonObject =
        runCatching { json.parseToJsonElement(text ?: "{}").jsonObject }.getOrNull() ?: JsonObject(emptyMap())

    private fun counterOf(o: JsonObject, type: String): Long =
        runCatching { o[type]?.jsonObject?.get("counter")?.jsonPrimitive?.longOrNull }.getOrNull() ?: -1

    fun merge(a: String?, b: String?): String {
        val x = parse(a)
        val y = parse(b)
        return JsonObject((x.keys + y.keys).associateWith { k -> if (counterOf(y, k) > counterOf(x, k)) y[k]!! else x[k]!! }).toString()
    }

    // the chain with this invoice as the last of its type
    fun with(chain: String?, type: String, counter: Long, c: Chained): String = merge(chain, buildJsonObject {
        put(type, buildJsonObject {
            put("counter", counter); put("dateTime", c.dateTime); put("totalAmtPaid", c.totalAmtPaid)
            put("brn", c.brn); put("invoiceIdentifier", c.invoiceIdentifier)
        })
    }.toString())

    // the last invoice of a type, and its counter, or null for the first
    fun last(chain: String?, type: String): Pair<Long, Chained>? {
        val o = runCatching { parse(chain)[type]?.jsonObject }.getOrNull() ?: return null
        fun s(k: String) = runCatching { o[k]?.jsonPrimitive?.contentOrNull }.getOrNull()
        val counter = runCatching { o["counter"]?.jsonPrimitive?.longOrNull }.getOrNull() ?: return null
        return counter to Chained(s("dateTime") ?: return null, s("totalAmtPaid") ?: return null, s("brn") ?: return null, s("invoiceIdentifier") ?: return null)
    }
}

package com.restopos.core.data

import com.restopos.core.database.BookingEntity
import java.time.Instant
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// A booking changed on a tablet (seated, assigned a table, a no-show): what
// is sent is which booking and what was changed on it, marked `partial`, and
// the server changes only that (0126). The tablet's copy may be up to 15
// minutes old, or a change may wait out a Wi-Fi cut: sending every field of
// it put back what the office had changed meanwhile.
object BookingChange {
    fun payload(was: BookingEntity, now: BookingEntity): JsonObject = buildJsonObject {
        put("id", now.id); put("store_id", now.store_id); put("partial", true)
        if (now.booked_for != was.booked_for) put("booked_for", Instant.ofEpochMilli(now.booked_for).toString())
        if (now.name != was.name) put("name", now.name.trim())
        if (now.size != was.size) put("size", now.size)
        if (now.status != was.status) put("status", now.status)
        if (now.phone != was.phone) put("phone", now.phone ?: "")
        if (now.area != was.area) put("area", now.area ?: "")
        if (now.tags != was.tags) put("tags", now.tags ?: "")
        if (now.table_id != was.table_id) { if (now.table_id == null) put("table_id", JsonNull) else put("table_id", now.table_id) }
        if (now.ticket_id != was.ticket_id) now.ticket_id?.let { put("ticket_id", it) }
    }
}

package com.restopos.core.data

import com.restopos.core.database.BookingEntity
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

// A booking changed on a tablet sends what was changed on it, and nothing
// else: the tablet's copy may be up to 15 minutes old, and sending every field
// of it put back what the office had changed meanwhile (4 guests again, no
// table) when a waiter tapped Seat.
class BookingChangeTest {
    private val was = BookingEntity(
        id = "b1", tenant_id = "t", store_id = "s", booked_for = 1_790_000_000_000L, name = "Ravi", size = 4,
        phone = "5252 5270", area = null, table_id = null, tags = null, status = "confirmed",
    )

    @Test
    fun seatingSendsOnlyWhatSeatingChanged() {
        val p = BookingChange.payload(was, was.copy(status = "seated", table_id = "tb7", ticket_id = "o1"))
        assertEquals(setOf("id", "store_id", "partial", "status", "table_id", "ticket_id"), p.keys)
        assertEquals(JsonPrimitive("seated"), p["status"])
        assertEquals(JsonPrimitive(true), p["partial"])
    }

    @Test
    fun aFieldClearedIsSentAsCleared() {
        val p = BookingChange.payload(was.copy(table_id = "tb7"), was)
        assertEquals(JsonNull, p["table_id"])
        assertEquals(BookingChange.payload(was, was.copy(phone = null))["phone"], JsonPrimitive(""))
    }

    @Test
    fun nothingChangedSendsOnlyWhichBooking() =
        assertEquals(setOf("id", "store_id", "partial"), BookingChange.payload(was, was).keys)
}

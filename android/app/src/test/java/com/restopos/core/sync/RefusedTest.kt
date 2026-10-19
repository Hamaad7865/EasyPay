package com.restopos.core.sync

import com.restopos.core.database.OutboxEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// A change the server refused, sent again from the Rejected screen.
class RefusedTest {
    private val dead = OutboxEntity(
        op_id = "old", type = "receipt.create", payload = """{"id":"r1"}""", created_at = 1000L,
        attempts = 1, state = "dead", last_error = "bad-payload", employee_id = "e1",
    )

    // The server keeps its answer to a change's id, so the same id would only
    // be refused again: the change goes under a new one.
    @Test
    fun sentAgainUnderANewId() = assertEquals("new", Refused.again(dead, "new").op_id)

    @Test
    fun sentAgainIsWaitingWithNoError() {
        val again = Refused.again(dead, "new")
        assertEquals("pending", again.state)
        assertNull(again.last_error)
    }

    // What it carries, who did it and its place in the queue stay as they were.
    @Test
    fun sentAgainKeepsWhatItCarriesAndItsPlace() {
        val again = Refused.again(dead, "new")
        assertEquals(dead.type, again.type)
        assertEquals(dead.payload, again.payload)
        assertEquals(dead.employee_id, again.employee_id)
        assertEquals(dead.created_at, again.created_at)
    }

    // Changes sent again together keep the order they were made in.
    @Test
    fun allSentAgainInTheOrderMade() {
        val rows = listOf(dead.copy(op_id = "b", created_at = 2000L), dead.copy(op_id = "a", created_at = 1000L))
        var n = 0
        val again = Refused.allAgain(rows) { "n${n++}" }
        assertEquals(listOf("a", "b"), again.map { it.first })
        assertEquals(listOf("n0", "n1"), again.map { it.second.op_id })
    }
}

package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The owner: "if the customer comes in first it should be customer number 01
// then if we have last customer we can make it customer number 10".
class CustomerNumberTest {
    @Test fun `two digits at least, the letter of its kind in front`() {
        assertEquals("C-01", CustomerNumber.label("C", 1))
        assertEquals("A-10", CustomerNumber.label("A", 10))
        assertEquals("D-100", CustomerNumber.label("D", 100))
    }

    @Test fun `the papers print the number alone`() {
        assertEquals("05", CustomerNumber.digits("A-05"))
        // an order numbered before this build
        assertEquals("7", CustomerNumber.digits("A-7"))
        assertNull(CustomerNumber.digits(null))
        assertNull(CustomerNumber.digits("Table 4"))
        assertNull(CustomerNumber.digits("A-"))
    }

    // Asked for the restaurant: a shop's receipts and a table's papers print none.
    @Test fun `only a restaurant's order without a table prints it`() {
        assertEquals("05", CustomerNumber.onPaper("A-05", tableId = null, retail = false))
        assertNull(CustomerNumber.onPaper("C-05", tableId = null, retail = true))
        assertNull(CustomerNumber.onPaper("C-05", tableId = "t4", retail = false))
        assertNull(CustomerNumber.onPaper(null, tableId = null, retail = false))
    }

    @Test fun `an order whose kind changes keeps its number`() {
        assertEquals("A-05", CustomerNumber.relabel("C-05", "A"))
        assertEquals("weird", CustomerNumber.relabel("weird", "A"))
    }

    // Yesterday's A-03 was left unpaid at the closing and is still open: the
    // new day's count starts at 01 again, and steps over 03.
    @Test fun `a number an open order holds is not given again`() {
        val held = CustomerNumber.held(listOf("A-03", "C-05", null, "Table 4"))
        assertEquals(setOf(3, 5), held)
        var count = 0
        val take: suspend () -> Int = { ++count }
        val given = kotlinx.coroutines.runBlocking { (1..4).map { CustomerNumber.next(held) { take() } } }
        assertEquals(listOf(1, 2, 4, 6), given)
    }

    @Test fun `with nothing open the count goes on as it was`() {
        var count = 6
        assertEquals(7, kotlinx.coroutines.runBlocking { CustomerNumber.next(emptySet()) { ++count } })
    }
}

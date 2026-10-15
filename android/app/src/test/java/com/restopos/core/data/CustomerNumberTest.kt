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

    @Test fun `an order whose kind changes keeps its number`() {
        assertEquals("A-05", CustomerNumber.relabel("C-05", "A"))
        assertEquals("weird", CustomerNumber.relabel("weird", "A"))
    }
}

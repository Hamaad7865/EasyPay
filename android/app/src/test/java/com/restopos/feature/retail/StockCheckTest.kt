package com.restopos.feature.retail

import org.junit.Assert.assertEquals
import org.junit.Test

class StockCheckTest {
    private val sizes = listOf("2y", "3y", "4y", "5y", "6y")

    @Test fun `the variant that was scanned comes first, the others keep their order`() {
        assertEquals(listOf("5y", "2y", "3y", "4y", "6y"), scannedFirst(sizes, "5y") { it })
        // already first: nothing moves
        assertEquals(sizes, scannedFirst(sizes, "2y") { it })
    }

    @Test fun `nothing scanned, or a code the product does not have, keeps the order`() {
        assertEquals(sizes, scannedFirst(sizes, null) { it })
        assertEquals(sizes, scannedFirst(sizes, "9y") { it })
    }
}

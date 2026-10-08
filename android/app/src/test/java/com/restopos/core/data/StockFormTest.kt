package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Stock added or taken out on the till: the quantity as typed, in the
// thousandths the server keeps, and the reasons each direction may give.
class StockFormTest {
    @Test fun `a quantity is read in thousandths`() {
        assertEquals(3000, StockForm.units("3"))
        assertEquals(1500, StockForm.units("1.5"))
        assertEquals(1500, StockForm.units("1,5"))
        assertEquals(350, StockForm.units("0.350"))
        assertEquals(12000, StockForm.units(" 12 "))
    }

    @Test fun `what is not a quantity above nothing is not read`() {
        assertNull(StockForm.units(""))
        assertNull(StockForm.units("0"))
        assertNull(StockForm.units("0.000"))
        assertNull(StockForm.units("abc"))
        assertNull(StockForm.units("-2"))
        assertNull(StockForm.units("1.2345"))
        assertNull(StockForm.units("12345678"))
        assertNull(StockForm.units("1.2.3"))
    }

    @Test fun `each direction has its own reasons, the ones the server takes`() {
        assertEquals(listOf("receive", "found"), StockForm.reasons(StockForm.Way.In).map { it.code })
        assertEquals(listOf("damaged", "expired", "lost", "internal", "supplier_return"), StockForm.reasons(StockForm.Way.Out).map { it.code })
    }

    @Test fun `what there will be`() {
        assertEquals(15000L, StockForm.after(12000, 3000, StockForm.Way.In))
        assertEquals(9000L, StockForm.after(12000, 3000, StockForm.Way.Out))
    }

    @Test fun `what the server refuses is said in words`() {
        assertTrue(StockForm.refused("not-enough-stock", false, "4 left").contains("4 left"))
        assertTrue(StockForm.refused("not-counted", true, "").contains("product"))
        assertTrue(StockForm.refused("not-counted", false, "").contains("item"))
        assertTrue(StockForm.refused("unknown-op", false, "").contains("updated"))
        assertTrue(StockForm.refused("something-new", false, "").contains("something-new"))
    }
}

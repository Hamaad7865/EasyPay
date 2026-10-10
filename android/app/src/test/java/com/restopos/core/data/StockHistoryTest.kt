package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The stock history's words: every reason the server writes a movement with
// has its own, and a quantity is said in units with its sign.
class StockHistoryTest {
    // stock_movements.reason, as migration 0067 allows it
    private val reasons = listOf("sale", "refund", "adjust", "count", "receive", "supplier_return", "opening", "damaged", "expired", "lost", "internal", "found")

    @Test fun `every reason the server allows has words of its own`() {
        val said = reasons.map { StockHistory.says(it) }
        assertEquals(reasons.size, said.toSet().size)
        assertEquals("Correction", StockHistory.says("adjust"))
        assertEquals("Correction", StockHistory.says("something-new"))
    }

    @Test fun `a movement is a sale, a delivery, a count or a correction`() {
        assertEquals(StockHistory.Kind.Sale, StockHistory.kind("sale"))
        assertEquals(StockHistory.Kind.Sale, StockHistory.kind("refund"))
        assertEquals(StockHistory.Kind.Delivery, StockHistory.kind("receive"))
        assertEquals(StockHistory.Kind.Count, StockHistory.kind("count"))
        assertTrue(listOf("adjust", "supplier_return", "opening", "damaged", "expired", "lost", "internal", "found").all { StockHistory.kind(it) == StockHistory.Kind.Correction })
    }

    @Test fun `a quantity is said in units, with its sign`() {
        assertEquals("+3", StockHistory.shown(3000))
        assertEquals("-1.5", StockHistory.shown(-1500))
        assertEquals("+0.35", StockHistory.shown(350))
        assertEquals("0", StockHistory.shown(0))
        assertEquals("-0.350 kg", StockHistory.shown(-350, weighed = true))
    }
}

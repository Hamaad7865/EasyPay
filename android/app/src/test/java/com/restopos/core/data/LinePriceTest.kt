package com.restopos.core.data

import com.restopos.core.database.TicketLineEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LinePriceTest {
    private val rs = { c: Long -> "Rs ${c / 100}.${(c % 100).toString().padStart(2, '0')}" }

    @Test fun `a percentage off is rounded to the cent, half up, and says what it is`() {
        assertEquals(LinePrice.Change(116100, 129000, "discount", "10% off"), LinePrice.percentOff(129000, 10))
        // Rs 19.95 less 15% is Rs 16.9575: Rs 16.96
        assertEquals(1696L, LinePrice.percentOff(1995, 15)!!.unit)
        // Rs 0.05 less 50% is half a cent up
        assertEquals(3L, LinePrice.percentOff(5, 50)!!.unit)
        assertEquals(0L, LinePrice.percentOff(129000, 100)!!.unit)
    }

    @Test fun `no percentage, more than all of it, or nothing to take it off is no discount`() {
        assertNull(LinePrice.percentOff(129000, 0))
        assertNull(LinePrice.percentOff(129000, 101))
        assertNull(LinePrice.percentOff(129000, -5))
        assertNull(LinePrice.percentOff(0, 10))
    }

    @Test fun `rupees off are off each unit, and never more than the price`() {
        assertEquals(LinePrice.Change(119000, 129000, "discount", "Rs 100.00 off"), LinePrice.amountOff(129000, 10000, rs))
        assertEquals(0L, LinePrice.amountOff(129000, 129000, rs)!!.unit)
        assertNull(LinePrice.amountOff(129000, 129001, rs))
        assertNull(LinePrice.amountOff(129000, 0, rs))
    }

    @Test fun `a price typed for this sale is a change of price, up or down, and the listed price is no change`() {
        assertEquals(LinePrice.Change(100000, 129000, "override", "Price changed"), LinePrice.changed(129000, 100000))
        assertEquals("override", LinePrice.changed(129000, 150000)!!.kind)
        assertNull(LinePrice.changed(129000, 129000))
        assertNull(LinePrice.changed(129000, -1))
    }

    @Test fun `what a discount took off a line is the listed amount less the charged one`() {
        // three at Rs 1,290.00, 10% off each
        assertEquals(38700L, LinePrice.saved(129000, 116100, 3000))
        // 350 g at Rs 80.00 a kilo, Rs 8.00 off a kilo
        assertEquals(Calc.lineAmount(8000, 350) - Calc.lineAmount(7200, 350), LinePrice.saved(8000, 7200, 350))
        assertEquals(0L, LinePrice.saved(null, 116100, 3000))
    }

    @Test fun `a quantity reads as a count, or as a weight`() {
        assertEquals("3", LinePrice.qty(3000, false))
        assertEquals("0.350 kg", LinePrice.qty(350, true))
        assertEquals("1.200 kg", LinePrice.qty(1200, true))
        assertEquals("2.5", LinePrice.qty(2500, false))
    }

    @Test fun `what a line says under its name`() {
        assertEquals("M / Navy · Rs 1290.00 each · 10% off", LinePrice.sub("M / Navy", 129000, 116100, "10% off", false, rs))
        assertEquals("Rs 450.00 each", LinePrice.sub(null, null, 45000, null, false, rs))
        assertEquals("Rs 80.00 a kilo", LinePrice.sub(null, null, 8000, null, true, rs))
        assertEquals("Rs 1290.00 each · Price changed", LinePrice.sub("", 129000, 100000, "Price changed", false, rs))
    }

    private fun line(item: String = "i1", variant: String? = null, unit: Long = 1000, kind: String? = null, note: String? = null, paid: Boolean = false, voided: String? = null, sent: String? = null) =
        TicketLineEntity("l", "t", "tk", item, variant, "x", unit, 1000, note, paid = paid, voided_at = voided, sent_to_kitchen_at = sent, price_kind = kind, list_price = if (kind != null) 2000 else null)

    @Test fun `scanning the same thing again goes on the line it is on`() {
        assertTrue(LinePrice.sameLine(line(), "i1", null, 1000))
        assertTrue(LinePrice.sameLine(line(variant = "v1"), "i1", "v1", 1000))
    }

    @Test fun `another variant, another price, a line with a note or a changed price, or one that is paid or gone is another line`() {
        assertFalse(LinePrice.sameLine(line(variant = "v1"), "i1", "v2", 1000))
        assertFalse(LinePrice.sameLine(line(variant = "v1"), "i1", null, 1000))
        assertFalse(LinePrice.sameLine(line(), "i2", null, 1000))
        assertFalse(LinePrice.sameLine(line(unit = 900), "i1", null, 1000))
        assertFalse(LinePrice.sameLine(line(kind = "discount"), "i1", null, 1000))
        assertFalse(LinePrice.sameLine(line(note = "gift"), "i1", null, 1000))
        assertFalse(LinePrice.sameLine(line(paid = true), "i1", null, 1000))
        assertFalse(LinePrice.sameLine(line(voided = "2026-10-08T00:00:00Z"), "i1", null, 1000))
        assertFalse(LinePrice.sameLine(line(sent = "2026-10-08T00:00:00Z"), "i1", null, 1000))
    }

    @Test fun `stock left reads as the tile says it`() {
        assertEquals("12 left", LinePrice.left(12000, false))
        assertEquals("Out", LinePrice.left(0, false))
        assertEquals("Out", LinePrice.left(-2000, false))
        assertEquals("1.250 kg left", LinePrice.left(1250, true))
        assertEquals(LinePrice.Stock.Plenty, LinePrice.stock(6000))
        assertEquals(LinePrice.Stock.Few, LinePrice.stock(5000))
        assertEquals(LinePrice.Stock.Few, LinePrice.stock(1))
        assertEquals(LinePrice.Stock.None, LinePrice.stock(0))
    }
}

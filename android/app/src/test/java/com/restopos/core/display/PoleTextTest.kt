package com.restopos.core.display

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// What a 2-line pole display shows: 20 characters a line, ASCII only, the
// figure the customer needs always whole.
class PoleTextTest {
    private val sale = Picture(
        Picture.SALE, "Sale", listOf(PicLine("1", "Linen shirt", amount = 129000), PicLine("1", "Denim jacket, M", amount = 295000)),
        total = 424000, left = 424000, decimals = 2, business = "Demo shop",
    )

    @Test
    fun aSaleShowsTheLastLineAndTheTotal() {
        val (top, bottom) = PoleText.lines(sale)
        // the name gives way so the amount is whole
        assertEquals("Denim jacke 2,950.00", top)
        assertEquals("TOTAL    Rs 4,240.00", bottom)
    }

    @Test
    fun aSplitBillSaysWhatIsLeft() {
        val (_, bottom) = PoleText.lines(sale.copy(paid = 129000, left = 295000))
        assertEquals("BALANCE" + " ".repeat(20 - 7 - 11) + "Rs 2,950.00", bottom)
    }

    @Test
    fun afterPayTheChange() {
        val (top, bottom) = PoleText.lines(sale.copy(state = Picture.PAID, paid = 500000, change = 76000))
        assertEquals("TOTAL" + " ".repeat(20 - 5 - 11) + "Rs 4,240.00", top)
        assertEquals("CHANGE" + " ".repeat(20 - 6 - 9) + "Rs 760.00", bottom)
    }

    @Test
    fun betweenSalesTheMessageCentred() {
        val idle = Picture(business = "Demo shop", message = "Ask about our lunch deal\nOpen till 22:00")
        val (top, bottom) = PoleText.lines(idle)
        assertEquals("Ask about our lunch ", top)
        assertEquals("  Open till 22:00   ", bottom)
        val (t2, b2) = PoleText.lines(Picture(business = "Demo shop"))
        assertEquals("     Demo shop      ", t2)
        assertEquals("      WELCOME       ", b2)
    }

    @Test
    fun frenchWordsWithoutAccents() {
        val (_, bottom) = PoleText.lines(sale.copy(lang = "fr", state = Picture.PAID, change = 100))
        assertTrue(bottom.startsWith("MONNAIE"))
        assertEquals("Cafe creme a la fete", PoleText.ascii("Café crème à la fête"))
        assertEquals("Total  ", PoleText.ascii("Total\t€"))
    }

    @Test
    fun aLongNameGivesWayToItsAmount() {
        val p = PoleText.pair("Extra large family pizza with cheese", "1,234.00")
        assertEquals(20, p.length)
        assertTrue(p.endsWith(" 1,234.00"))
        assertTrue(p.startsWith("Extra large"))
    }

    @Test
    fun epsonCommands() {
        val b = PoleText.bytes("A" to "B", PoleText.EPSON)
        val want = byteArrayOf(0x1B, 0x40, 0x0C, 0x1F, 0x24, 1, 1) + ("A".padEnd(20)).toByteArray() + byteArrayOf(0x1F, 0x24, 1, 2) + ("B".padEnd(20)).toByteArray()
        assertArrayEquals(want, b)
    }

    @Test
    fun cd5220Commands() {
        val b = PoleText.bytes("A" to "B", PoleText.CD5220)
        val want = byteArrayOf(0x0C, 0x1B, 'Q'.code.toByte(), 'A'.code.toByte()) + ("A".padEnd(20)).toByteArray() + byteArrayOf(0x0D, 0x1B, 'Q'.code.toByte(), 'B'.code.toByte()) +
            ("B".padEnd(20)).toByteArray() + byteArrayOf(0x0D)
        assertArrayEquals(want, b)
    }
}

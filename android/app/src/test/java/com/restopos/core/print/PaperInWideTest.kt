package com.restopos.core.print

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// A 57 mm roll in a printer made for 80 mm rolls (paper_mm 57, 0127): the page
// is the 58 mm page, and the printer is told after its reset to print in the
// middle 48 mm of its 80 mm line. 58 mm and 80 mm pages are as they were.
class PaperInWideTest {
    // reset, then the code page
    private val head = byteArrayOf(0x1B, 0x40, 0x1B, 0x74, 16)
    // GS L 96 (the left margin, in dots), GS W 384 (the print area)
    private val middle = byteArrayOf(0x1D, 0x4C, 0x60, 0x00, 0x1D, 0x57, 0x80.toByte(), 0x01)

    @Test fun `58 and 80 mm pages start as they always did`() {
        assertArrayEquals(head, EscPos(32).bytes())
        assertArrayEquals(head, EscPos(48).bytes())
        assertEquals(Paper(32), Paper.of(58))
        assertEquals(Paper(48), Paper.of(80))
        assertFalse(EscPos.inWide(58) || EscPos.inWide(80))
    }

    @Test fun `a 57 mm roll in an 80 mm printer is printed in the middle 48 mm`() {
        assertArrayEquals(head + middle, EscPos(32, inWide = true).bytes())
        assertEquals(Paper(32, 4, false, true, inWide = true), Paper.of(57, feed = 4, cut = false, trial = true))
        assertTrue(EscPos.inWide(EscPos.IN_WIDE))
        assertEquals(32, EscPos.columnsFor(57))
        assertEquals(384, EscPos.dotsFor(57))
    }

    @Test fun `its page is the 58 mm page with the margin and the print area after the reset`() {
        val narrow = Docs.test("Receipt", Paper.of(58))
        val wide = Docs.test("Receipt", Paper.of(57))
        assertArrayEquals(head + middle + narrow.copyOfRange(head.size, narrow.size), wide)
    }
}

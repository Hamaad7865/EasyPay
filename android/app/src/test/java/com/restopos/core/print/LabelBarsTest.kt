package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelBarsTest {
    @Test fun `an EAN-13 is thirteen digits with the right check digit`() {
        assertTrue(LabelBars.isEan13("5901234123457"))
        assertTrue(LabelBars.isEan13("2000000000008"))
        assertFalse(LabelBars.isEan13("5901234123458"))
        assertFalse(LabelBars.isEan13("590123412345"))
        assertFalse(LabelBars.isEan13("59012341234AB"))
    }

    @Test fun `an EAN-13 has its 95 modules between 11 clear ones and 7`() {
        val s = LabelBars.symbol("5901234123457")!!
        assertTrue(s.ean)
        assertEquals(113, s.bits.size)
        assertTrue(s.bits.take(11).none { it })
        assertTrue(s.bits.takeLast(7).none { it })
        // the guard bars: 101 at each end of the 95
        assertTrue(s.bits[11]); assertFalse(s.bits[12]); assertTrue(s.bits[13])
        assertTrue(s.bits[105]); assertFalse(s.bits[104]); assertTrue(s.bits[103])
    }

    @Test fun `anything else is Code 128 between ten clear modules`() {
        val s = LabelBars.symbol("1010")!!
        assertFalse(s.ean)
        assertTrue(s.bits.take(10).none { it })
        assertTrue(s.bits.takeLast(10).none { it })
        assertTrue(s.bits[10])
        // a start, the characters and a check of eleven modules each, and a stop of thirteen
        assertEquals(0, (s.bits.size - 20 - 13) % 11)
        assertNotNull(LabelBars.symbol("SML-GX11"))
        // thirteen digits that are no EAN-13 still get bars
        assertFalse(LabelBars.symbol("5901234123458")!!.ean)
    }

    @Test fun `what cannot be put in bars has none`() {
        assertNull(LabelBars.symbol(""))
        assertNull(LabelBars.symbol("   "))
        assertNull(LabelBars.symbol("1".repeat(41)))
        assertNull(LabelBars.symbol("é1"))
    }

    @Test fun `the thinnest bar is whole dots, never under a quarter of a millimetre`() {
        assertEquals(2, LabelBars.module(113, 288, 203))
        assertEquals(3, LabelBars.module(113, 352, 203))
        assertNull(LabelBars.module(113, 192, 203))
        // at 300 dots an inch two dots are too thin, and three do not fit 25 mm
        assertNull(LabelBars.module(113, 295, 300))
        // and never wider than half a millimetre, however short the code
        assertEquals(4, LabelBars.module(40, 320, 203))
        assertEquals(6, LabelBars.module(40, 472, 300))
    }
}

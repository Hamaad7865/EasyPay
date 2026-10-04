package com.restopos.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

// Category colours are stored as CSS text. The demo menu uses oklch(); a
// colour picked in the back office may be hex.
class CssColorTest {
    private fun near(expected: Int, actual: Int?) {
        requireNotNull(actual)
        for (shift in listOf(16, 8, 0)) {
            val e = (expected shr shift) and 0xFF
            val a = (actual shr shift) and 0xFF
            assertTrue("channel at $shift: expected $e, got $a", abs(e - a) <= 2)
        }
    }

    @Test
    fun hex() {
        assertEquals(0xFFFF0000.toInt(), CssColor.argb("#ff0000"))
        assertEquals(0xFF336699.toInt(), CssColor.argb(" #369 "))
    }

    @Test
    fun oklchEndsOfTheScale() {
        near(0xFFFFFF, CssColor.argb("oklch(1 0 0)"))
        near(0x000000, CssColor.argb("oklch(0 0 0)"))
    }

    @Test
    fun oklchKnownColours() {
        near(0xFF0000, CssColor.argb("oklch(0.628 0.2577 29.23)")) // sRGB red
        near(0x0000FF, CssColor.argb("oklch(45.2% 0.3132 264.05)")) // sRGB blue, percent lightness
    }

    @Test
    fun anythingElseIsNoColour() {
        assertNull(CssColor.argb(null))
        assertNull(CssColor.argb("red"))
        assertNull(CssColor.argb("oklch(0.6 0.1)"))
        assertNull(CssColor.argb("#12"))
    }
}

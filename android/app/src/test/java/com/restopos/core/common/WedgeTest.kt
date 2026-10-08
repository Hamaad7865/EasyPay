package com.restopos.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Scan mode puts a scanner's keys together with no text field (Wedge). These
// are its rules: what is one scan, what ends it, and what is only noise.
class WedgeTest {
    private fun scan(w: Wedge, text: String, from: Long = 1000, every: Long = 10): String? {
        text.forEachIndexed { i, c -> w.key(c.code, from + i * every) }
        return w.enter()
    }

    @Test
    fun aBurstEndedByEnterIsTheCode() {
        assertEquals("5901234123457", scan(Wedge(), "5901234123457"))
    }

    @Test
    fun aReceiptNumberComesThroughWithItsDashes() {
        assertEquals("S1-T1-000123", scan(Wedge(), "S1-T1-000123"))
    }

    @Test
    fun theNextScanStartsClean() {
        val w = Wedge()
        assertEquals("11112222", scan(w, "11112222"))
        assertEquals("33334444", scan(w, "33334444", from = 5000))
    }

    @Test
    fun aStrayKeyLongBeforeDoesNotStickToTheScan() {
        val w = Wedge()
        w.key('7'.code, 0)
        assertEquals("12345678", scan(w, "12345678", from = 3000))
    }

    @Test
    fun keysTooFarApartAreNotOneScan() {
        val w = Wedge()
        w.key('1'.code, 0); w.key('2'.code, 400); w.key('3'.code, 800)
        // only the last key is left, and one character is not a code
        assertNull(w.enter())
    }

    @Test
    fun anEnterAloneIsNoise() {
        val w = Wedge()
        assertNull(w.enter())
        assertNull(scan(w, "12"))
    }

    @Test
    fun controlCharactersAreDropped() {
        val w = Wedge()
        w.key(2, 1000) // a scanner's start-of-text prefix
        assertEquals("ABC123", scan(w, "ABC123", from = 1005))
    }

    @Test
    fun backspaceTakesTheLastCharacterOff() {
        val w = Wedge()
        "1234X".forEachIndexed { i, c -> w.key(c.code, 1000L + i * 10) }
        w.backspace()
        assertEquals("1234", w.enter())
    }

    @Test
    fun spacesAroundTheCodeAreTrimmed() {
        assertEquals("ABC-1", scan(Wedge(), " ABC-1 "))
    }

    @Test
    fun resetForgetsWhatWasRead() {
        val w = Wedge()
        "9999".forEachIndexed { i, c -> w.key(c.code, 1000L + i * 10) }
        w.reset()
        assertNull(w.enter())
    }
}

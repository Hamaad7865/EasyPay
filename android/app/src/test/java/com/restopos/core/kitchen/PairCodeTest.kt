package com.restopos.core.kitchen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

// The code a kitchen tablet shows and someone types into the back office. It
// is read off one screen and typed on another, so it has no letter or digit
// that can be taken for another (no I, O, 0 or 1).
class PairCodeTest {
    @Test
    fun aCodeIsEightOfTheAllowedCharacters() {
        val made = (1..200).map { PairCode.make(Random(it.toLong())) }
        assertTrue(made.all { Regex("^[A-HJ-NP-Z2-9]{8}$").matches(it) })
        // and they are not all the same one
        assertTrue(made.toSet().size > 190)
        assertNotEquals(PairCode.make(), PairCode.make())
    }

    @Test
    fun whatIsTypedIsTidied() {
        assertEquals("KTCHN234", PairCode.tidy(" ktch-n234 "))
        assertEquals("KTCHN234", PairCode.tidy("KTCH N234"))
        assertNull(PairCode.tidy("KTCHN23"))
        assertNull(PairCode.tidy("KTCHN2345"))
        assertNull(PairCode.tidy("KTCHN2O4"))
        assertNull(PairCode.tidy("KTCHN214"))
        assertNull(PairCode.tidy(null))
    }

    // the back office accepts the same codes and no others (its page's CODE)
    @Test
    fun theAlphabetIsTheOneTheBackOfficeTakes() {
        assertEquals("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", PairCode.ALPHABET)
    }
}

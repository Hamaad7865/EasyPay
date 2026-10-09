package com.restopos.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

// The sounds are made here, so what is made can be checked without a tablet:
// that there is something to hear, that it is as long as its notes, and that
// it neither starts nor stops on a click.
class ChimeTest {
    private fun loudest(s: ShortArray, from: Int = 0, to: Int = s.size) = (from until to).maxOf { abs(s[it].toInt()) }

    @Test
    fun aChimeIsAsLongAsItsNotesAndSomethingToHear() {
        val s = Chime.pcm(Chime.ORDER)
        val notes = Chime.ORDER.sumOf { Chime.RATE * it.ms / 1000 }
        assertEquals(notes + Chime.RATE * 60 / 1000, s.size)
        // well up towards full volume, and never past it
        assertTrue(loudest(s) > Short.MAX_VALUE * 0.6)
        assertTrue(loudest(s) <= Short.MAX_VALUE)
    }

    @Test
    fun itStartsAndEndsQuietly() {
        for (notes in listOf(Chime.ORDER, Chime.READY)) {
            val s = Chime.pcm(notes)
            assertEquals(0, s[0].toInt())
            // the last note has died away, and the stretch after it is silence
            val end = notes.sumOf { Chime.RATE * it.ms / 1000 }
            assertTrue(loudest(s, end - 40, end) < Short.MAX_VALUE * 0.06)
            assertEquals(0, loudest(s, end, s.size))
        }
    }

    @Test
    fun everyNoteIsHeard() {
        val s = Chime.pcm(Chime.READY)
        var at = 0
        for (n in Chime.READY) {
            val len = Chime.RATE * n.ms / 1000
            assertTrue(loudest(s, at, at + len) > Short.MAX_VALUE * 0.5)
            at += len
        }
    }

    // the kitchen's sound and the takeaway's are told apart by ear
    @Test
    fun theTwoSoundsAreNotTheSame() {
        assertNotEquals(Chime.ORDER.map { it.hz }, Chime.READY.map { it.hz })
        assertNotEquals(Chime.pcm(Chime.ORDER).size, Chime.pcm(Chime.READY).size)
    }
}

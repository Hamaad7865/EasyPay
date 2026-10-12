package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// A line's kitchen note, from the keys under the menu: it must read as the
// options sheet writes it ("No onions · Well done"), whichever put it on.
class LineNotesTest {
    @Test
    fun aNoteIsTheTickedNotesJoinedAsTheSheetJoinsThem() {
        assertEquals("No onions · Well done", LineNotes.join(listOf("No onions", "Well done")))
        assertEquals(listOf("No onions", "Well done"), LineNotes.split("No onions · Well done"))
    }

    @Test
    fun noNoteIsNoNote() {
        assertNull(LineNotes.join(emptyList()))
        assertNull(LineNotes.join(listOf(" ", "")))
        assertEquals(emptyList<String>(), LineNotes.split(null))
        assertEquals(emptyList<String>(), LineNotes.split(""))
    }

    @Test
    fun aTapPutsANoteOnOrTakesItOff() {
        assertEquals(listOf("No onions", "Well done"), LineNotes.toggle(listOf("No onions"), "Well done"))
        assertEquals(listOf("Well done"), LineNotes.toggle(listOf("No onions", "Well done"), "No onions"))
        // what goes back on the line after a tap reads the same once split again
        val after = LineNotes.toggle(LineNotes.split("No onions"), "Extra spicy")
        assertEquals(after, LineNotes.split(LineNotes.join(after)))
    }

    @Test
    fun aNoteTypedTwiceIsSaidOnce() {
        assertEquals("No onions", LineNotes.join(listOf("No onions", " No onions ")))
    }
}

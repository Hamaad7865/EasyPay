package com.restopos.core.ui

import org.junit.Assert.assertEquals
import org.junit.Test

// What a card shows where its picture would be, for a product that has none.
class PictureCardTest {
    @Test
    fun twoWordsGiveTheirFirstLetters() {
        assertEquals("CB", initials("Chicken burger"))
        assertEquals("MF", initials("  mine   frite  poulet "))
    }

    @Test
    fun oneWordGivesItsFirstTwo() {
        assertEquals("Co", initials("coke"))
        assertEquals("Éc", initials("Éclair"))
        assertEquals("7", initials("7"))
    }

    // brackets and dashes are not letters of a word
    @Test
    fun signsAreLeftOut() {
        assertEquals("LP", initials("(Large) pizza"))
        assertEquals("CC", initials("Coca-Cola"))
        assertEquals("7U", initials("7-Up"))
        assertEquals("", initials(" - "))
        assertEquals("", initials(""))
    }
}

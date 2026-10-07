package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

// The notes a waiter can tick when adding an item, as the back office saved
// them. A restaurant that wants none must be able to have none: the list it
// saved is the list, and only one that never saved a list gets the usual five.
class KitchenNotesTest {
    @Test
    fun aRestaurantThatNeverSavedItsNotesIsOfferedTheUsualFive() {
        assertEquals(PosSettings.DEFAULT_NOTES, PosSettings.parse(null).kitchenNotes)
        assertEquals(PosSettings.DEFAULT_NOTES, PosSettings.parse("""{"decimals":2}""").kitchenNotes)
    }

    @Test
    fun theNotesSavedAreTheNotesOffered() {
        assertEquals(listOf("Sans piment", "Rush"), PosSettings.parse("""{"kitchenNotes":[" Sans piment ","","Rush"]}""").kitchenNotes)
        assertEquals(12, PosSettings.parse("""{"kitchenNotes":[${(1..20).joinToString(",") { "\"n$it\"" }}]}""").kitchenNotes.size)
    }

    @Test
    fun aListSavedEmptyStaysEmpty() {
        assertEquals(emptyList<String>(), PosSettings.parse("""{"kitchenNotes":[]}""").kitchenNotes)
        assertEquals(emptyList<String>(), PosSettings.parse("""{"kitchenNotes":[""," "]}""").kitchenNotes)
    }

    @Test
    fun somethingThatIsNotAListIsTheUsualFive() {
        assertEquals(PosSettings.DEFAULT_NOTES, PosSettings.parse("""{"kitchenNotes":"Rush"}""").kitchenNotes)
        assertEquals(PosSettings.DEFAULT_NOTES, PosSettings.parse("""{"kitchenNotes":null}""").kitchenNotes)
    }
}

package com.restopos.core.data

import com.restopos.core.database.ModRow
import org.junit.Assert.assertEquals
import org.junit.Test

// What the kitchen reads under an item: a line for each add-on group, its
// choices side by side. The owner: "I want it like this: Chili, Mayo".
class KitchenModsTest {
    private fun row(group: String?, name: String, qty: Int = 1) = ModRow("l1", group, name, qty)

    @Test
    fun theChoicesOfOneGroupShareALine() {
        assertEquals(listOf("Mayo, Chili"), kitchenMods(listOf(row("sauces", "Mayo"), row("sauces", "Chili"))))
    }

    @Test
    fun eachGroupHasItsOwnLineInTheOrderItWasFirstPicked() {
        val rows = listOf(row("sauces", "Mayo"), row("extras", "Onion"), row("sauces", "Chili"))
        assertEquals(listOf("Mayo, Chili", "Onion"), kitchenMods(rows))
    }

    @Test
    fun anAddOnTakenSeveralTimesSaysHowMany() {
        assertEquals(listOf("Mayo, 3 x Sausage"), kitchenMods(listOf(row("extras", "Mayo"), row("extras", "Sausage", 3))))
        assertEquals(listOf("3 × Sausage"), kitchenMods(listOf(row("extras", "Sausage", 3)), times = " × "))
    }

    @Test
    fun oneWhoseGroupIsNotKnownHasALineOfItsOwn() {
        val rows = listOf(row(null, "Old sauce"), row("sauces", "Mayo"), row(null, "Old extra"), row("sauces", "Chili"))
        assertEquals(listOf("Old sauce", "Mayo, Chili", "Old extra"), kitchenMods(rows))
    }

    @Test
    fun noAddOnsIsNoLine() {
        assertEquals(emptyList<String>(), kitchenMods(emptyList()))
    }

    @Test
    fun theScreenReadsTheGroupsAndThenTheNoteOneUnderTheOther() {
        assertEquals("Mayo, Chili\nOnion\nNo salt", kitchenDetail(listOf("Mayo, Chili", "Onion"), "No salt"))
        assertEquals("No salt", kitchenDetail(emptyList(), "No salt"))
        assertEquals("Onion", kitchenDetail(listOf("Onion"), " "))
        assertEquals("", kitchenDetail(emptyList(), null))
    }
}

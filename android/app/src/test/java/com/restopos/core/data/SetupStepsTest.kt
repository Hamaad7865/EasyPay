package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The first-run set-up: which steps a business has, which of them are done,
// and what the summary says of each. A step is done when its work exists,
// whoever did it: products imported in the back office count as much as ones
// typed on the tablet.
class SetupStepsTest {
    private val nothing = SetupFacts()
    private val shop = SetupFacts(retail = true)

    @Test fun `a restaurant has five steps and a shop has no tables`() {
        assertEquals(listOf(SetupStep.Menu, SetupStep.Tables, SetupStep.Printer, SetupStep.Company, SetupStep.Staff), SetupSteps.of(false))
        assertEquals(listOf(SetupStep.Menu, SetupStep.Printer, SetupStep.Company, SetupStep.Staff), SetupSteps.of(true))
    }

    @Test fun `nothing is done for a business that has nothing`() {
        SetupStep.values().forEach { assertFalse(it.name, SetupSteps.done(it, nothing)) }
    }

    @Test fun `a step is done when its work exists`() {
        assertTrue(SetupSteps.done(SetupStep.Menu, nothing.copy(items = 1)))
        assertTrue(SetupSteps.done(SetupStep.Tables, nothing.copy(tables = 1)))
        assertTrue(SetupSteps.done(SetupStep.Printer, nothing.copy(printers = listOf("Receipt"))))
        assertTrue(SetupSteps.done(SetupStep.Company, nothing.copy(address = "Royal Road")))
        assertTrue(SetupSteps.done(SetupStep.Company, nothing.copy(phone = "5 123 4567")))
        assertFalse(SetupSteps.done(SetupStep.Company, nothing.copy(address = "  \n ")))
        assertTrue(SetupSteps.done(SetupStep.Staff, nothing.copy(pins = 1)))
        // a category with nothing in it is not something to sell
        assertFalse(SetupSteps.done(SetupStep.Menu, nothing.copy(categories = 3)))
    }

    @Test fun `the first run starts at the first step that is not done`() {
        assertEquals(SetupStep.Menu, SetupSteps.first(nothing))
        assertEquals(SetupStep.Tables, SetupSteps.first(nothing.copy(items = 4)))
        assertEquals(SetupStep.Printer, SetupSteps.first(shop.copy(items = 4)))
        assertEquals(SetupStep.Staff, SetupSteps.first(nothing.copy(items = 4, tables = 2, printers = listOf("Receipt"), phone = "5 123 4567")))
        assertNull(SetupSteps.first(SetupFacts(false, 4, 1, 2, 1, listOf("Receipt"), "Royal Road", "", 1)))
        // a shop is not asked for tables it will never have
        assertNull(SetupSteps.first(SetupFacts(true, 4, 1, 0, 0, listOf("Receipt"), "", "5 123 4567", 2)))
    }

    @Test fun `each step has its name, and a shop sells products`() {
        assertEquals("Menu", SetupSteps.title(SetupStep.Menu, false))
        assertEquals("Products", SetupSteps.title(SetupStep.Menu, true))
        assertEquals("Tables", SetupSteps.title(SetupStep.Tables, false))
        assertEquals("Printer", SetupSteps.title(SetupStep.Printer, false))
        assertEquals("Business details", SetupSteps.title(SetupStep.Company, true))
        assertEquals("Staff and PINs", SetupSteps.title(SetupStep.Staff, false))
    }

    @Test fun `the summary says what is there`() {
        assertEquals("43 items in 8 categories", SetupSteps.line(SetupStep.Menu, nothing.copy(items = 43, categories = 8)))
        assertEquals("1 item in 1 category", SetupSteps.line(SetupStep.Menu, nothing.copy(items = 1, categories = 1)))
        assertEquals("43 products in 8 categories", SetupSteps.line(SetupStep.Menu, shop.copy(items = 43, categories = 8)))
        assertEquals("5 items", SetupSteps.line(SetupStep.Menu, nothing.copy(items = 5)))
        assertEquals("18 tables in 2 rooms", SetupSteps.line(SetupStep.Tables, nothing.copy(tables = 18, rooms = 2)))
        assertEquals("1 table in 1 room", SetupSteps.line(SetupStep.Tables, nothing.copy(tables = 1, rooms = 1)))
        assertEquals("Receipt", SetupSteps.line(SetupStep.Printer, nothing.copy(printers = listOf("Receipt"))))
        assertEquals("Receipt and 2 more", SetupSteps.line(SetupStep.Printer, nothing.copy(printers = listOf("Receipt", "Kitchen", "Bar"))))
        assertEquals("Royal Road", SetupSteps.line(SetupStep.Company, nothing.copy(address = "\n Royal Road \nCurepipe", phone = "5 123 4567")))
        assertEquals("5 123 4567", SetupSteps.line(SetupStep.Company, nothing.copy(phone = " 5 123 4567 ")))
        assertEquals("3 people have a PIN", SetupSteps.line(SetupStep.Staff, nothing.copy(pins = 3)))
        assertEquals("1 person has a PIN", SetupSteps.line(SetupStep.Staff, nothing.copy(pins = 1)))
    }

    @Test fun `and what its absence means`() {
        assertEquals("Nothing to sell yet", SetupSteps.line(SetupStep.Menu, nothing))
        assertEquals("No tables: orders are counter sales and takeaways", SetupSteps.line(SetupStep.Tables, nothing))
        assertEquals("No printer: nothing prints and the cash drawer stays shut", SetupSteps.line(SetupStep.Printer, nothing))
        assertEquals("No address or phone on the receipt", SetupSteps.line(SetupStep.Company, nothing))
        assertEquals("No PINs: the register opens with one tap", SetupSteps.line(SetupStep.Staff, nothing))
    }

    // After "Name this till" the tablet's own tables are empty until its first
    // pull has finished. Nothing is decided from them before that.
    @Test fun `nothing is decided until a whole pull has finished since the till was registered`() {
        val open = PosSettings.parse("""{"setup":"open"}""")
        assertEquals(SetupSteps.After.Wait, SetupSteps.after(1_000, null, open))
        assertEquals(SetupSteps.After.Wait, SetupSteps.after(1_000, 999, open))
        assertEquals(SetupSteps.After.SetUp, SetupSteps.after(1_000, 1_000, open))
        assertEquals(SetupSteps.After.SetUp, SetupSteps.after(1_000, 5_000, open))
        assertEquals(SetupSteps.After.Till, SetupSteps.after(1_000, 5_000, PosSettings.parse("""{"setup":"done"}""")))
        assertEquals(SetupSteps.After.Till, SetupSteps.after(1_000, 5_000, PosSettings()))
    }
}

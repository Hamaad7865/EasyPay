package com.restopos.core.data

import com.restopos.core.database.PrinterEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Where an order's items print, for every way a restaurant can be set up. A
// ticket that prints in the wrong place, or nowhere, is food that is not
// made: each case here is one a restaurant will meet.
class RoutingTest {
    private fun printer(
        id: String, receipt: Boolean = false, store: String = "main", on: Boolean = true, removed: Boolean = false,
        address: String? = "192.168.1.50", kind: String = "network",
    ) = PrinterEntity(
        id = id, tenant_id = "t", store_id = store, name = id.replaceFirstChar { it.uppercase() }, kind = kind, address = address,
        is_receipt = receipt, is_active = on, deleted_at = if (removed) "2026-01-01T00:00:00Z" else null,
    )

    private val cashier = printer("cashier", receipt = true)
    private val kitchen = printer("kitchen")
    private val bar = printer("bar")
    private val three = listOf(cashier, kitchen, bar)

    // an order: a curry (kitchen), a beer (bar), a platter made in both places, and something with no category
    private val order = listOf("curry" to listOf("kitchen"), "beer" to listOf("bar"), "platter" to listOf("bar", "kitchen"), "gift card" to null)

    @Test
    fun eachLineGoesToItsCategorysPrinter() {
        val t = Routing.tickets(order, three, onePrinter = false)
        assertEquals(listOf("curry", "platter"), t["kitchen"])
        assertEquals(listOf("beer", "platter"), t["bar"])
    }

    @Test
    fun aCategoryOnTwoPrintersPrintsOnceOnEach() {
        assertEquals(listOf("kitchen", "bar"), Routing.printersFor(listOf("bar", "kitchen", "bar"), three, false))
        val t = Routing.tickets(listOf("platter" to listOf("bar", "kitchen", "kitchen")), three, false)
        assertEquals(listOf("platter"), t["kitchen"])
        assertEquals(listOf("platter"), t["bar"])
    }

    @Test
    fun aLineWithNowhereToPrintIsOnNoTicket() {
        val t = Routing.tickets(listOf("gift card" to null, "water" to emptyList()), three, false)
        assertTrue(t.isEmpty())
        assertEquals(emptyList<String>(), Routing.printersFor(null, three, false))
    }

    @Test
    fun nothingIsPrintedOnTheCashiersPrinterUnlessItIsTicked() {
        val t = Routing.tickets(order, three, false)
        assertNull(t["cashier"])
        assertEquals(listOf("soup"), Routing.tickets(listOf("soup" to listOf("cashier")), three, false)["cashier"])
    }

    @Test
    fun linesStayInTheOrderTheyWereRungUp() {
        val t = Routing.tickets(listOf("c" to listOf("kitchen"), "a" to listOf("kitchen"), "b" to listOf("kitchen")), three, false)
        assertEquals(listOf("c", "a", "b"), t["kitchen"])
    }

    @Test
    fun aPrinterThatIsOffRemovedOrInAnotherStoreIsNotPrintedOn() {
        val all = listOf(cashier, printer("kitchen", on = false), printer("bar", removed = true), printer("pastry", store = "other"), printer("grill"))
        val usable = Routing.usable(all, "main")
        assertEquals(listOf("cashier", "grill"), usable.map { it.id })
        val t = Routing.tickets(listOf("curry" to listOf("kitchen", "grill"), "beer" to listOf("bar"), "cake" to listOf("pastry")), usable, false)
        assertEquals(mapOf("grill" to listOf("curry")), t)
    }

    @Test
    fun aCategoryThatNamesAPrinterThatNoLongerExistsPrintsNowhere() {
        assertEquals(emptyList<String>(), Routing.printersFor(listOf("gone"), three, false))
    }

    @Test
    fun onePrinterForEverythingTakesEveryLine() {
        val t = Routing.tickets(order, three, onePrinter = true)
        assertEquals(mapOf("cashier" to listOf("curry", "beer", "platter", "gift card")), t)
    }

    @Test
    fun onePrinterForEverythingWorksWithOnlyThatPrinter() {
        val only = listOf(cashier)
        val t = Routing.tickets(order, only, onePrinter = true)
        assertEquals(listOf("curry", "beer", "platter", "gift card"), t["cashier"])
        // a category added later, with nothing ticked, is covered too
        assertEquals(listOf("cashier"), Routing.printersFor(emptyList(), only, true))
    }

    @Test
    fun onePrinterForEverythingWithoutAReceiptPrinterFallsBackToTheCategories() {
        val noCashier = listOf(kitchen, bar)
        assertNull(Routing.single(noCashier, true))
        assertEquals(listOf("curry", "platter"), Routing.tickets(order, noCashier, true)["kitchen"])
        // the same when the receipt printer is switched off
        val off = Routing.usable(listOf(printer("cashier", receipt = true, on = false), kitchen, bar), "main")
        assertEquals(listOf("beer", "platter"), Routing.tickets(order, off, true)["bar"])
    }

    @Test
    fun aKitchenTicketSaysWhereItIsForOrThatItIsAKitchenOrder() {
        assertEquals("Kitchen", Routing.heading(kitchen, three, false))
        assertEquals("Kitchen order", Routing.heading(cashier, three, true))
        assertEquals("Kitchen", Routing.heading(kitchen, listOf(kitchen, bar), true))
    }

    @Test
    fun theKitchenDisplaysStationsAreThePrintersWhereThingsAreMade() {
        val ticked = listOf(listOf("kitchen"), listOf("bar"), listOf("cashier"), emptyList())
        val stations = Routing.stations(ticked, three, false)
        assertEquals(listOf("kitchen", "bar"), stations.map { it.id })
        assertEquals(setOf("kitchen"), Routing.stationsFor(listOf("kitchen", "cashier"), stations))
        assertEquals(emptySet<String>(), Routing.stationsFor(null, stations))
        // a printer nothing is ticked for is not a station
        assertEquals(listOf("kitchen"), Routing.stations(listOf(listOf("kitchen")), three, false).map { it.id })
    }

    @Test
    fun withOnePrinterForEverythingThereAreNoStations() {
        assertTrue(Routing.stations(listOf(listOf("kitchen"), listOf("bar")), three, true).isEmpty())
    }

    @Test
    fun onePhysicalPrinterIsOneLineHoweverItWasEntered() {
        val receipt = printer("a", receipt = true, address = "192.168.1.50")
        val sameAsKitchen = printer("b", address = " 192.168.1.50:9100 ")
        val otherPort = printer("c", address = "192.168.1.50:9101")
        val other = printer("d", address = "192.168.1.51")
        assertEquals(Routing.line(receipt), Routing.line(sameAsKitchen))
        assertNotEquals(Routing.line(receipt), Routing.line(otherPort))
        assertNotEquals(Routing.line(receipt), Routing.line(other))
        assertEquals("usb", Routing.line(printer("e", kind = "usb", address = null)))
        assertEquals(Routing.line(printer("f", kind = "usb", address = null)), Routing.line(printer("g", kind = "usb", address = "ignored")))
    }

    @Test
    fun aCategorysPrintersAreReadFromWhatIsStored() {
        assertEquals(listOf("a", "b"), Routing.ids("""["a","b"]"""))
        assertEquals(emptyList<String>(), Routing.ids("[]"))
        assertEquals(emptyList<String>(), Routing.ids(null))
        assertEquals(emptyList<String>(), Routing.ids("not json"))
    }

    @Test
    fun theSwitchIsOffUnlessTheBackOfficeTurnedItOn() {
        assertEquals(false, PosSettings.parse(null).onePrinter)
        assertEquals(false, PosSettings.parse("""{"decimals":2}""").onePrinter)
        assertEquals(true, PosSettings.parse("""{"onePrinter":true}""").onePrinter)
        assertEquals(false, PosSettings.parse("""{"onePrinter":"yes"}""").onePrinter)
    }

    // A restaurant with no kitchen display (the premium tier's) has only its
    // paper: a line that prints nowhere reaches nobody, and the till must say
    // which, not mark it sent in silence.
    @Test
    fun aLineWithNoPrinterIsNamed() {
        assertEquals(listOf("gift card"), Routing.nowhere(order, three, onePrinter = false))
        // a category whose only printer is switched off prints nowhere either
        val barOff = listOf(cashier, kitchen, printer("bar", on = false))
        assertEquals(listOf("beer", "gift card"), Routing.nowhere(order, Routing.usable(barOff, "main"), onePrinter = false))
        // one printer for everything prints everything
        assertEquals(emptyList<String>(), Routing.nowhere(order, three, onePrinter = true))
        // and with no printer at all, nothing prints
        assertEquals(listOf("curry", "beer", "platter", "gift card"), Routing.nowhere(order, emptyList(), onePrinter = true))
    }

    @Test
    fun theSentenceForThem() {
        assertNull(Routing.nowhereText(emptyList()))
        assertEquals(
            "1 item went to no printer: Water. Tick a printer for its category in the back office.",
            Routing.nowhereText(listOf("Water")),
        )
        // each line counts, each name is said once
        assertEquals(
            "3 items went to no printer: Water, Cola. Tick a printer for their category in the back office.",
            Routing.nowhereText(listOf("Water", "Cola", "Water")),
        )
    }
}

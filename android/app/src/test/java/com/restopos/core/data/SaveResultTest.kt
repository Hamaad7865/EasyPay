package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// What the till says after Send to kitchen when something did not go as it
// should. A restaurant with a kitchen display is told the order is on it; one
// without (the display is the premium tier's) must not be.
class SaveResultTest {
    private val failed = "Kitchen is not answering at 192.168.1.50. Check that it is on and on the same network."
    private val nowhere = "1 item went to no printer: Water. Tick a printer for its category in the back office."

    @Test
    fun aSendThatWentWellSaysNothing() {
        assertNull(SaveResult(2, emptyList()).trouble())
        assertNull(SaveResult(0, emptyList(), onDisplay = false).trouble())
    }

    // as it has always read, for a restaurant that has the display
    @Test
    fun aPrinterThatDidNotAnswerWithADisplay() {
        assertEquals(
            "$failed The order is on the kitchen display. Print it again from More once the printer answers.",
            SaveResult(2, listOf(failed, "another")).trouble(),
        )
        // the takeaway board names the order and gives no advice about More
        assertEquals("$failed A-12 is on the kitchen display.", SaveResult(2, listOf(failed)).trouble("A-12", again = false))
    }

    @Test
    fun aPrinterThatDidNotAnswerWithoutADisplay() {
        assertEquals("$failed Print it again from More once the printer answers.", SaveResult(2, listOf(failed), onDisplay = false).trouble())
        assertEquals(failed, SaveResult(2, listOf(failed), onDisplay = false).trouble("A-12", again = false))
    }

    // nothing failed to print: there is nothing to print again, only a category to tick
    @Test
    fun itemsThatWentToNoPrinter() {
        assertEquals(nowhere, SaveResult(1, emptyList(), nowhere, onDisplay = false).trouble())
    }

    @Test
    fun both() {
        assertEquals(
            "$failed Print it again from More once the printer answers. $nowhere",
            SaveResult(2, listOf(failed), nowhere, onDisplay = false).trouble(),
        )
    }
}

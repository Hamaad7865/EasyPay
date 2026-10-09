package com.restopos.core.print

import com.restopos.core.print.BluetoothMatch.Paired
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// A Bluetooth printer is found among what is paired with the tablet, by the
// name or the address typed in the back office.
class BluetoothMatchTest {
    private val paired = listOf(
        Paired("JBL Speaker", "11:22:33:44:55:66"),
        Paired("MPT-II", "00:11:22:AA:BB:CC", printer = true),
        Paired("Netum Scanner", "AA:AA:AA:AA:AA:01"),
    )

    @Test fun byTheNameTheTabletShowsWhateverTheCapitals() {
        assertEquals("00:11:22:AA:BB:CC", BluetoothMatch.pick("MPT-II", paired)?.address)
        assertEquals("00:11:22:AA:BB:CC", BluetoothMatch.pick("  mpt-ii ", paired)?.address)
    }

    @Test fun byItsAddressHoweverItIsWritten() {
        assertEquals("MPT-II", BluetoothMatch.pick("00:11:22:aa:bb:cc", paired)?.name)
        assertEquals("MPT-II", BluetoothMatch.pick("00-11-22-AA-BB-CC", paired)?.name)
        assertTrue(BluetoothMatch.isAddress("00:11:22:AA:BB:CC"))
        assertFalse(BluetoothMatch.isAddress("MPT-II"))
        assertFalse(BluetoothMatch.isAddress("192.168.1.50"))
    }

    @Test fun whatIsNotPairedIsNotFound() {
        assertNull(BluetoothMatch.pick("Printer001", paired))
        assertNull(BluetoothMatch.pick("00:11:22:AA:BB:DD", paired))
        assertNull(BluetoothMatch.pick("MPT-II", emptyList()))
    }

    // Two printers of one model carry the same name: the one that says it is
    // a printer comes before a device that only shares the name, and the
    // address tells two real printers apart.
    @Test fun twoOfTheSameName() {
        val two = listOf(Paired("MPT-II", "00:00:00:00:00:01"), Paired("MPT-II", "00:00:00:00:00:02", printer = true))
        assertEquals("00:00:00:00:00:02", BluetoothMatch.pick("MPT-II", two)?.address)
        assertEquals("00:00:00:00:00:01", BluetoothMatch.pick("00:00:00:00:00:01", two)?.address)
    }

    @Test fun withNothingTypedTheOnlyPairedPrinterIsIt() {
        assertEquals("MPT-II", BluetoothMatch.pick("", paired)?.name)
        assertEquals("MPT-II", BluetoothMatch.pick(null, paired)?.name)
        // two printers and nothing to choose by: neither
        assertNull(BluetoothMatch.pick("", paired + Paired("POS-58", "00:00:00:00:00:09", printer = true)))
    }
}

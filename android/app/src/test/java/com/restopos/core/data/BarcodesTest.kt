package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// EasyPay's own barcodes, made on a tablet that works on its own as the
// server makes them. The figures are those of the server's suite (catalog,
// C10 and the settings page): a label printed from either scans the same.
class BarcodesTest {
    @Test fun the_check_digit_is_the_published_one() {
        assertEquals("4006381333931", Barcodes.ean13("400638133", 393))
        assertEquals("2000000000015", Barcodes.ean13("200", 1))
        assertEquals("2000000000022", Barcodes.ean13("200", 2))
        assertEquals("2000000000107", Barcodes.ean13("200", 10))
    }

    @Test fun a_serial_that_has_outgrown_the_prefix_is_refused_not_cut_short() {
        assertEquals("2009999999997", Barcodes.ean13("200", 999_999_999))
        assertNull(Barcodes.ean13("200", 1_000_000_000))
        assertNull(Barcodes.ean13("200", -1))
        assertNull(Barcodes.ean13("", 1))
        assertNull(Barcodes.ean13("20a", 1))
    }

    @Test fun the_serial_of_one_of_ours_and_of_no_other_code() {
        assertEquals(1L, Barcodes.serial("2000000000015"))
        assertEquals(999_999_999L, Barcodes.serial("2009999999997"))
        // a wrong check digit, another prefix, another length, letters, nothing
        assertNull(Barcodes.serial("2000000000016"))
        assertNull(Barcodes.serial("6091234500017"))
        assertNull(Barcodes.serial("20000000015"))
        assertNull(Barcodes.serial("20000000000A5"))
        assertNull(Barcodes.serial(null))
    }
}

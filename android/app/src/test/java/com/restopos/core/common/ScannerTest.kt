package com.restopos.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// What counts as a scan: a burst of keys ending in Enter. A person typing the
// same digits is not one, however the digits read.
class ScannerTest {
    private fun type(text: String, gap: Long, from: Long): Pair<String?, Long> {
        var at = from
        text.forEach { c -> assertNull(Scanner.key(c.code, false, at)); at += gap }
        return Scanner.key(0, true, at) to at
    }

    @Test fun a_fast_burst_ending_in_enter_is_a_scan() {
        val (code, _) = type("5449000000996", gap = 8, from = 10_000)
        assertEquals("5449000000996", code)
    }

    @Test fun someone_typing_is_not_a_scan() {
        val (code, _) = type("5449000000996", gap = 180, from = 20_000)
        assertNull(code)
    }

    @Test fun enter_on_its_own_or_after_a_few_keys_is_not_a_scan() {
        assertNull(Scanner.key(0, true, 30_000))
        val (code, _) = type("12", gap = 5, from = 31_000)
        assertNull(code)
    }

    @Test fun a_scan_after_slow_typing_carries_only_what_was_scanned() {
        val (_, at) = type("ab", gap = 300, from = 40_000)
        // the scanner starts a moment after the last key someone typed
        var t = at + 500
        "12345678".forEach { c -> Scanner.key(c.code, false, t); t += 6 }
        assertEquals("12345678", Scanner.key(0, true, t))
    }

    @Test fun two_scans_in_a_row_do_not_run_together() {
        val (first, at) = type("11112222", gap = 6, from = 50_000)
        val (second, _) = type("33334444", gap = 6, from = at + 400)
        assertEquals("11112222", first)
        assertEquals("33334444", second)
    }
}

// A scanner added on the tablet (Settings, Scanners): its keys are scans
// wherever a screen takes scans, and Settings is told which device a scan
// came from.
class AddedScannerTest {
    @org.junit.After fun tidy() { Scanner.mode = false; Scanner.taking = false; Scanner.added = emptySet(); Scanner.stopListening() }

    @Test fun an_added_scanner_is_taken_without_scan_mode_where_a_screen_takes_scans() {
        Scanner.added = setOf("scanner-a")
        Scanner.taking = true
        org.junit.Assert.assertTrue(Scanner.takes("scanner-a"))
        // a keyboard that was not added types as always
        org.junit.Assert.assertFalse(Scanner.takes("keyboard-b"))
        org.junit.Assert.assertFalse(Scanner.takes(null))
    }

    @Test fun nothing_is_taken_where_no_screen_takes_scans() {
        Scanner.added = setOf("scanner-a")
        Scanner.taking = false
        Scanner.mode = true
        org.junit.Assert.assertFalse(Scanner.takes("scanner-a"))
        org.junit.Assert.assertFalse(Scanner.takes("keyboard-b"))
    }

    @Test fun scan_mode_takes_every_real_keyboard_as_before() {
        Scanner.taking = true
        Scanner.mode = true
        org.junit.Assert.assertTrue(Scanner.takes("keyboard-b"))
        org.junit.Assert.assertTrue(Scanner.takes(null))
    }

    @Test fun settings_hears_each_device_apart() {
        // two devices typing at once do not run into one code
        var at = 1_000L
        "6091".forEach { assertNull(Scanner.listen("a", it.code, false, at)); at += 5 }
        "777".forEach { assertNull(Scanner.listen("b", it.code, false, at)); at += 5 }
        "2345".forEach { assertNull(Scanner.listen("a", it.code, false, at)); at += 5 }
        assertEquals("60912345", Scanner.listen("a", 0, true, at))
        assertEquals("777", Scanner.listen("b", 0, true, at + 5))
        // an Enter with nothing before it is not a code
        assertNull(Scanner.listen("a", 0, true, at + 10))
    }

    @Test fun the_list_is_kept_as_text_and_read_back() {
        val one = AddedScanner("k1", "Netum Bluetooth", "bluetooth")
        val two = AddedScanner("k2", "USB Barcode Scanner", "usb")
        val kept = AddedScanners.write(AddedScanners.with(AddedScanners.with(emptyList(), one), two))
        assertEquals(listOf(one, two), AddedScanners.read(kept))
        assertEquals("Bluetooth", one.joined)
        assertEquals("USB", two.joined)
        // the same device added again is one scanner, with what it is called now
        val again = AddedScanners.with(AddedScanners.read(kept), AddedScanner("k1", "Netum NT-1228BL", "bluetooth"))
        assertEquals(listOf("k2", "k1"), again.map { it.key })
        assertEquals("Netum NT-1228BL", again.last().name)
        assertEquals(listOf(two), AddedScanners.without(AddedScanners.read(kept), "k1"))
        // a list that cannot be read is no list, not a till that will not start
        assertEquals(emptyList<AddedScanner>(), AddedScanners.read("not a list"))
        assertEquals(emptyList<AddedScanner>(), AddedScanners.read(null))
    }
}

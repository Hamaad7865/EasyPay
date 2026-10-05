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

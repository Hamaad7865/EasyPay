package com.restopos.core.sync

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// When a till asks the server for news without being asked to. The database
// is paid for by the hour it is awake, and it sleeps five minutes after the
// last thing said to it: a till that asks every 15 minutes all night keeps it
// awake a third of the night for nothing. So it asks only while someone is at
// it, and never leaves a sale waiting.
class QuietTest {
    private val min = 60_000L
    private val noon = 1_800_000_000_000L // a moment; only the differences matter

    @Test fun a_sync_someone_asked_for_always_goes() {
        // the till opening, a sale just sent, the key by the clock: however long it has been left alone
        assertTrue(Quiet.syncs(asked = true, waiting = false, now = noon, lastUse = null))
        assertTrue(Quiet.syncs(asked = true, waiting = false, now = noon, lastUse = noon - 600 * min))
    }

    @Test fun sales_waiting_to_go_up_always_go() {
        // a sale made with no network, then the shop shut: it must not wait for tomorrow's first touch
        assertTrue(Quiet.syncs(asked = false, waiting = true, now = noon, lastUse = noon - 600 * min))
        assertTrue(Quiet.syncs(asked = false, waiting = true, now = noon, lastUse = null))
    }

    @Test fun while_someone_is_at_the_till_it_checks_in() {
        assertTrue(Quiet.syncs(asked = false, waiting = false, now = noon, lastUse = noon))
        assertTrue(Quiet.syncs(asked = false, waiting = false, now = noon, lastUse = noon - 14 * min))
        assertTrue(Quiet.syncs(asked = false, waiting = false, now = noon, lastUse = noon - 29 * min))
    }

    @Test fun left_alone_for_half_an_hour_it_stops_asking() {
        assertFalse(Quiet.syncs(asked = false, waiting = false, now = noon, lastUse = noon - 30 * min))
        assertFalse(Quiet.syncs(asked = false, waiting = false, now = noon, lastUse = noon - 9 * 60 * min)) // overnight
    }

    @Test fun a_till_no_one_has_touched_does_not_ask() {
        // just updated, or the app was put away: nothing says anyone is at it
        assertFalse(Quiet.syncs(asked = false, waiting = false, now = noon, lastUse = null))
    }

    @Test fun a_clock_set_back_is_not_someone_at_the_till() {
        // the touch is "in the future": the tablet's clock was changed, and that proves nothing
        assertFalse(Quiet.syncs(asked = false, waiting = false, now = noon, lastUse = noon + 5 * min))
    }

    @Test fun the_first_touch_after_it_was_left_alone_catches_up() {
        // prices changed overnight are there when the shop opens
        assertTrue(Quiet.back(now = noon, lastUse = noon - 30 * min))
        assertTrue(Quiet.back(now = noon, lastUse = noon - 9 * 60 * min))
        assertTrue(Quiet.back(now = noon, lastUse = noon + 5 * min)) // after the clock was set back, too
    }

    @Test fun a_touch_while_it_is_in_use_starts_nothing() {
        assertFalse(Quiet.back(now = noon, lastUse = noon - 1000))
        assertFalse(Quiet.back(now = noon, lastUse = noon - 29 * min))
        // the first touch since the till opened: opening it has synced already
        assertFalse(Quiet.back(now = noon, lastUse = null))
    }

    @Test fun a_touch_is_written_down_once_a_minute_at_most() {
        // a busy service is hundreds of touches a minute; the tablet's storage hears of one
        assertTrue(Quiet.notes(now = noon, noted = null))
        assertFalse(Quiet.notes(now = noon, noted = noon - 1000))
        assertFalse(Quiet.notes(now = noon, noted = noon - 59_000))
        assertTrue(Quiet.notes(now = noon, noted = noon - min))
        assertTrue(Quiet.notes(now = noon, noted = noon + 5 * min)) // the clock went back: write it again
    }

    @Test fun what_is_written_down_is_never_too_old_to_keep_a_till_in_use_awake() {
        // written once a minute, read against half an hour: a till being used is always seen as in use
        assertTrue(Quiet.NOTE_EVERY_MS * 2 < Quiet.AFTER_MS)
        assertTrue(Quiet.syncs(asked = false, waiting = false, now = noon, lastUse = noon - Quiet.NOTE_EVERY_MS))
    }
}

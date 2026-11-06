package com.restopos.core.sync

import com.restopos.core.data.PosSettings
import com.restopos.core.sync.OfficeClear.Step
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// Delete all transactions in the back office (server 0155) deletes every
// receipt, order and day on the server and writes when into the settings
// (`cleared`). The pull never says what was deleted, so a till kept them in
// its Receipts until it was signed out. Now a till that sees a `cleared` it
// has not acted on empties what it rang up and pulls again from nothing.
class OfficeClearTest {
    private val at = "2026-11-06T09:12:40.118+00:00"

    @Test fun the_settings_carry_when_the_office_cleared() {
        assertEquals(at, PosSettings.parse("""{"plan":"premium","cleared":"$at"}""").cleared)
        assertNull(PosSettings.parse("""{"plan":"premium"}""").cleared)
        assertNull(PosSettings.parse("""{"cleared":""}""").cleared)
    }

    @Test fun nothing_cleared_in_the_office_changes_nothing() {
        assertEquals(Step.NONE, OfficeClear.step(cleared = null, applied = null, alone = false, fromStart = false, pending = 0, refused = 0))
    }

    @Test fun a_clear_the_till_has_acted_on_is_not_done_twice() {
        assertEquals(Step.NONE, OfficeClear.step(cleared = at, applied = at, alone = false, fromStart = false, pending = 0, refused = 0))
    }

    @Test fun a_new_clear_empties_the_till() {
        // the shop that went live today: its tablet still listed the test receipts
        assertEquals(Step.CLEAR, OfficeClear.step(cleared = at, applied = null, alone = false, fromStart = false, pending = 0, refused = 0))
        // a second Delete all transactions, later
        assertEquals(Step.CLEAR, OfficeClear.step(cleared = "2026-12-01T08:00:00+00:00", applied = at, alone = false, fromStart = false, pending = 0, refused = 0))
    }

    @Test fun a_till_filled_from_nothing_only_notes_it() {
        // set up after the clear: what it pulled is what the server has now
        assertEquals(Step.NOTE, OfficeClear.step(cleared = at, applied = null, alone = false, fromStart = true, pending = 0, refused = 0))
    }

    @Test fun a_sale_still_to_go_up_is_sent_first() {
        // emptied now, the sale would be on no list until it reached the server; sent first, the pull brings it back
        assertEquals(Step.WAIT, OfficeClear.step(cleared = at, applied = null, alone = false, fromStart = false, pending = 1, refused = 0))
        // a refused change is looked at first (Settings, Rejected changes), as signing out asks
        assertEquals(Step.WAIT, OfficeClear.step(cleared = at, applied = null, alone = false, fromStart = false, pending = 0, refused = 2))
    }

    @Test fun a_tablet_that_works_on_its_own_keeps_its_sales() {
        // its receipts are on no server: nothing the office deleted was its
        assertEquals(Step.NONE, OfficeClear.step(cleared = at, applied = null, alone = true, fromStart = false, pending = 0, refused = 0))
    }

    // What is emptied is Go live's list of what was rung up, but for the
    // guest orders (they come from the relay, not the server), the back
    // office's requests (the server keeps them, with what was done of them)
    // and the till's log of price changes (no sale's).
    @Test fun it_empties_what_go_live_empties_but_three() {
        val src = File("src/main/java/com/restopos/core/database/GoLive.kt").readText()
        fun calls(fn: String): Set<String> {
            val body = Regex("suspend fun $fn\\(\\) \\{(.*?)\\n    \\}", RegexOption.DOT_MATCHES_ALL).find(src)?.groupValues?.get(1)
                ?: error("no $fn in GoLive.kt")
            return Regex("(\\w+)\\(\\)").findAll(body).map { it.groupValues[1] }.toSet()
        }
        val golive = calls("clearRungUp")
        val office = calls("clearDeletedInOffice")
        assertEquals(golive - setOf("guestOrders", "requests", "tillLog"), office - setOf("paymentLog"))
        assertTrue("the payment corrections the office deleted go from the till's log", "paymentLog" in office)
    }
}

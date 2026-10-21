package com.restopos.core.mra

import com.restopos.core.database.MraCounts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

// What the strip under the top bar says of the MRA.
class MraBannerTest {
    private val now = 1_761_040_000_000L
    private val mu = ZoneOffset.ofHours(4)
    private fun counts(waiting: Int = 0, oldest: Long? = null) = MraCounts(waiting, 0, 0, oldest, null)

    @Test fun aTillNotOnTheMraSaysNothing() = assertNull(MraBanner.say(false, false, null, null, counts(), now, mu))

    @Test fun aRefusedLoginIsRed() {
        val s = MraBanner.say(true, true, "Invalid User", null, counts(), now, mu)!!
        assertTrue(s.red); assertTrue(s.text.startsWith("The MRA refused this till's login")); assertTrue(s.text.endsWith("Settings, MRA."))
    }

    @Test fun aTillWithNoLoginIsRed() = assertTrue(MraBanner.say(true, false, null, null, counts(), now, mu)!!.red)

    @Test fun aRequestRefusedWholeSaysWhy() =
        assertTrue(MraBanner.say(true, true, null, "ERR0020: Missing request headers", counts(), now, mu)!!.text.contains("ERR0020"))

    @Test fun invoicesWaitingOverAnHourAreAmber() {
        assertNull(MraBanner.say(true, true, null, null, counts(3, now - 10 * 60_000), now, mu))
        val s = MraBanner.say(true, true, null, null, counts(3, now - 2 * 3_600_000), now, mu)!!
        assertEquals(false, s.red)
        assertTrue(s.text, s.text.startsWith("3 invoices are waiting for the MRA since "))
    }

    // the MRA turned off with invoices still waiting: they still go, and it is said
    @Test fun whatWaitsAfterTheMraIsTurnedOff() =
        assertTrue(MraBanner.say(false, true, null, null, counts(1, now - 2 * 3_600_000), now, mu)!!.text.startsWith("1 invoice is waiting"))
}

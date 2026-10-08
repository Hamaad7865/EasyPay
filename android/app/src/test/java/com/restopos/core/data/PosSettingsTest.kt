package com.restopos.core.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Which restaurants have the premium screens: the kitchen display and
// bookings. A till that cannot tell must not show them: the server would
// refuse what they send.
class PosSettingsTest {
    @Test
    fun premiumAndTrialHaveThem() {
        assertTrue(PosSettings.parse("""{"plan":"premium"}""").premium)
        assertTrue(PosSettings.parse("""{"plan":" Trial "}""").premium)
    }

    @Test
    fun standardAndUnknownDoNot() {
        assertFalse(PosSettings.parse("""{"plan":"standard"}""").premium)
        assertFalse(PosSettings.parse("""{"plan":"free"}""").premium)
        assertFalse(PosSettings.parse("{}").premium)
        assertFalse(PosSettings.parse(null).premium)
        assertFalse(PosSettings.parse("not json").premium)
    }

    // the plan sits beside what the settings already held, and takes nothing from it
    @Test
    fun thePlanLeavesTheOtherSettingsAlone() {
        val s = PosSettings.parse("""{"plan":"premium","servicePct":10,"onePrinter":true}""")
        assertTrue(s.premium)
        assertTrue(s.onePrinter)
        assertTrue(s.servicePct == 10)
    }
}

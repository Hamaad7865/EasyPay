package com.restopos.core.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Which restaurants have the premium screens: the kitchen display and
// bookings. Once the server knows about plans (0085) every restaurant's
// settings name one, and the till goes by it. Settings that name none are
// from a server that does not know yet: the till shows what it always showed.
class PosSettingsTest {
    @Test
    fun premiumAndTrialHaveThem() {
        assertTrue(PosSettings.parse("""{"plan":"premium"}""").premium)
        assertTrue(PosSettings.parse("""{"plan":" Trial "}""").premium)
    }

    @Test
    fun anyOtherPlanDoesNot() {
        assertFalse(PosSettings.parse("""{"plan":"standard"}""").premium)
        assertFalse(PosSettings.parse("""{"plan":"free"}""").premium)
        assertFalse(PosSettings.parse("""{"plan":"gold"}""").premium)
        assertFalse(PosSettings.parse("""{"plan":""}""").premium)
    }

    // A new build installed before the server was told about plans must not
    // take the two screens away from every restaurant on the day it arrives.
    @Test
    fun settingsThatNameNoPlanAreAsBefore() {
        assertTrue(PosSettings.parse("{}").premium)
        assertTrue(PosSettings.parse("""{"servicePct":10}""").premium)
        assertTrue(PosSettings.parse(null).premium)
        assertTrue(PosSettings.parse("not json").premium)
        assertTrue(PosSettings().premium)
    }

    // the plan sits beside what the settings already held, and takes nothing from it
    @Test
    fun thePlanLeavesTheOtherSettingsAlone() {
        val s = PosSettings.parse("""{"plan":"premium","servicePct":10,"onePrinter":true}""")
        assertTrue(s.premium)
        assertTrue(s.onePrinter)
        assertTrue(s.servicePct == 10)
    }

    // The first-run set-up (server 0089). Only a client made since carries the
    // mark: settings with none are a client that was there before, or a server
    // that does not know of it, and such a client is never shown the set-up.
    @Test
    fun theSetUpIsOpenOnlyWhenTheSettingsSaySo() {
        assertTrue(PosSettings.parse("""{"setup":"open"}""").setupOpen)
        assertFalse(PosSettings.parse("""{"setup":"done"}""").setupOpen)
        assertFalse(PosSettings.parse("""{"plan":"standard"}""").setupOpen)
        assertFalse(PosSettings.parse(null).setupOpen)
        assertFalse(PosSettings().setupOpen)
    }
}

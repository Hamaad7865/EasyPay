package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

// A shop's return policy in its settings (server 0109): three keys, each
// with a default when missing or out of range; a restaurant refunds whatever
// the keys say.
class ReturnSettingsTest {
    @Test
    fun aShopWithNothingSaidIsExchangeOnly() {
        val s = PosSettings.parse("""{"businessType":"retail"}""")
        assertEquals("exchange", s.returns); assertEquals(7, s.returnDays); assertEquals(6, s.noteMonths)
    }

    @Test
    fun theKeysAreRead() {
        val s = PosSettings.parse("""{"businessType":"retail","returns":"credit","returnDays":14,"noteMonths":0}""")
        assertEquals("credit", s.returns); assertEquals(14, s.returnDays); assertEquals(0, s.noteMonths)
        assertEquals("refund", PosSettings.parse("""{"businessType":"retail","returns":"refund"}""").returns)
    }

    @Test
    fun whatIsOutOfRangeFallsBack() {
        val s = PosSettings.parse("""{"businessType":"retail","returns":"maybe","returnDays":900,"noteMonths":-1}""")
        assertEquals("exchange", s.returns); assertEquals(7, s.returnDays); assertEquals(6, s.noteMonths)
    }

    @Test
    fun aRestaurantRefundsAsItAlwaysDid() {
        assertEquals("refund", PosSettings.parse("""{"businessType":"restaurant","returns":"exchange"}""").returns)
        assertEquals("refund", PosSettings.parse("{}").returns)
    }
}

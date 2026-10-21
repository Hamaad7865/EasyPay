package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// What a till is told of the MRA (server 0116, 0132).
class PosSettingsMraTest {
    @Test fun aTillThatWasToldNothingIsNotOnTheMra() {
        val s = PosSettings.parse("{}")
        assertEquals("off", s.mra)
        assertFalse(s.mraOn)
        assertNull(s.mraConnect)
        assertEquals(PosSettings.MraSeller(), s.mraSeller)
    }

    @Test fun trainingAndLiveSend_settingUpDoesNot() {
        assertTrue(PosSettings.parse("""{"mra":"training"}""").mraOn)
        assertTrue(PosSettings.parse("""{"mra":"live"}""").mraOn)
        assertFalse(PosSettings.parse("""{"mra":"setting_up"}""").mraOn)
        assertEquals("off", PosSettings.parse("""{"mra":"LIVE"}""").mra)
    }

    @Test fun theSellerAndTheConnection() {
        val s = PosSettings.parse(
            """{"mra":"live","mra_seller":{"legal_name":"Made Up Ltd","tan":"12345678","nature":"goods"},
               "mra_connect":{"url":"https://vfisc.mra.mu","certificate":"-----BEGIN CERTIFICATE-----x-----END CERTIFICATE-----"}}""",
        )
        assertEquals(PosSettings.MraSeller("Made Up Ltd", "12345678", "goods"), s.mraSeller)
        assertEquals("https://vfisc.mra.mu", s.mraConnect?.url)
    }

    @Test fun aConnectionWithoutItsKeyIsNone() {
        assertNull(PosSettings.parse("""{"mra_connect":{"url":"https://vfisc.mra.mu"}}""").mraConnect)
        assertNull(PosSettings.parse("""{"mra_connect":null}""").mraConnect)
    }
}

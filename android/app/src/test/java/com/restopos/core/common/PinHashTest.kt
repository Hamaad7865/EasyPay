package com.restopos.core.common

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// The hash below was produced by the back office (web/lib/pin.ts, hashPin)
// for PIN 4821 with the salt 00 01 .. 0f. If the two sides ever disagree, no
// one can sign in at a till, so this must keep passing.
class PinHashTest {
    private val fromBackOffice = "pbkdf2-sha256\$20000\$AAECAwQFBgcICQoLDA0ODw==\$jyZbP0DudYp2xv+E2RMPsoZM4RqbccH9HZw/lvr/MDQ="

    @Test
    fun theRightPinMatches() {
        assertTrue(PinHash.matches("4821", fromBackOffice))
    }

    @Test
    fun aWrongPinDoesNot() {
        assertFalse(PinHash.matches("4822", fromBackOffice))
        assertFalse(PinHash.matches("", fromBackOffice))
    }

    @Test
    fun noHashOrAnotherFormatNeverMatches() {
        assertFalse(PinHash.matches("4821", null))
        assertFalse(PinHash.matches("4821", "4821"))
        assertFalse(PinHash.matches("4821", "pbkdf2-sha256\$20000\$not base64\$x"))
        assertFalse(PinHash.matches("4821", "bcrypt\$20000\$AAECAwQFBgcICQoLDA0ODw==\$jyZbP0DudYp2xv+E2RMPsoZM4RqbccH9HZw/lvr/MDQ="))
    }
}

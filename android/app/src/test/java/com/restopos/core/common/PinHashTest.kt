package com.restopos.core.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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

    // A PIN set on the tablet (the first-run set-up, server 0089) is hashed
    // here and only the hash is sent. It has to be the hash the back office
    // would have made, or the next till to check it would refuse the PIN.
    @Test
    fun aHashIsMadeAsTheBackOfficeMakesIt() {
        assertEquals(fromBackOffice, PinHash.make("4821", ByteArray(16) { it.toByte() }))
        // web/lib/pin.ts, hashPin("1234", Buffer.alloc(16, 7))
        assertEquals(
            "pbkdf2-sha256\$20000\$BwcHBwcHBwcHBwcHBwcHBw==\$e9J4dc709SPTq5CLB1eFvtyPhs9JnBATLVf107XfVaI=",
            PinHash.make("1234", ByteArray(16) { 7 }),
        )
    }

    @Test
    fun aMadeHashIsTheOneTheTillChecksAndNoTwoAreAlike() {
        val h = PinHash.make("0420")
        assertTrue(PinHash.matches("0420", h))
        assertFalse(PinHash.matches("0421", h))
        assertNotEquals(h, PinHash.make("0420"))
        // the shape the server takes (0089, pin_hash_ok)
        assertTrue(h, Regex("""^pbkdf2-sha256\$20000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$""").matches(h))
    }

    @Test
    fun aPinIsFourDigits() {
        assertTrue(PinHash.isPin("0007"))
        listOf("", "123", "12345", "12a4", "١٢٣٤", " 123").forEach { assertFalse(it, PinHash.isPin(it)) }
    }
}

package com.restopos.feature.pay

import org.junit.Assert.assertEquals
import org.junit.Test

// A bill paid in parts of any amount. The owner: "one customer total is 175 he
// wants to pay 100 by cash and 75 by juice".
class PayPartsTest {
    // Shares taken on a bill split between guests, then an item came off and
    // the bill is now no more than what was taken. The money is in the drawer:
    // it becomes the receipt, what is over the bill is given back from the
    // last shares, and nothing is thrown away.
    @Test
    fun sharesOverTheBillAreTrimmedFromTheLast() {
        // 3 x 100.00 taken, the bill is now 250.00: the last share keeps 50.00, 50.00 goes back
        assertEquals(listOf(10000L to 0L, 10000L to 0L, 5000L to 5000L), PayParts.covering(listOf(10000, 10000, 10000), 25000))
        // the bill is now 150.00: the last share goes back whole and the second gives 50.00
        assertEquals(listOf(10000L to 0L, 5000L to 5000L, 0L to 10000L), PayParts.covering(listOf(10000, 10000, 10000), 15000))
    }

    @Test
    fun sharesThatCoverTheBillExactlyStayAsTheyAre() {
        assertEquals(listOf(10000L to 0L, 7500L to 0L), PayParts.covering(listOf(10000, 7500), 17500))
    }

    @Test
    fun byAmountThisPaymentIsWhatWasTypedAndThenTheRest() {
        // 175.00, of which 100.00 now
        assertEquals(10000, PayParts.amount("amount", remaining = 17500, guestsLeft = 2, picked = 0, piece = 10000))
        // the 75.00 left, with nothing typed for it
        assertEquals(7500, PayParts.amount("amount", remaining = 7500, guestsLeft = 2, picked = 0, piece = 0))
    }

    @Test
    fun aPartIsNeverMoreThanWhatRemains() {
        assertEquals(7500, PayParts.amount("amount", remaining = 7500, guestsLeft = 2, picked = 0, piece = 10000))
        assertEquals(7500, PayParts.amount("amount", remaining = 7500, guestsLeft = 2, picked = 0, piece = 7500))
        assertEquals(0, PayParts.piece(10000, remaining = 7500))
        assertEquals(0, PayParts.piece(7500, remaining = 7500))
        assertEquals(0, PayParts.piece(0, remaining = 7500))
        assertEquals(5000, PayParts.piece(5000, remaining = 7500))
    }

    @Test
    fun theOtherWaysOfPayingAreAsTheyWere() {
        assertEquals(17500, PayParts.amount("full", remaining = 17500, guestsLeft = 2, picked = 0, piece = 10000))
        assertEquals(8750, PayParts.amount("equal", remaining = 17500, guestsLeft = 2, picked = 0, piece = 10000))
        assertEquals(17500, PayParts.amount("equal", remaining = 17500, guestsLeft = 0, picked = 0, piece = 0))
        assertEquals(6000, PayParts.amount("items", remaining = 17500, guestsLeft = 2, picked = 6000, piece = 10000))
    }

    @Test
    fun thePadTypesRupeesAndTwoDecimals() {
        fun type(vararg keys: String) = keys.fold("") { t, k -> PayParts.key(t, k) }
        assertEquals("100", type("1", "0", "0"))
        assertEquals("100.5", type("1", "0", "0", ".", "5"))
        assertEquals("100.55", type("1", "0", "0", ".", "5", "5", "5"))
        assertEquals("0.5", type(".", "5"))
        assertEquals("5", type("0", "5"))
        assertEquals("10", type("1", "0", "0", "del"))
        assertEquals("", type("del"))
        assertEquals("1.", type("1", ".", "."))
        assertEquals("1234567", type("1", "2", "3", "4", "5", "6", "7", "8"))
    }

    @Test
    fun whatWasTypedIsReadInCents() {
        assertEquals(10000, PayParts.cents("100"))
        assertEquals(10050, PayParts.cents("100.5"))
        assertEquals(10055, PayParts.cents("100.55"))
        assertEquals(50, PayParts.cents("0.5"))
        assertEquals(100, PayParts.cents("1."))
        assertEquals(0, PayParts.cents(""))
    }
}

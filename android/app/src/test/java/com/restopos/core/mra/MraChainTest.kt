package com.restopos.core.mra

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// A till's chains: merged by the higher counter, as the server merges them (0132).
class MraChainTest {
    private val a = Chained("20261021 10:00:00", "50.00", "C1", "S-T1-000001")
    private val b = Chained("20261021 11:00:00", "60.00", "C1", "S-T1-000002")

    @Test fun aNewTillHasNoChain() {
        assertNull(MraChain.last("{}", "STD"))
        assertNull(MraChain.last(null, "STD"))
        assertNull(MraChain.last("not json", "STD"))
    }

    @Test fun theLastOfATypeIsKeptWithItsCounter() {
        val c = MraChain.with("{}", "STD", 1, a)
        assertEquals(1L to a, MraChain.last(c, "STD"))
        assertNull(MraChain.last(c, "TRN"))
    }

    @Test fun aLaterInvoiceTakesItsPlaceAndAnEarlierOneDoesNot() {
        val c = MraChain.with(MraChain.with("{}", "STD", 1, a), "STD", 3, b)
        assertEquals(3L to b, MraChain.last(c, "STD"))
        assertEquals(3L to b, MraChain.last(MraChain.with(c, "STD", 2, a), "STD"))
    }

    // the server's chain after a reinstall, or this till's own: whichever is further on, type by type
    @Test fun twoChainsMergeTypeByType() {
        val mine = MraChain.with(MraChain.with("{}", "STD", 4, b), "TRN", 1, a)
        val server = MraChain.with(MraChain.with("{}", "STD", 2, a), "CRN", 5, b)
        val m = MraChain.merge(mine, server)
        assertEquals(4L to b, MraChain.last(m, "STD"))
        assertEquals(1L to a, MraChain.last(m, "TRN"))
        assertEquals(5L to b, MraChain.last(m, "CRN"))
    }
}

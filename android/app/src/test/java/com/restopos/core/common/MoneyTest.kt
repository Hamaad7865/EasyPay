package com.restopos.core.common

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

// A bill split evenly: the shares must add up to the bill exactly, or the
// receipt would not match its payments and be flagged.
class MoneyTest {
    @After
    fun reset() { Money.decimals = 2 }

    private fun shares(total: Long, ways: Int): List<Long> {
        val out = ArrayList<Long>()
        var left = total
        for (w in ways downTo 1) { val s = Money.share(left, w); out.add(s); left -= s }
        return out
    }

    @Test
    fun evenSharesAddUpAndTheLastTakesTheRemainder() {
        assertEquals(listOf(25000L, 25000L, 25000L, 25000L), shares(100000, 4))
        // Rs 100 in three: 33.33, 33.34 (half of what is left, rounded), 33.33
        val three = shares(10000, 3)
        assertEquals(10000L, three.sum())
        assertEquals(3333L, three[0])
        assertEquals(listOf(10000L), shares(10000, 1))
    }

    @Test
    fun withNoDecimalsEachShareIsAWholeRupee() {
        Money.decimals = 0
        val three = shares(100000, 3) // Rs 1,000 in three
        assertEquals(100000L, three.sum())
        assertEquals(33300L, three[0])
        assertEquals(0L, three[0] % 100)
        assertEquals(0L, three[1] % 100)
        // the last one takes what is left, whatever it is
        assertEquals(100000L - three[0] - three[1], three[2])
    }

    @Test
    fun aShareIsNeverNothingAndNeverMoreThanWhatIsLeft() {
        Money.decimals = 0
        // Rs 2 between five: a rupee, a rupee, then nothing is left
        assertEquals(100L, Money.share(200, 5))
        assertEquals(0L, Money.share(0, 3))
        Money.decimals = 2
        assertEquals(1L, Money.share(2, 5))
        assertEquals(50L, Money.share(50, 1))
    }
}

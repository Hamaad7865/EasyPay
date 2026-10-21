package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoyaltyRulesTest {
    @Test fun `a sale earns the percentage of what it comes to, never rounded up`() {
        assertEquals(300L, LoyaltyRules.earned(30000, 100))
        assertEquals(99L, LoyaltyRules.earned(9999, 100))
        assertEquals(750L, LoyaltyRules.earned(30000, 250))
        assertEquals(0L, LoyaltyRules.earned(0, 100))
        assertEquals(0L, LoyaltyRules.earned(-500, 100))
        assertEquals(0L, LoyaltyRules.earned(30000, 0))
    }

    @Test fun `a business in whole rupees earns whole rupees`() {
        assertEquals(100L, LoyaltyRules.earned(15000, 100, decimals = 0)) // Rs 1.50 earned is Rs 1
        assertEquals(150L, LoyaltyRules.earned(15000, 100, decimals = 1))
        assertEquals(0L, LoyaltyRules.earned(9900, 100, decimals = 0))
    }

    @Test fun `the most that can be used is the balance, never more than the bill`() {
        assertEquals(300L, LoyaltyRules.most(500, 300))
        assertEquals(200L, LoyaltyRules.most(200, 300))
        assertEquals(0L, LoyaltyRules.most(-50, 300))
        assertEquals(0L, LoyaltyRules.most(500, 0))
        assertEquals(200L, LoyaltyRules.most(250, 300, decimals = 0))
    }

    @Test fun `a refund takes its share of the points, rounded half up`() {
        // one toy of three
        assertEquals(100L, LoyaltyRules.share(300, 10000, 30000, last = false, left = 300))
        // 98 earned, half given back: 49
        assertEquals(49L, LoyaltyRules.share(98, 5000, 10000, last = false, left = 98))
        // 99 earned, a third back: 33
        assertEquals(33L, LoyaltyRules.share(99, 10000, 30000, last = false, left = 99))
        // 100, a third: 33.33 to 33; two thirds: 66.67 to 67
        assertEquals(67L, LoyaltyRules.share(100, 20000, 30000, last = false, left = 100))
    }

    @Test fun `the refund that completes the sale takes what is left exactly`() {
        assertEquals(200L, LoyaltyRules.share(300, 20000, 30000, last = true, left = 200))
        assertEquals(67L, LoyaltyRules.share(100, 10000, 30000, last = true, left = 67))
    }

    @Test fun `a refund never takes more than is left, nor below nothing`() {
        assertEquals(50L, LoyaltyRules.share(300, 30000, 30000, last = false, left = 50))
        assertEquals(0L, LoyaltyRules.share(0, 10000, 30000, last = true, left = 0))
        assertEquals(0L, LoyaltyRules.share(300, 10000, 0, last = false, left = 300))
        assertEquals(0L, LoyaltyRules.share(300, 10000, 30000, last = false, left = -20))
    }

    @Test fun `a card number is EP and ten digits, never a product's barcode`() {
        val r = java.util.Random(7)
        repeat(50) {
            val n = LoyaltyRules.newCard(r)
            assertTrue(n, Regex("EP\\d{10}").matches(n))
            assertTrue(LoyaltyRules.isCard(n))
        }
        assertFalse(LoyaltyRules.isCard("2000000000017"))
        assertFalse(LoyaltyRules.isCard("EP123"))
        assertEquals("EP0123456789", LoyaltyRules.cleanCard(" ep0123456789 "))
        assertEquals("", LoyaltyRules.cleanCard("   "))
    }

    @Test fun `the percentage back as typed`() {
        assertEquals("1", LoyaltyRules.percent(100))
        assertEquals("2.5", LoyaltyRules.percent(250))
        assertEquals("0.05", LoyaltyRules.percent(5))
        assertEquals("100", LoyaltyRules.percent(10000))
    }

    @Test fun `the settings are off until switched on, 1 percent by default`() {
        val none = PosSettings.parse("{}")
        assertFalse(none.loyalty)
        assertEquals(100, none.loyaltyBp)
        val on = PosSettings.parse("""{"loyalty":"on","loyaltyBp":250}""")
        assertTrue(on.loyalty)
        assertEquals(250, on.loyaltyBp)
        assertEquals(100, PosSettings.parse("""{"loyalty":"on","loyaltyBp":0}""").loyaltyBp)
        assertEquals(100, PosSettings.parse("""{"loyaltyBp":10001}""").loyaltyBp)
    }

    @Test fun `the tablet keeps its own loyalty settings until they have gone up`() {
        assertTrue(com.restopos.core.sync.OwnSettings.WRITES["settings.save"]!!.containsAll(listOf("loyalty", "loyaltyBp")))
    }

    @Test fun `a balance the server sends to a tablet alone keeps the tablet's points`() {
        val own = com.restopos.core.database.CustomerEntity("c1", "t", "Anjali", points = 1250, card = "EP0000000001")
        val sent = com.restopos.core.database.CustomerEntity("c1", "t", "Anjali B", phone = "5555", points = 0, card = "EP0000000009")
        val got = com.restopos.core.sync.Fetched.customer(own, sent)
        assertEquals(1250L, got.points)
        assertEquals("Anjali B", got.name)
        assertEquals("EP0000000009", got.card)
        assertEquals(0L, com.restopos.core.sync.Fetched.customer(null, sent).points)
    }

    @Test fun `points are said as rupees`() {
        com.restopos.core.common.Money.decimals = 2
        assertEquals("Rs 12.50", LoyaltyRules.say(1250))
        assertEquals("-Rs 3.00", LoyaltyRules.say(-300))
    }
}

package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class PromotionRulesTest {
    private val day = 24L * 3600 * 1000
    private val now = 2_000_000_000_000L

    @Test fun `never below cost, a real reduction, a cost known`() {
        assertNull(PromotionRules.check(12000, 35000, 25000))
        assertEquals(true, PromotionRules.check(12000, 35000, 11000)!!.startsWith("Below cost"))
        assertEquals(true, PromotionRules.check(12000, 35000, 35000)!!.startsWith("Must be lower"))
        assertEquals(true, PromotionRules.check(null, 35000, 25000)!!.startsWith("Set a cost"))
        assertNull(PromotionRules.reduceCheck(12000, 25000, 19900))
        assertEquals(true, PromotionRules.reduceCheck(12000, 25000, 25000)!!.startsWith("Must be lower than the promotion"))
    }

    @Test fun `what breaks even after VAT`() {
        assertEquals(13800L, PromotionRules.breakEven(12000, 1500, included = true))
        assertNull(PromotionRules.breakEven(12000, 0, included = true))
        assertNull(PromotionRules.breakEven(12000, 1500, included = false))
        assertNotNull(PromotionRules.warn(12000, 1500, true, 13000))
        assertNull(PromotionRules.warn(12000, 1500, true, 14000))
    }

    @Test fun `slow movers and promotions that still do not sell`() {
        val tee = PromotionRules.Line("tee", "", 2000, now - 40 * day, null, false)
        val mug = PromotionRules.Line("mug", "", 5000, now - 40 * day, now - 7 * day, false)
        val hat = PromotionRules.Line("hat", "", 0, now - 40 * day, null, false)
        val fresh = PromotionRules.Line("fresh", "", 1000, now - 3 * day, null, false)
        val promoted = PromotionRules.Line("promo", "", 1000, now - 40 * day, null, true, appliedAt = now - 20 * day)
        val slow = PromotionRules.slowMovers(listOf(mug, tee, hat, fresh, promoted), now, 30)
        assertEquals(listOf("tee"), slow.map { it.itemId })
        assertEquals(40, PromotionRules.daysIdle(tee, now))
        assertEquals(listOf("fresh"), PromotionRules.slowMovers(listOf(fresh), now, 3).map { it.itemId })
        assertEquals(emptyList<String>(), PromotionRules.slowMovers(listOf(fresh), now, 4).map { it.itemId })
        assertEquals(listOf("promo"), PromotionRules.stale(listOf(tee, promoted), now, 14).map { it.itemId })
        assertEquals(emptyList<String>(), PromotionRules.stale(listOf(promoted), now, 30).map { it.itemId })
    }
}

package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

class AccountRulesTest {
    private val o1 = AccountRules.Owing("b1", "2026-09-01", 30000)
    private val o2 = AccountRules.Owing("b2", "2026-09-20", 15000)
    private val o3 = AccountRules.Owing("b3", "2026-10-10", 10000)

    @Test fun `numbers count on from the highest this till has`() {
        assertEquals("S1-T1-A000001", AccountRules.next("S1", "T1", emptyList()))
        assertEquals("S1-T1-A000013", AccountRules.next("S1", "T1", listOf("S1-T1-A000012", "S1-T1-A000003", "S1-T2-A000099")))
    }

    @Test fun `a payment fills the oldest bills first`() {
        assertEquals(listOf("b1" to 30000L, "b2" to 5000L), AccountRules.split(35000, listOf(o3, o2, o1)))
    }

    @Test fun `all the bills ticked, paid in full`() {
        assertEquals(listOf("b1" to 30000L, "b2" to 15000L, "b3" to 10000L), AccountRules.split(55000, listOf(o1, o2, o3)))
    }

    @Test fun `a part payment on one bill leaves the rest of it`() {
        assertEquals(listOf("b2" to 100L), AccountRules.split(100, listOf(o2)))
    }

    @Test fun `bills that owe nothing are passed over, more than is owed is not put anywhere`() {
        val paid = AccountRules.Owing("b0", "2026-08-01", 0)
        val over = AccountRules.Owing("bx", "2026-08-02", -500)
        assertEquals(listOf("b3" to 10000L), AccountRules.split(20000, listOf(paid, over, o3)))
    }

    @Test fun `on the same day by id, so two tills split alike`() {
        val a = AccountRules.Owing("a", "2026-10-01", 100)
        val b = AccountRules.Owing("b", "2026-10-01", 100)
        assertEquals(listOf("a" to 100L, "b" to 50L), AccountRules.split(150, listOf(b, a)))
    }

    @Test fun `what stops a payment`() {
        assertEquals("Tick the bills the customer is paying", AccountRules.payError(100, 0))
        assertEquals("Type how much", AccountRules.payError(0, 100))
        assertEquals("That is more than the bills ticked come to", AccountRules.payError(101, 100))
        assertNull(AccountRules.payError(100, 100))
    }

    @Test fun `a return comes off the bill first, never below nothing`() {
        assertEquals(10000L, AccountRules.offBill(10000, 30000))
        assertEquals(5000L, AccountRules.offBill(10000, 5000))
        assertEquals(0L, AccountRules.offBill(10000, 0))
        assertEquals(0L, AccountRules.offBill(10000, -2000))
    }

    @Test fun `ages and buckets`() {
        val today = LocalDate.parse("2026-10-17")
        assertEquals(46L, AccountRules.age("2026-09-01", today))
        assertEquals(0L, AccountRules.age("2026-10-20", today))
        assertEquals(true, AccountRules.overdue("2026-09-01", 30, today))
        assertEquals(false, AccountRules.overdue("2026-09-17", 30, today))
        assertEquals(listOf(25000L, 30000L, 0L, 700L), AccountRules.aged(listOf(o1, o2, o3, AccountRules.Owing("old", "2026-01-01", 700)), today))
    }
}

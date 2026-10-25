package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

// What the till says when the day cannot be closed yet: a restaurant is told
// of its orders, a shop of its sales, each named as the till shows it, with
// what is still to pay on it. Star Grill, 2026-10-25: "1 order is still
// unpaid" named nothing, the cashier found only the empty Quick sale on the
// register, and cancelled orders until the day closed.
class UnpaidTextTest {
    private val c07 = UnpaidOrder("a", "Quick sale C-07", 59_000)
    private val t4 = UnpaidOrder("b", "Table 4", 120_000)
    private val a02 = UnpaidOrder("c", "Takeaway A-02", 9_000)

    @Test
    fun aRestaurantIsToldWhichOrder() {
        assertEquals(
            "Quick sale C-07 (Rs 590.00) is still unpaid. Take payment for it, or void it, before closing the day.",
            unpaidText(listOf(c07), shop = false),
        )
        assertEquals(
            "3 orders are still unpaid: Quick sale C-07 (Rs 590.00), Table 4 (Rs 1,200.00), Takeaway A-02 (Rs 90.00). Take payment for them, or void them, before closing the day.",
            unpaidText(listOf(c07, t4, a02), shop = false),
        )
    }

    @Test
    fun aShopIsToldWhichSaleAndWhereTheyAre() {
        val sale = UnpaidOrder("a", "Sale C-07", 59_000)
        assertEquals(
            "Sale C-07 (Rs 590.00) is still unpaid, on the screen or under Parked. Take payment for it, or clear it, before closing the day.",
            unpaidText(listOf(sale), shop = true),
        )
        assertEquals(
            "2 sales are still unpaid, on the screen or under Parked: Sale C-07 (Rs 590.00), Sale C-08 (Rs 90.00). Take payment for them, or clear them, before closing the day.",
            unpaidText(listOf(sale, UnpaidOrder("b", "Sale C-08", 9_000)), shop = true),
        )
    }

    @Test
    fun aLongListNamesTheFirstFourAndCountsTheRest() {
        val six = (1..6).map { UnpaidOrder("$it", "Quick sale C-0$it", 10_000) }
        assertEquals(
            "6 orders are still unpaid: Quick sale C-01 (Rs 100.00), Quick sale C-02 (Rs 100.00), Quick sale C-03 (Rs 100.00), Quick sale C-04 (Rs 100.00) and 2 more. Take payment for them, or void them, before closing the day.",
            unpaidText(six, shop = false),
        )
    }

    @Test
    fun anOrderIsCalledWhatTheTillShows() {
        // a counter order by its number, after Quick sale (Sale in a shop)
        assertEquals("Quick sale C-07", unpaidLabel("counter", null, "C-07", null, null, "Quick sale"))
        assertEquals("Sale C-07", unpaidLabel("counter", "Counter", "C-07", null, null, "Sale"))
        // another type by its own name
        assertEquals("Takeaway A-02", unpaidLabel("takeaway", "Takeaway", "A-02", null, null, "Quick sale"))
        // a table's by the table
        assertEquals("Table 4", unpaidLabel("dine", "Dine-in", null, "4", null, "Quick sale"))
        assertEquals("Terrace", unpaidLabel("dine", "Dine-in", null, "Terrace", null, "Quick sale"))
        // and the name it was given after it
        assertEquals("Takeaway A-02 · Ravi", unpaidLabel("takeaway", "Takeaway", "A-02", null, "Ravi", "Quick sale"))
        // one with nothing to go by is still said
        assertEquals("Quick sale", unpaidLabel("counter", null, null, null, " ", "Quick sale"))
    }
}

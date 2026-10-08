package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

// What the till says when the day cannot be closed yet: a restaurant is told
// of its orders, a shop of its sales.
class UnpaidTextTest {
    @Test
    fun aRestaurantIsToldOfItsOrdersAsBefore() {
        assertEquals("1 order is still unpaid. Take payment for it, or void it, before closing the day.", unpaidText(1, shop = false))
        assertEquals("3 orders are still unpaid. Take payment for them, or void them, before closing the day.", unpaidText(3, shop = false))
    }

    @Test
    fun aShopIsToldOfItsSalesAndWhereTheyAre() {
        assertEquals("1 sale is still unpaid, on the screen or under Parked. Take payment for it, or clear it, before closing the day.", unpaidText(1, shop = true))
        assertEquals("3 sales are still unpaid, on the screen or under Parked. Take payment for them, or clear them, before closing the day.", unpaidText(3, shop = true))
    }
}

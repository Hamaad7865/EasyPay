package com.restopos.core.data

import com.restopos.core.data.DocLines.Line
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// An order or a delivery being typed is kept on the tablet as text until it
// is sent: what is read back is what was written, and text that cannot be
// read is no draft.
class StockDraftsTest {
    private val lines = listOf(Line("item-a", "", 12000, 4500), Line("item-b", "variant-m", 1500, 0))

    @Test fun `an order comes back as it was written`() {
        val o = OrderForm.Order("order-1", "supplier-1", "2026-10-20", "Call \"Devi\" first\nbefore noon", lines)
        assertEquals(o, StockDrafts.order(StockDrafts.write(o)))
        // nothing picked yet is still a draft
        val bare = OrderForm.Order("order-2")
        assertEquals(bare, StockDrafts.order(StockDrafts.write(bare)))
    }

    @Test fun `a delivery comes back as it was written`() {
        val d = DeliveryForm.Delivery("delivery-1", "order-1", "supplier-1", "2026-10-10", "INV-88", "Two boxes \"damp\"", lines)
        assertEquals(d, StockDrafts.delivery(StockDrafts.write(d)))
        val loose = DeliveryForm.Delivery("delivery-2", null, null, "2026-10-11")
        assertEquals(loose, StockDrafts.delivery(StockDrafts.write(loose)))
    }

    @Test fun `what cannot be read is no draft`() {
        assertNull(StockDrafts.order(null))
        assertNull(StockDrafts.order(""))
        assertNull(StockDrafts.order("not json"))
        assertNull(StockDrafts.order("""{"supplier":"x"}"""))
        assertNull(StockDrafts.delivery("""{"id":"d","lines":[{"item":"a"}]}"""))
        // an order's text is not a delivery
        assertNull(StockDrafts.delivery(StockDrafts.write(OrderForm.Order("order-1", lines = lines))))
    }
}

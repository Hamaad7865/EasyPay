package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Test

// The expected figures are the ones the server stored for the same sales in
// db/tests (phase2, receipt-deltas, refund-shares). If the till and the server
// disagree by a cent, the receipt is flagged for review, so these must match.
class CalcTest {
    private val vatIncluded = listOf(Calc.TaxRate(1500, "included"))

    @Test
    fun includedVatIsExtractedNotAdded() {
        // 2 x Rs 50 and 1 x Rs 50, VAT inside the price
        val t = Calc.totals(listOf(Calc.Line(10000, vatIncluded), Calc.Line(5000, vatIncluded)), emptyList())
        assertEquals(15000, t.subtotal)
        assertEquals(1956, t.tax)
        assertEquals(15000, t.total)
    }

    @Test
    fun modifierIsChargedOncePerLine() {
        // 2 x Rs 380 with one Rs 40 modifier
        val base = Calc.lineAmount(38000, 2000) + 4000
        val t = Calc.totals(listOf(Calc.Line(base, vatIncluded)), emptyList())
        assertEquals(80000, t.subtotal)
        assertEquals(10435, t.tax)
        assertEquals(80000, t.total)
    }

    @Test
    fun discountThenServiceCharge() {
        // Rs 800 + Rs 90, 10% discount, 10% service
        val t = Calc.totals(
            listOf(Calc.Line(80000, vatIncluded), Calc.Line(9000, vatIncluded)),
            listOf(Calc.Discount(10, 10)),
            servicePct = 1000,
        )
        assertEquals(89000, t.subtotal)
        assertEquals(8900, t.discount)
        assertEquals(listOf(8900L), t.discountAmounts)
        assertEquals(8010, t.service)
        assertEquals(10448, t.tax)
        assertEquals(88110, t.total)
    }

    @Test
    fun addedTaxGoesOnTop() {
        val t = Calc.totals(listOf(Calc.Line(10000, listOf(Calc.TaxRate(1500, "added")))), emptyList())
        assertEquals(1500, t.tax)
        assertEquals(11500, t.total)
    }

    @Test
    fun discountNeverExceedsTheSubtotal() {
        val t = Calc.totals(listOf(Calc.Line(5000, vatIncluded)), listOf(Calc.Discount(null, 9000)))
        assertEquals(5000, t.discount)
        assertEquals(0, t.total)
    }

    @Test
    fun fractionalQuantityRoundsHalfUp() {
        // 0.5 kg at Rs 99.99 per kg: 4999.5 cents rounds to 5000
        assertEquals(5000, Calc.lineAmount(9999, 500))
    }
}

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

    // A line's add-ons are added as stored: what each adds to the whole line.
    // (A sale rung up before 0123, as here, stored one Rs 40 for 2 x Rs 380.)
    @Test
    fun aLinesAddOnsAreAddedAsStored() {
        // 2 x Rs 380 with one Rs 40 modifier
        val base = Calc.lineAmount(38000, 2000) + 4000
        val t = Calc.totals(listOf(Calc.Line(base, vatIncluded)), emptyList())
        assertEquals(80000, t.subtotal)
        assertEquals(10435, t.tax)
        assertEquals(80000, t.total)
    }

    // The owner, 2026-10-18: a burger at Rs 100 with an egg at Rs 20, two of
    // them, is 120 + 120, not 200 + 20. An add-on is for every one of the item.
    @Test
    fun anAddOnIsChargedForEveryOneOfTheItem() {
        val egg = Calc.addonForLine(2000, 2000)
        assertEquals(4000, egg)
        assertEquals(24000, Calc.lineAmount(10000, 2000) + egg)
        // three sausages at Rs 50 on each of two grillades: six
        assertEquals(30000, Calc.addonForLine(3 * 5000, 2000))
        // one of the item: what it was
        assertEquals(2000, Calc.addonForLine(2000, 1000))
    }

    // + or − on a line rings it up again: what the add-on costs for one of the item is kept
    @Test
    fun aQuantityChangeKeepsWhatAnAddOnCostsForOne() {
        assertEquals(2000, Calc.addonPerOne(4000, 2000))
        assertEquals(6000, Calc.addonForLine(Calc.addonPerOne(4000, 2000), 3000))
        assertEquals(2000, Calc.addonPerOne(2000, 1000))
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

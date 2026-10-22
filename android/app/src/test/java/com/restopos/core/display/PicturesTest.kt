package com.restopos.core.display

import com.restopos.core.data.Calc
import org.junit.Assert.assertEquals
import org.junit.Test

// What the customer reads on the display for an order: every line as it was
// rung up, every figure the receipt will have, and figures that add up.
class PicturesTest {
    private val vat15in = listOf(Calc.TaxRate(1500, "included"))
    private val vat15on = listOf(Calc.TaxRate(1500, "added"))
    // two burgers with an egg (Rs 100 + Rs 20 each), and a cola
    private val burgers = Pictures.Rung(2000, "Burger", "Egg", 24000, unit = 10000, listed = null)
    private val cola = Pictures.Rung(1000, "Cola", "", 5000, unit = 5000, listed = null)
    private val base = Picture(lang = "en", decimals = 2, business = "Star Grill", message = "Ask about our lunch deal")

    private fun included(lines: List<Calc.Line>, discounts: List<Calc.Discount> = emptyList(), service: Int = 0): Long =
        Calc.totals(lines.map { l -> l.copy(taxes = l.taxes.filter { it.type == "included" }) }, discounts, service).tax

    // while nothing is paid yet: gross − discount + VAT added + service + rounding = left
    private fun addsUp(p: Picture) = assertEquals(p.left, p.gross - p.discount + p.vatAdded + p.service + p.rounding - p.paid)

    @Test
    fun aSaleWithVatIncluded() {
        val lines = listOf(Calc.Line(24000, vat15in), Calc.Line(5000, vat15in))
        val t = Calc.totals(lines, emptyList())
        val p = Pictures.sale("Sale", listOf(burgers, cola), t, included(lines), null, 0, 0, base = base)
        assertEquals(Picture.SALE, p.state)
        assertEquals(listOf(PicLine("2", "Burger", "Egg", 24000, 10000, 0), PicLine("1", "Cola", "", 5000, 5000, 0)), p.lines)
        assertEquals(listOf(PicSum("Subtotal", 29000), PicSum("VAT included", t.tax)), p.sums)
        assertEquals(29000, p.total)
        assertEquals(29000, p.left)
        assertEquals(0, p.paid)
        // the figures block: nothing taken off, the VAT inside the prices
        assertEquals(29000, p.gross)
        assertEquals(0, p.discount)
        assertEquals(t.tax, p.vat)
        assertEquals(0, p.vatAdded)
        assertEquals(3, p.quantity)
        addsUp(p)
        // what the business is goes with every picture
        assertEquals("Star Grill", p.business)
        assertEquals("Ask about our lunch deal", p.message)
    }

    @Test
    fun aLineDiscountShowsItsListedPriceAndPercent() {
        // a shirt listed at Rs 1,290 sold 10% off (Rs 1,161), and a scarf at its price
        val shirt = Pictures.Rung(1000, "Linen shirt", "", 116100, unit = 116100, listed = 129000)
        val scarf = Pictures.Rung(2000, "Cotton scarf", "", 118000, unit = 59000, listed = null)
        val lines = listOf(Calc.Line(116100, vat15in), Calc.Line(118000, vat15in))
        val t = Calc.totals(lines, emptyList())
        val p = Pictures.sale("Sale", listOf(shirt, scarf), t, included(lines), null, 0, 0)
        assertEquals(listOf(129000L to 10, 59000L to 0), p.lines.map { it.price to it.off })
        assertEquals(129000 + 118000L, p.gross)
        assertEquals(12900, p.discount)
        assertEquals(3, p.quantity)
        addsUp(p)
    }

    @Test
    fun aPriceRaisedAboveTheListIsNoDiscount() {
        val raised = Pictures.Rung(1000, "Cake", "", 60000, unit = 60000, listed = 50000)
        val t = Calc.totals(listOf(Calc.Line(60000, emptyList())), emptyList())
        val p = Pictures.sale("Sale", listOf(raised), t, 0, null, 0, 0)
        assertEquals(60000L to 0, p.lines[0].price to p.lines[0].off)
        assertEquals(0, p.discount)
        addsUp(p)
    }

    @Test
    fun anOrderDiscountServiceAndVatAdded() {
        val lines = listOf(Calc.Line(24000, vat15on), Calc.Line(5000, vat15on))
        val d = listOf(Calc.Discount(10, 0))
        val t = Calc.totals(lines, d, 1000)
        val p = Pictures.sale("Table 4", listOf(burgers, cola), t, included(lines, d, 1000), "Staff", 1000, 0)
        assertEquals("Table 4", p.title)
        assertEquals(
            listOf(PicSum("Subtotal", 29000), PicSum("Staff", -2900), PicSum("Service 10%", t.service), PicSum("VAT", t.tax)),
            p.sums,
        )
        assertEquals(t.total, p.total)
        assertEquals(2900, p.discount)
        assertEquals(t.tax, p.vatAdded)
        assertEquals(t.service, p.service)
        addsUp(p)
    }

    // Points used on Pay (0128) come off after the order's discount, before
    // VAT, as the receipt has them: a line of their own, the order discount
    // keeping its name, the figures adding up to what is left; and once paid,
    // the paid screen keeps the sale's lines (its total is the receipt's).
    @Test
    fun pointsUsedOnPayShowOnTheirOwnLine() {
        val lines = listOf(Calc.Line(24000, vat15on), Calc.Line(5000, vat15on))
        val d = listOf(Calc.Discount(10, 0), Calc.Discount(null, 5000))
        val t = Calc.totals(lines, d, 1000)
        val p = Pictures.sale("Table 4", listOf(burgers, cola), t, included(lines, d, 1000), "Staff", 1000, 0, points = 5000)
        assertEquals(
            listOf(PicSum("Subtotal", 29000), PicSum("Staff", -2900), PicSum("Points", -5000), PicSum("Service 10%", t.service), PicSum("VAT", t.tax)),
            p.sums,
        )
        assertEquals(2900 + 5000L, p.discount)
        assertEquals(t.total, p.left)
        addsUp(p)
        assertEquals(p.lines, Pictures.paid(t.total, 0, p).lines)
        // points alone: the one line says Points, never the word for a discount
        val alone = Calc.totals(lines, listOf(Calc.Discount(null, 5000)))
        val q = Pictures.sale("Sale", listOf(burgers, cola), alone, 0, null, 0, 0, points = 5000)
        assertEquals(listOf(PicSum("Subtotal", 29000), PicSum("Points", -5000), PicSum("VAT", alone.tax)), q.sums)
        addsUp(q)
    }

    @Test
    fun aLineDiscountAndAnOrderDiscountTogether() {
        val shirt = Pictures.Rung(1000, "Linen shirt", "", 116100, unit = 116100, listed = 129000)
        val d = listOf(Calc.Discount(null, 10000))
        val t = Calc.totals(listOf(Calc.Line(116100, vat15in)), d)
        val p = Pictures.sale("Sale", listOf(shirt), t, t.tax, "Rs 100 off", 0, 0)
        assertEquals(12900 + 10000L, p.discount)
        addsUp(p)
    }

    @Test
    fun aDiscountWithNoNameAndRounding() {
        val t = Calc.Totals(subtotal = 10050, discount = 50, tax = 0, total = 10010, rounding = 10)
        val line = Pictures.Rung(1000, "Cola", "", 10050, unit = 10050, listed = null)
        val p = Pictures.sale("Sale", listOf(line), t, 0, " ", 0, 0)
        assertEquals(listOf(PicSum("Subtotal", 10050), PicSum("Discount", -50), PicSum("Rounding", 10)), p.sums)
        assertEquals(10, p.rounding)
        addsUp(p)
    }

    @Test
    fun aSplitBillSaysWhatIsPaidAndWhatIsLeft() {
        val t = Calc.totals(listOf(Calc.Line(5000, emptyList())), emptyList())
        val p = Pictures.sale("Table 4", listOf(burgers, cola), t, 0, null, 0, paidSoFar = 24000)
        assertEquals(24000, p.paid)
        assertEquals(5000, p.left)
        assertEquals(29000, p.total)
        assertEquals(0, p.discount)
    }

    // A table with a service charge, half paid: the discount is still what was
    // taken off (nothing), never a figure made to balance the block.
    @Test
    fun aSplitBillWithServiceShowsNoDiscountOfItsOwn() {
        val unpaid = listOf(Calc.Line(5000, vat15on))
        val t = Calc.totals(unpaid, emptyList(), 1000)
        val p = Pictures.sale("Table 4", listOf(burgers, cola), t, 0, null, 1000, paidSoFar = 30360)
        assertEquals(0, p.discount)
        assertEquals(t.total, p.left)
        assertEquals(t.service, p.service)
    }

    @Test
    fun theWordsAreTheTills() {
        val w = Pictures.Words("Sous-total", "Service", "TVA incluse", "TVA", "Arrondi")
        val lines = listOf(Calc.Line(5000, vat15in))
        val t = Calc.totals(lines, emptyList())
        val p = Pictures.sale("Vente", listOf(cola), t, included(lines), null, 0, 0, w)
        assertEquals(listOf("Sous-total", "TVA incluse"), p.sums.map { it.label })
    }

    @Test
    fun anOrderWithNoLinesIsTheIdleScreen() {
        val p = Pictures.sale("Sale", emptyList(), Calc.Totals(0, 0, 0, 0), 0, null, 0, 0, base = base)
        assertEquals(Pictures.idleOf(base), p)
        assertEquals(Picture.IDLE, p.state)
    }

    @Test
    fun paidKeepsTheSaleAndShowsTheChange() {
        val lines = listOf(Calc.Line(24000, vat15in), Calc.Line(5000, vat15in))
        val t = Calc.totals(lines, emptyList())
        val sale = Pictures.sale("Sale", listOf(burgers, cola), t, included(lines), null, 0, 0, base = base)
        val p = Pictures.paid(29000, 21000, sale, base)
        assertEquals(Picture.PAID, p.state)
        assertEquals(sale.lines, p.lines)
        assertEquals(29000, p.total)
        assertEquals(50000, p.paid)
        assertEquals(21000, p.change)
        assertEquals(0, p.left)
        assertEquals("Star Grill", p.business)
    }

    // a sale paid before its picture caught up: not the last customer's lines beside this one's change
    @Test
    fun paidKeepsTheSaleOnlyWhenItIsThisSale() {
        val t = Calc.totals(listOf(Calc.Line(5000, emptyList())), emptyList())
        val earlier = Pictures.sale("Sale", listOf(cola), t, 0, null, 0, 0, base = base)
        val p = Pictures.paid(29000, 1000, earlier, base)
        assertEquals(emptyList<PicLine>(), p.lines)
        assertEquals(29000, p.total)
    }

    @Test
    fun paidWithoutItsSaleShowsTheTotalAlone() {
        val p = Pictures.paid(31500, 18500, null, base)
        assertEquals(Picture.PAID, p.state)
        assertEquals(31500, p.total)
        assertEquals(50000, p.paid)
        assertEquals(18500, p.change)
        assertEquals(emptyList<PicLine>(), p.lines)
    }

    @Test
    fun idleKeepsWhatTheBusinessIsAndNothingElse() {
        val sale = base.copy(state = Picture.SALE, title = "Sale", lines = listOf(PicLine("1", "Cola", amount = 5000)), total = 5000, gross = 5000)
        assertEquals(Picture(lang = "en", decimals = 2, business = "Star Grill", message = "Ask about our lunch deal"), Pictures.idleOf(sale))
    }

    @Test
    fun quantities() {
        assertEquals("2", Pictures.qty(2000))
        assertEquals("0.5", Pictures.qty(500))
        assertEquals("1.25", Pictures.qty(1250))
    }
}

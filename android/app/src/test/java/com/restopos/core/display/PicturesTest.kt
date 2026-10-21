package com.restopos.core.display

import com.restopos.core.data.Calc
import org.junit.Assert.assertEquals
import org.junit.Test

// What the customer reads on the display for an order: every line as it was
// rung up, every figure the receipt will have, and the total.
class PicturesTest {
    private val vat15in = listOf(Calc.TaxRate(1500, "included"))
    private val vat15on = listOf(Calc.TaxRate(1500, "added"))
    private val burgers = PicLine("2", "Burger", "Egg", 24000)
    private val cola = PicLine("1", "Cola", amount = 5000)
    private val base = Picture(lang = "en", decimals = 2, business = "Star Grill", message = "Ask about our lunch deal")

    private fun included(lines: List<Calc.Line>, discounts: List<Calc.Discount> = emptyList(), service: Int = 0): Long =
        Calc.totals(lines.map { l -> l.copy(taxes = l.taxes.filter { it.type == "included" }) }, discounts, service).tax

    @Test
    fun aSaleWithVatIncluded() {
        val lines = listOf(Calc.Line(24000, vat15in), Calc.Line(5000, vat15in))
        val t = Calc.totals(lines, emptyList())
        val p = Pictures.sale("Sale", listOf(burgers, cola), t, included(lines), null, 0, 0, base = base)
        assertEquals(Picture.SALE, p.state)
        assertEquals(listOf(burgers, cola), p.lines)
        assertEquals(listOf(PicSum("Subtotal", 29000), PicSum("VAT included", t.tax)), p.sums)
        assertEquals(29000, p.total)
        assertEquals(29000, p.left)
        assertEquals(0, p.paid)
        // what the business is goes with every picture
        assertEquals("Star Grill", p.business)
        assertEquals("Ask about our lunch deal", p.message)
    }

    @Test
    fun aDiscountByItsNameServiceAndVatAdded() {
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
    }

    @Test
    fun aDiscountWithNoNameAndRounding() {
        val t = Calc.Totals(subtotal = 10050, discount = 50, tax = 0, total = 10010, rounding = 10)
        val p = Pictures.sale("Sale", listOf(cola), t, 0, " ", 0, 0)
        assertEquals(listOf(PicSum("Subtotal", 10050), PicSum("Discount", -50), PicSum("Rounding", 10)), p.sums)
    }

    @Test
    fun aSplitBillSaysWhatIsPaidAndWhatIsLeft() {
        val t = Calc.totals(listOf(Calc.Line(5000, emptyList())), emptyList())
        val p = Pictures.sale("Table 4", listOf(burgers, cola), t, 0, null, 0, paidSoFar = 24000)
        assertEquals(24000, p.paid)
        assertEquals(5000, p.left)
        assertEquals(29000, p.total)
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
    fun paidShowsTheChange() {
        val p = Pictures.paid(31500, 18500, base)
        assertEquals(Picture.PAID, p.state)
        assertEquals(31500, p.total)
        assertEquals(50000, p.paid)
        assertEquals(18500, p.change)
        assertEquals("Star Grill", p.business)
        assertEquals(emptyList<PicLine>(), p.lines)
    }

    @Test
    fun idleKeepsWhatTheBusinessIsAndNothingElse() {
        val sale = base.copy(state = Picture.SALE, title = "Sale", lines = listOf(cola), total = 5000)
        assertEquals(Picture(lang = "en", decimals = 2, business = "Star Grill", message = "Ask about our lunch deal"), Pictures.idleOf(sale))
    }

    @Test
    fun quantities() {
        assertEquals("2", Pictures.qty(2000))
        assertEquals("0.5", Pictures.qty(500))
        assertEquals("1.25", Pictures.qty(1250))
    }
}

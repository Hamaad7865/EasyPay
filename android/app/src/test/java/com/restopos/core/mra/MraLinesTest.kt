package com.restopos.core.mra

import com.restopos.core.data.Calc
import com.restopos.core.data.RefundCalc
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

// A receipt as the MRA's lines: what the MRA is told is what the receipt says.
class MraLinesTest {
    private val seller = Seller("Made Up Ltd", "Made Up", "12345678", "C07000000", "Bel Air")
    private val vat15 = listOf(Calc.TaxRate(1500, "included"))
    private fun sale(name: String, base: Long, taxes: List<Calc.TaxRate> = vat15, qty: Int = 1000, addons: List<String> = emptyList(), code: String? = null) =
        SaleLine(name, addons, null, qty, base, taxes, code, "VAT", "GOODS")
    private fun invoice(lines: List<Line>, discount: Long = 0, type: String = "STD") =
        MraInvoice.build(MraInvoice.Input(1, "X", type, null, 0, seller, lines, "CASH", discount, ref = if (type == "CRN") "S" else "", reason = if (type == "CRN") "Back" else ""))
    private fun field(b: MraInvoice.Built, k: String) = (b.json.fields.first { it.first == k }.second as MraJson.Str).v

    @Test fun withNoDiscountTheLinesAreTheSaleItself() {
        val (lines, left) = MraLines.ofSale(listOf(sale("Chicken curry", 11500), sale("Bread", 3750, listOf(Calc.TaxRate(0, "included")), qty = 3000)), 0, 0)
        assertEquals(0L, left)
        assertEquals(listOf(0L, 0L), lines.map { it.share })
        assertEquals(listOf("TC01", "TC02"), lines.map { it.taxCode })
        assertEquals(3000, lines[1].qtyMilli)
    }

    // 10 % off Rs 115 + Rs 230: 11.50 and 23.00 on the lines, the VAT on what is left, as Calc
    @Test fun anOrderDiscountIsSpreadAsCalcSpreadsIt() {
        val sold = listOf(sale("Curry", 11500), sale("Noodles", 23000))
        val t = Calc.totals(sold.map { Calc.Line(it.base, it.taxes) }, listOf(Calc.Discount(10, 0)))
        val (lines, left) = MraLines.ofSale(sold, t.discount, t.service)
        assertEquals(listOf(1150L, 2300L), lines.map { it.share })
        assertEquals(0L, left)
        assertEquals(MraInvoice.money(t.tax), field(invoice(lines), "totalVatAmount"))
    }

    @Test fun theCentsTheSpreadLeavesAreTheInvoicesOwnDiscount() {
        val sold = listOf(sale("A", 10001), sale("B", 20002))
        val t = Calc.totals(sold.map { Calc.Line(it.base, it.taxes) }, listOf(Calc.Discount(null, 10000)))
        val (lines, left) = MraLines.ofSale(sold, t.discount, t.service)
        assertEquals(1L, left)
        assertEquals(MraInvoice.money(t.total), field(invoice(lines, left), "totalAmtPaid"))
    }

    // Any sale: the MRA's VAT is the receipt's, and what it says was paid is
    // the receipt's total before cash rounding.
    @Test fun anySaleTellsTheMraWhatTheReceiptSays() {
        val rnd = Random(20261021)
        repeat(500) { round ->
            val sold = (1..rnd.nextInt(1, 7)).map { i ->
                val tax = Calc.TaxRate(if (rnd.nextBoolean()) 1500 else 0, if (rnd.nextInt(4) == 0) "added" else "included")
                sale("L$i", rnd.nextLong(1, 60000), listOf(tax), qty = rnd.nextInt(1, 4) * 250)
            }
            val sub = sold.sumOf { it.base }
            val discounts = when (rnd.nextInt(3)) {
                0 -> emptyList()
                1 -> listOf(Calc.Discount(rnd.nextInt(1, 51), 0))
                else -> listOf(Calc.Discount(null, rnd.nextLong(1, sub + 1)))
            }
            val servicePct = if (rnd.nextBoolean()) rnd.nextInt(0, 1500) else 0
            val t = Calc.totals(sold.map { Calc.Line(it.base, it.taxes) }, discounts, servicePct)
            val (lines, left) = MraLines.ofSale(sold, t.discount, t.service)
            val b = invoice(lines, left)
            assertEquals("round $round VAT", MraInvoice.money(t.tax), field(b, "totalVatAmount"))
            assertEquals("round $round paid", MraInvoice.money(t.total), field(b, "totalAmtPaid"))
            assertTrue("round $round left", left >= 0 && left < sold.size)
        }
    }

    @Test fun theServiceChargeIsTheLastLineExemptAndAService() {
        val (lines, _) = MraLines.ofSale(listOf(sale("Curry", 11500)), 0, 1150)
        val s = lines.last()
        assertEquals(MraLines.SERVICE, s.desc); assertEquals("TC03", s.taxCode); assertEquals("SERVICES", s.nature)
        assertEquals(1000, s.qtyMilli); assertEquals(1150L, s.base); assertEquals(0, s.vatBp)
    }

    @Test fun addOnsGoInBracketsAndALongNameIsCut() {
        assertEquals("Burger (Egg, Cheese)", MraLines.desc("Burger", listOf("Egg", "Cheese")))
        assertEquals(100, MraLines.desc("x".repeat(120), emptyList()).length)
    }

    @Test fun theTaxCodeIsTheTaxsOwnElseWhatItsRateSuggests() {
        assertEquals("TC05", MraLines.code("TC05", 1500))
        assertEquals("TC01", MraLines.code(null, 1500)); assertEquals("TC02", MraLines.code(null, 0)); assertEquals("TC03", MraLines.code(null, 0, "Exempt"))
        assertEquals("TC03", MraLines.code(null, null)); assertEquals("TC01", MraLines.code(" ", 1500))
    }

    @Test fun howItWasPaid() {
        assertEquals("CREDIT", MraLines.payment(listOf("cash" to 100L, "account" to 50L)))
        assertEquals("CASH", MraLines.payment(listOf("cash" to 100L, "card" to 50L)))
        assertEquals("CARD", MraLines.payment(listOf("cash" to 50L, "card" to 100L)))
        assertEquals("CASH", MraLines.payment(listOf("cash" to 50L, "card" to 50L)))
        assertEquals("OTHER", MraLines.payment(listOf("credit_note" to 50L)))
        assertEquals("OTHER", MraLines.payment(emptyList()))
    }

    @Test fun aLineWithTwoTaxesCannotGo() {
        assertNull(MraLines.refusal(listOf(sale("Curry", 11500))))
        assertTrue(MraLines.refusal(listOf(sale("Wine", 50000, vat15 + Calc.TaxRate(500, "included"))))!!.startsWith("Wine has two taxes"))
    }

    // a refund's VAT is the refund's (RefundCalc), and what it gives back is its total before rounding
    @Test fun aRefundIsWhatTheRefundGivesBack() {
        val sold = listOf(sale("Curry", 11500), sale("Noodles", 23000, qty = 2000), sale("Cake", 9999, listOf(Calc.TaxRate(1500, "added"))))
        val t = Calc.totals(sold.map { Calc.Line(it.base, it.taxes) }, listOf(Calc.Discount(null, 3333)), 1000)
        val shares = RefundCalc.shares(sold.mapIndexed { i, l -> RefundCalc.Line("l$i", l.base, l.qtyMilli, l.taxes) }, RefundCalc.Receipt(t.subtotal, t.discount, t.service, t.rounding, t.tax, t.total))
        // one of the two noodles, and the cake
        val back = listOf(Triple(sold[1], 1000, RefundCalc.parts(shares[1], 0, 1000)), Triple(sold[2], 1000, RefundCalc.parts(shares[2], 0, 1000)))
        val parts = back.fold(RefundCalc.Parts()) { a, b -> a + b.third }
        val b = invoice(MraLines.ofRefund(back), type = "CRN")
        assertEquals(MraInvoice.money(parts.tax), field(b, "totalVatAmount"))
        assertEquals(MraInvoice.money(parts.total - parts.rnd), field(b, "totalAmtPaid"))
    }
}

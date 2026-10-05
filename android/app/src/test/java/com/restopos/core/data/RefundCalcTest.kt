package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The till's refund arithmetic against the cases the server's own tests pin
// (db/tests/refund-shares.test.cjs, refund-order-line.test.cjs). The server
// refuses a refund that is a cent off, so these are the same figures.
class RefundCalcTest {
    private val vat = listOf(Calc.TaxRate(1500, "included"))

    // 3 x Dholl puri (Rs 50) with one flat add-on (Rs 20): Rs 170 on one line
    @Test fun the_rs_170_line_comes_back_as_5667_5666_5667() {
        val line = RefundCalc.Line("a", 17000, 3000, vat)
        val s = RefundCalc.shares(listOf(line), RefundCalc.Receipt(17000, 0, 0, 0, 2217, 17000)).single()
        val each = listOf(0, 1000, 2000).map { done -> RefundCalc.parts(s, done, 1000).total }
        assertEquals(listOf(5667L, 5666L, 5667L), each)
        assertEquals(17000L, each.sum())
    }

    // a table's bill: 3, 2 and 1 of three items, 10% off, 10% service (the receipt of refund-order-line.test.cjs, with round amounts)
    private val bill = RefundCalc.Receipt(subtotal = 143000, discount = 14300, service = 12870, rounding = 0, taxTotal = 16787, total = 141570)
    private val lines = listOf(RefundCalc.Line("01-a", 90000, 3000, vat), RefundCalc.Line("02-b", 40000, 2000, vat), RefundCalc.Line("03-d", 13000, 1000, vat))

    @Test fun every_line_gets_its_share_and_the_last_takes_what_is_left() {
        val s = RefundCalc.shares(lines, bill)
        assertEquals(listOf(9000L, 4000L, 1300L), s.map { it.disc })
        assertEquals(listOf(8100L, 3600L, 1170L), s.map { it.svc })
        assertEquals(bill.subtotal, s.sumOf { it.sub })
        assertEquals(bill.discount, s.sumOf { it.disc })
        assertEquals(bill.service, s.sumOf { it.svc })
        assertEquals(bill.taxTotal, s.sumOf { it.taxIncluded + it.taxAdded })
    }

    @Test fun one_unit_of_the_first_line() {
        val a = RefundCalc.shares(lines, bill).first { it.line.id == "01-a" }
        // 30000 of the item, less 3000 of the discount, plus 2700 of the service charge
        assertEquals(29700L, RefundCalc.parts(a, 0, 1000).total)
    }

    @Test fun the_order_the_lines_are_given_in_does_not_matter() {
        val one = RefundCalc.shares(lines, bill).associate { it.line.id to it }
        val other = RefundCalc.shares(lines.reversed(), bill).associate { it.line.id to it }
        assertEquals(one, other)
    }

    @Test fun unit_by_unit_in_any_order_gives_back_the_receipt_exactly() {
        // receipts of every shape: add-ons, a discount, a service charge, rounding either way, tax added on top
        var seed = 20261006L
        fun next(n: Int): Int { seed = (seed * 1664525 + 1013904223) and 0xFFFFFFFFL; return ((seed ushr 8) % n).toInt() }
        repeat(300) {
            val made = (1..(1 + next(5))).map { i ->
                val qty = (1 + next(4)) * 1000
                val unit = (1 + next(60)) * 500L
                val mods = if (next(3) == 0) (1 + next(8)) * 250L else 0L
                val taxes = when (next(3)) { 0 -> listOf(Calc.TaxRate(1500, "added")); 1 -> vat; else -> emptyList() }
                RefundCalc.Line("%02d".format(i), Calc.lineAmount(unit, qty) + mods, qty, taxes)
            }
            val discounts = if (next(2) == 0) listOf(Calc.Discount(5 + next(30), 0)) else if (next(3) == 0) listOf(Calc.Discount(null, (1 + next(20)) * 100L)) else emptyList()
            val t = Calc.totals(made.map { Calc.Line(it.base, it.taxes) }, discounts, if (next(2) == 0) 1000 else 0, listOf(0L, -37L, 12L, 0L)[next(4)])
            val rc = RefundCalc.Receipt(t.subtotal, t.discount, t.service, t.rounding, t.tax, t.total)
            val shares = RefundCalc.shares(made, rc)
            val done = HashMap<String, Int>()
            var back = RefundCalc.Parts()
            val units = shares.flatMap { s -> List(s.line.qty / 1000) { s } }.shuffled(java.util.Random(seed))
            units.forEach { s ->
                val d = done[s.line.id] ?: 0
                val p = RefundCalc.parts(s, d, 1000)
                assertTrue("a unit never gives back less than nothing", p.total >= -40)
                back += p
                done[s.line.id] = d + 1000
            }
            assertEquals("total of case $it", rc.total, back.total)
            assertEquals("subtotal of case $it", rc.subtotal, back.sub)
            assertEquals("discount of case $it", rc.discount, back.disc)
            assertEquals("service of case $it", rc.service, back.svc)
            assertEquals("rounding of case $it", rc.rounding, back.rnd)
            assertEquals("tax of case $it", rc.taxTotal, back.tax)
        }
    }
}

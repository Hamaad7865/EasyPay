package com.restopos.core.data

import com.restopos.core.data.Reports.Pick
import com.restopos.core.data.Reports.Sale
import com.restopos.core.print.DocLine
import com.restopos.core.print.DocPayment
import com.restopos.core.print.DocTax
import com.restopos.core.print.ReceiptDoc
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId

// The till's reports as arithmetic over made-up receipts: which days a period
// is, and what each report makes of sales, refunds, discounts on a line,
// prices changed at the sale, a product sold by weight and two VAT rates.
class ReportsTest {
    private val zone = ZoneId.of("Indian/Mauritius")
    private fun at(day: Int, hour: Int, minute: Int = 0) = LocalDateTime.of(2026, 10, day, hour, minute).atZone(zone).toInstant().toEpochMilli()
    private fun line(name: String, qty: Int, amount: Long, cat: String? = null, was: Long? = null, why: String? = null) = DocLine(qty, name, amount, cat = cat, was = was, priceNote = why)
    private fun sale(id: String, at: Long, total: Long, lines: List<DocLine>, cashier: String? = "Aisha", dining: String? = null, paid: List<String> = listOf("Cash")) =
        Sale(id, "T1-$id", false, null, at, total, ReceiptDoc(number = "T1-$id", cashier = cashier, dining = dining, lines = lines, total = total, payments = paid.map { DocPayment(it, total / paid.size) }))
    private fun refund(id: String, at: Long, total: Long, lines: List<DocLine>, of: String, cashier: String? = "Ben") =
        Sale(id, "T1-$id", true, null, at, total, ReceiptDoc(kind = "refund", number = "T1-$id", cashier = cashier, lines = lines, total = total, payments = listOf(DocPayment("Cash", total)), refundOf = of))

    // Wednesday 7 October: two sales and a refund; Thursday 8: one sale by weight, by a waiter at a table.
    private val mug = line("Ceramic mug", 2000, 64000, "Home")
    private val shirt = line("Linen shirt, M", 1000, 116100, "Clothing", was = 129000, why = "10% off")
    private val jacket = line("Denim jacket", 1000, 250000, "Clothing", was = 295000, why = "Price changed")
    private val rice = line("Basmati rice", 350, 2800, "Food")
    private val s1 = sale("1", at(7, 9, 15), 180100, listOf(mug, shirt))
    private val s2 = sale("2", at(7, 14, 40), 250000, listOf(jacket), cashier = "Ben", paid = listOf("Cash", "Card"))
    private val r1 = refund("3", at(7, 16, 5), 32000, listOf(line("Ceramic mug", 1000, 32000, "Home")), of = "T1-1")
    private val s3 = sale("4", at(8, 11, 0), 2800, listOf(rice), cashier = null, dining = "Takeaway")
    private val bare = Sale("5", "T1-5", false, null, at(8, 12, 0), 5000, null) // rung up on another till: no printed record here
    private val all = listOf(s1, s2, r1, s3, bare)

    @Test fun `a period is whole days, and a week starts on Monday`() {
        val wed = LocalDate.of(2026, 10, 7)
        fun days(p: Pick, today: LocalDate = wed, a: LocalDate? = null, b: LocalDate? = null) = Reports.span(p, today, zone, a, b).let { it.first to it.last }
        assertEquals(wed to wed, days(Pick.Today))
        assertEquals(wed.minusDays(1) to wed.minusDays(1), days(Pick.Yesterday))
        assertEquals(LocalDate.of(2026, 10, 5) to wed, days(Pick.Week))
        assertEquals(LocalDate.of(2026, 10, 1) to wed, days(Pick.Month))
        assertEquals(LocalDate.of(2026, 9, 1) to LocalDate.of(2026, 9, 30), days(Pick.LastMonth))
        // on the first of a month, this month is one day and last month is whole
        val first = LocalDate.of(2026, 10, 1)
        assertEquals(first to first, days(Pick.Month, first))
        assertEquals(LocalDate.of(2026, 9, 1) to LocalDate.of(2026, 9, 30), days(Pick.LastMonth, first))
        // two dates in either order, and never past today
        assertEquals(LocalDate.of(2026, 10, 2) to LocalDate.of(2026, 10, 6), days(Pick.Custom, a = LocalDate.of(2026, 10, 6), b = LocalDate.of(2026, 10, 2)))
        assertEquals(LocalDate.of(2026, 10, 6) to wed, days(Pick.Custom, a = LocalDate.of(2026, 10, 6), b = LocalDate.of(2026, 12, 25)))
    }

    @Test fun `a period takes in its last instant and not the one before its first`() {
        val s = Reports.span(Pick.Today, LocalDate.of(2026, 10, 7), zone)
        val midnight = at(7, 0)
        // CashOps.period reads "after from, up to and with to"
        assertEquals(midnight - 1, s.from)
        assertEquals(at(8, 0) - 1, s.to)
        assertTrue(midnight > s.from && at(7, 23, 59) <= s.to && at(8, 0) > s.to)
    }

    @Test fun `a period is said as its days`() {
        fun says(a: LocalDate, b: LocalDate) = Reports.says(Reports.span(Pick.Custom, LocalDate.of(2027, 6, 1), zone, a, b))
        assertEquals("7 Oct 2026", says(LocalDate.of(2026, 10, 7), LocalDate.of(2026, 10, 7)))
        assertEquals("5 Oct to 11 Oct 2026", says(LocalDate.of(2026, 10, 5), LocalDate.of(2026, 10, 11)))
        assertEquals("28 Dec 2026 to 3 Jan 2027", says(LocalDate.of(2026, 12, 28), LocalDate.of(2027, 1, 3)))
    }

    @Test fun `a line a day, a refund against the day it was made`() {
        assertEquals(
            listOf(Reports.Day(LocalDate.of(2026, 10, 7), 2, 1, 180100 + 250000 - 32000), Reports.Day(LocalDate.of(2026, 10, 8), 2, 0, 2800 + 5000)),
            Reports.byDay(all, zone),
        )
        // a sale a minute before midnight and one a minute after are two days
        val late = listOf(sale("a", at(7, 23, 59), 100, emptyList()), sale("b", at(8, 0, 1), 200, emptyList()))
        assertEquals(listOf(100L, 200L), Reports.byDay(late, zone).map { it.net })
        assertEquals(emptyList<Reports.Day>(), Reports.byDay(emptyList(), zone))
    }

    @Test fun `sales by category, a refund taken off what it refunds`() {
        val cuts = Reports.byCategory(all)
        assertEquals(listOf("Clothing", "Home", "Food"), cuts.map { it.name })
        // two receipts sold clothing; the mug's refund takes one unit and its amount back off Home
        assertEquals(Reports.Cut("Clothing", 2, 2000, 366100, 913), cuts[0])
        assertEquals(Reports.Cut("Home", 1, 1000, 32000, 80), cuts[1])
        assertEquals(Reports.Cut("Food", 1, 350, 2800, 7), cuts[2])
        assertTrue(cuts.sumOf { it.share } in 998..1002)
        assertEquals("No category", Reports.byCategory(listOf(sale("x", at(7, 9), 100, listOf(line("Bag", 1000, 100))))).single().name)
    }

    @Test fun `sales by staff and by order type are whole receipts`() {
        val staff = Reports.byStaff(all)
        // Ben's sale less the refund he made; the receipt with nobody on it; the one with no printed record is in neither
        assertEquals(listOf("Ben" to 218000L, "Aisha" to 180100L, "Nobody signed in" to 2800L), staff.map { it.name to it.amount })
        assertEquals(listOf(1, 1, 1), staff.map { it.count })
        assertEquals(listOf("Direct sale" to 398100L, "Takeaway" to 2800L), Reports.byOrderType(all).map { it.name to it.amount })
    }

    @Test fun `products ranked by what they came to, or by how many`() {
        val byAmount = Reports.items(all, byQty = false)
        assertEquals(listOf("Denim jacket", "Linen shirt, M", "Ceramic mug", "Basmati rice"), byAmount.map { it.name })
        assertEquals(Reports.Cut("Ceramic mug", 1, 1000, 32000, 80), byAmount[2])
        // by quantity the mug and the shirt are one each, and the larger amount goes first; rice sold by weight is 0.350
        assertEquals(listOf("Denim jacket", "Linen shirt, M", "Ceramic mug", "Basmati rice"), Reports.items(all, byQty = true).map { it.name })
        assertEquals(listOf("Ceramic mug", "Linen shirt, M"), Reports.items(listOf(s1), byQty = true).map { it.name })
        assertEquals(350, byAmount.last().qty)
        // a product sold and wholly refunded in the period came to nothing, and is no row
        val back = refund("8", at(8, 15), 2800, listOf(rice), of = "T1-4")
        assertEquals(listOf("Denim jacket", "Linen shirt, M", "Ceramic mug"), Reports.items(all + back, byQty = false).map { it.name })
        assertEquals(listOf("Clothing", "Home"), Reports.byCategory(all + back).map { it.name })
    }

    @Test fun `sales by the hour, the empty hours between kept`() {
        val hours = Reports.hourly(listOf(s1, s2, r1), zone)
        assertEquals((9..16).toList(), hours.map { it.hour })
        assertEquals(Reports.Hour(9, 1, 180100), hours.first())
        assertEquals(Reports.Hour(10, 0, 0), hours[1])
        assertEquals(Reports.Hour(14, 1, 250000), hours[5])
        // a refund is no sale, and comes off its hour
        assertEquals(Reports.Hour(16, 0, -32000), hours.last())
        assertEquals(emptyList<Reports.Hour>(), Reports.hourly(emptyList(), zone))
    }

    @Test fun `every receipt, newest first, with how it was paid`() {
        val tx = Reports.transactions(all)
        assertEquals(listOf("T1-5", "T1-4", "T1-3", "T1-2", "T1-1"), tx.map { it.number })
        assertEquals("Cash + Card", tx[3].paid)
        assertEquals(true, tx[2].refund)
        assertEquals("Ben", tx[2].who)
        // a receipt with nobody on it, and one whose printed record is not here
        assertEquals(null, tx[1].who)
        assertEquals("", tx[0].paid)
    }

    @Test fun `lines sold at another price than listed`() {
        val changed = Reports.repriced(all)
        assertEquals(listOf("Denim jacket", "Linen shirt, M"), changed.map { it.product })
        assertEquals(Reports.Repriced(at(7, 14, 40), "T1-2", "2", "Denim jacket", 295000, 250000, "Price changed", "Ben"), changed[0])
        assertEquals("10% off", changed[1].why)
        // a refund of a line that had been discounted is not a price changed again
        val back = refund("9", at(8, 9), 116100, listOf(shirt), of = "T1-1")
        assertEquals(2, Reports.repriced(all + back).size)
    }

    @Test fun `refunds name the sale they refund`() {
        assertEquals(listOf(Reports.Refund("3", "T1-3", "T1-1", at(7, 16, 5), 32000, "Ben")), Reports.refunds(all))
    }

    @Test fun `a product's price changed, as the tablet wrote it down`() {
        val rows = listOf(
            Reports.Logged(at(8, 10), "Aisha", null, "mug", null, null, "32000", "35000"),
            Reports.Logged(at(8, 9), "Ben", "Aisha", "shirt", "m", null, "129000", "119000"),
            Reports.Logged(at(8, 8), "Aisha", null, "removed", null, null, "500", "600"),
            Reports.Logged(at(8, 7), "Aisha", null, "mug", null, null, "not a price", "35000"), // unreadable: left out
        )
        val names = mapOf(("mug" to null) to "Ceramic mug", ("shirt" to "m") to "Linen shirt, M")
        assertEquals(
            listOf(
                Reports.PriceChange(at(8, 10), "Ceramic mug", 32000, 35000, "Aisha", null),
                Reports.PriceChange(at(8, 9), "Linen shirt, M", 129000, 119000, "Ben", "Aisha"),
                Reports.PriceChange(at(8, 8), "A product that is gone", 500, 600, "Aisha", null),
            ),
            Reports.priceChanges(rows) { item, variant -> names[item to variant] },
        )
    }

    @Test fun `a payment corrected, as the tablet wrote it down`() {
        val rows = listOf(
            Reports.Logged(at(8, 10), "Ben", "Aisha", null, null, "r1", "Cash", "Card"),
            Reports.Logged(at(8, 9), "Aisha", null, null, null, "wiped", "Card", "Juice"),
        )
        assertEquals(
            listOf(
                Reports.Corrected(at(8, 10), "T1-1", "r1", "Cash", "Card", "Ben", "Aisha"),
                // a receipt the tablet no longer holds cannot be opened, and is still listed
                Reports.Corrected(at(8, 9), "A receipt no longer on this tablet", null, "Card", "Juice", "Aisha", null),
            ),
            Reports.corrected(rows) { if (it == "r1") "T1-1" else null },
        )
    }

    @Test fun `VAT by rate, what it was charged on worked out from it`() {
        // 15% included in 115.00 is 15.00 on 100.00
        assertEquals(listOf(Reports.TaxLine("VAT", 1500, 10000, 1500, 11500)), Reports.tax(listOf(DocTax("VAT", 1500, 1500, true)), 11500))
        // two rates, the higher first, and what is left of the sales carried none
        val two = Reports.tax(listOf(DocTax("Reduced", 500, 500, true), DocTax("VAT", 1500, 3000, true)), 23000 + 10500 + 4000)
        assertEquals(listOf("VAT" to 23000L, "Reduced" to 10500L, "No VAT" to 4000L), two.map { it.name to it.incl })
        // a rate of nothing has no line of its own: its sales are the ones with no VAT
        assertEquals(listOf(Reports.TaxLine("No VAT", 0, 5000, 0, 5000)), Reports.tax(listOf(DocTax("Zero rated", 0, 0, true)), 5000))
        // a few cents of rounding are not a sale without VAT: the line is made to add up to the sales
        assertEquals(listOf(Reports.TaxLine("VAT", 1500, 8696, 1304, 10000)), Reports.tax(listOf(DocTax("VAT", 1500, 1304, true)), 10000))
        assertEquals(emptyList<Reports.TaxLine>(), Reports.tax(emptyList(), 0))
    }
}

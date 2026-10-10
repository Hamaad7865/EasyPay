package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// One of the till's reports on the receipt printer: its title, its days, the
// till, then its lines, on narrow paper and on wide, with nothing cut.
class ReportDocTest {
    private val doc = ReportDoc(
        "Sales Summary", "5 Oct to 11 Oct 2026", "Till 1", 0L,
        listOf(
            ReportLine("Receipts", "12"),
            ReportLine("Net sales", "Rs 4,009.00", ReportLine.Kind.Total),
            ReportLine("", "", ReportLine.Kind.Rule),
            ReportLine("By payment method", kind = ReportLine.Kind.Head),
            ReportLine("Cash (9)", "3,100.00"),
            ReportLine("A payment type with a very long name that will not fit on one line (3)", "909.00"),
        ),
    )

    private fun look(columns: Int) = Docs.reportLook(doc, Shop(name = "Demo shop"), Paper(columns))

    @Test fun `it says what it is, of which days and of which till`() {
        val page = look(48)
        assertTrue(page.any { it.trim() == "SALES SUMMARY" })
        assertTrue(page.any { it.startsWith("Period") && it.endsWith("5 Oct to 11 Oct 2026") })
        assertTrue(page.any { it.startsWith("Till") && it.endsWith("Till 1") })
        assertTrue(page.any { it == "BY PAYMENT METHOD" })
        assertTrue(page.any { it.startsWith("Net sales") && it.endsWith("Rs 4,009.00") })
    }

    @Test fun `no line is wider than the paper, and a long name is wrapped, not cut`() {
        for (columns in listOf(32, 48)) {
            val page = look(columns)
            assertTrue("a line is too wide at $columns", page.all { it.length <= columns })
            // the amount sits at the end of the name's first line, and the rest of the name follows
            val at = page.indexOfFirst { it.startsWith("A payment type") }
            assertTrue(page[at].endsWith("909.00"))
            val name = (page[at].removeSuffix("909.00").trim() + " " + page.drop(at + 1).takeWhile { it.isNotBlank() }.joinToString(" ") { it.trim() }).trim()
            assertEquals("A payment type with a very long name that will not fit on one line (3)", name)
        }
    }
}

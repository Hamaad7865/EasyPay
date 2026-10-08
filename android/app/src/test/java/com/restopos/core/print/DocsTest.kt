package com.restopos.core.print

import com.restopos.core.common.Money
import com.restopos.core.data.Calc
import com.restopos.core.data.PosSettings
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.Charset

// There is no printer to look at here, so the bytes are read back: the
// commands are taken out and what is left is the paper, line by line.
class DocsTest {
    @After
    fun reset() { Money.decimals = 2 }

    // barcode: what the bars carry, and how many dots wide the thinnest is; null when none printed
    private class Paper(val lines: List<String>, val drawer: Boolean, val cut: Boolean, val raster: Boolean, val barcode: String? = null, val module: Int = 0)

    private fun read(bytes: ByteArray): Paper {
        val text = java.io.ByteArrayOutputStream()
        var drawer = false; var cut = false; var raster = false
        var barcode: String? = null; var module = 0
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i].toInt() and 0xFF
            val n = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xFF else 0
            when {
                b == 0x1B && n == 0x40 -> i += 2
                b == 0x1B && (n == 0x74 || n == 0x61 || n == 0x45) -> i += 3
                b == 0x1B && n == 0x70 -> { drawer = true; i += 5 }
                b == 0x1D && n == 0x21 -> i += 3
                b == 0x1D && n == 0x56 -> { cut = true; i += 4 }
                // a barcode: its height, its bars' width, no digits of the printer's own, then Code 128 and its data
                b == 0x1D && (n == 0x68 || n == 0x48) -> i += 3
                b == 0x1D && n == 0x77 -> { module = bytes[i + 2].toInt() and 0xFF; i += 3 }
                b == 0x1D && n == 0x6B -> {
                    assertEquals("Code 128", 73, bytes[i + 2].toInt() and 0xFF)
                    val len = bytes[i + 3].toInt() and 0xFF
                    barcode = String(bytes, i + 4, len, Charsets.US_ASCII)
                    i += 4 + len
                }
                b == 0x1D && n == 0x76 -> {
                    raster = true
                    val w = (bytes[i + 4].toInt() and 0xFF) + ((bytes[i + 5].toInt() and 0xFF) shl 8)
                    val h = (bytes[i + 6].toInt() and 0xFF) + ((bytes[i + 7].toInt() and 0xFF) shl 8)
                    i += 8 + w * h
                }
                else -> { text.write(b); i++ }
            }
        }
        return Paper(String(text.toByteArray(), Charset.forName("windows-1252")).split('\n'), drawer, cut, raster, barcode, module)
    }

    private val shop = Shop("CafeTino", "Royal Road\nCurepipe", "5 123 4567", "C12345678", "VAT27000000", "Open every day", "Thank you. See you again soon.")
    private val receipt = ReceiptDoc(
        kind = "receipt", number = "S1-T1-000128", time = 1_790_000_000_000, order = "Table 4", dining = "Dine-in", cashier = "Priya", covers = 2,
        lines = listOf(
            DocLine(2000, "Dholl puri", 12000, listOf("Achard"), "No chili"),
            DocLine(1000, "Crevettes sautées à l'ail et au beurre de la maison", 35000),
        ),
        subtotal = 47000, discounts = listOf(DocAmount("Staff 10%", 4700)),
        taxes = listOf(DocTax("VAT", 1500, 5517, true)), total = 42300,
        payments = listOf(DocPayment("Cash", 42300, 50000, 7700)),
    )

    @Test
    fun wrappingKeepsWordsWhole() {
        assertEquals(listOf("Crevettes sautées", "à l'ail"), EscPos.wrap("Crevettes sautées à l'ail", 17))
        assertEquals(listOf("abcde", "fgh"), EscPos.wrap("abcdefgh", 5))
        assertEquals(listOf("a", "b"), EscPos.wrap("a\nb", 10))
    }

    @Test
    fun aReceiptFitsBothPaperWidths() {
        for (cols in listOf(32, 48)) {
            val p = read(Docs.receipt(receipt, shop, Paper(cols, 3, true), 2))
            assertTrue("a line is wider than $cols", p.lines.all { it.length <= cols })
            assertTrue(p.cut)
            assertFalse(p.drawer)
            val all = p.lines.joinToString("\n")
            assertTrue(all.contains("CafeTino"))
            assertTrue(all.contains("BRN: C12345678"))
            assertTrue(all.contains("S1-T1-000128"))
            assertTrue(all.contains("+ Achard"))
            assertTrue(all.contains("* No chili"))
            assertTrue(all.contains("Discount: Staff 10%"))
            assertTrue(all.contains("VAT 15% (incl.)"))
            assertTrue(p.lines.any { it.startsWith("TOTAL") && it.endsWith("Rs 423.00") })
            assertTrue(p.lines.any { it.trim().startsWith("Change") && it.endsWith("77.00") })
            // accents print as written
            assertTrue(all.contains("sautées"))
            assertTrue(all.contains("Thank you"))
        }
    }

    @Test
    fun theAmountSitsAtTheEndOfItsLine() {
        val p = read(Docs.receipt(receipt, shop, Paper(32, 0, false), 2))
        val line = p.lines.first { it.startsWith("2 Dholl puri") }
        assertEquals(32, line.length)
        assertTrue(line.endsWith("120.00"))
        assertFalse(p.cut)
    }

    @Test
    fun aCashPaymentOpensTheDrawerAndABillSaysItIsNotAReceipt() {
        assertTrue(read(Docs.receipt(receipt, shop, Paper(), 2, openDrawer = true)).drawer)
        val bill = read(Docs.receipt(receipt.copy(kind = "bill", number = "", payments = emptyList()), shop, Paper(), 2)).lines.joinToString("\n")
        assertTrue(bill.contains("BILL"))
        assertTrue(bill.contains("This is not a receipt"))
        assertFalse(bill.contains("No."))
    }

    // ---- the receipt's number in bars, and what a copy says ----

    // a shop's paper: the same, with the receipt's number in bars
    private val store = shop.copy(bars = true)

    @Test
    fun aShopsReceiptAndRefundCarryTheirNumberInBarsAndABillNone() {
        // a restaurant's receipt has no bars
        assertEquals(null, read(Docs.receipt(receipt, shop, Paper(), 2)).barcode)
        val shop = store
        val sale = read(Docs.receipt(receipt, shop, Paper(), 2))
        // set B, then the number as it is
        assertEquals("{BS1-T1-000128", sale.barcode)
        // the number is under the bars in letters too, after the footer
        assertTrue(sale.lines.indexOfLast { it.trim() == "S1-T1-000128" } > sale.lines.indexOfFirst { it.contains("Thank you") })
        assertEquals("{BS1-T1-R000007", read(Docs.receipt(receipt.copy(kind = "refund", number = "S1-T1-R000007"), shop, Paper(), 2)).barcode)
        assertEquals(null, read(Docs.receipt(receipt.copy(kind = "bill", number = "", payments = emptyList()), shop, Paper(), 2)).barcode)
    }

    @Test
    fun theBarsAreAsWideAsThePaperLets() {
        // twelve characters: 167 modules. Three dots each fit 80 mm paper (576 dots), two fit 58 mm (384).
        assertEquals(167, EscPos.barcodeDots(12, 1))
        assertEquals(3, read(Docs.receipt(receipt, store, Paper(48, 3, true), 2)).module)
        assertEquals(2, read(Docs.receipt(receipt, store, Paper(32, 3, true), 2)).module)
        // a number that starts again each day is longer: on 58 mm paper only the thinnest bars fit
        assertEquals(1, EscPos.barcodeModule("S1-T1-0004-0012", 384))
        assertEquals(2, EscPos.barcodeModule("S1-T1-0004-0012", 576))
        // what set B has no character for is not put in bars, nor is nothing at all
        assertEquals(null, EscPos.barcodeModule("Café-1", 576))
        assertEquals(null, EscPos.barcodeModule("", 576))
        // and never wider than the paper
        for (n in 1..60) for (dots in listOf(384, 576)) {
            val m = EscPos.barcodeModule("X".repeat(n), dots)
            if (m != null) assertTrue(EscPos.barcodeDots(n, m) <= dots)
        }
    }

    @Test
    fun aCopySaysItIsOneAndWhatWasRefundedSince() {
        val first = read(Docs.receipt(receipt, shop, Paper(), 2)).lines.joinToString("\n")
        assertFalse(first.contains("COPY"))
        assertFalse(first.contains("REFUNDED"))
        val copy = read(Docs.receipt(receipt.copy(reprint = true), shop, Paper(), 2)).lines
        assertEquals("COPY", copy[copy.indexOf("RECEIPT") + 1])
        val all = read(Docs.receipt(receipt.copy(reprint = true, refunded = 42300, refundedAll = true), shop, Paper(), 2)).lines.joinToString("\n")
        assertTrue(all.contains("*** REFUNDED ***"))
        val part = read(Docs.receipt(receipt.copy(reprint = true, refunded = 12000), shop, Paper(32, 3, true), 2)).lines
        assertTrue(part.any { it == "*** PARTLY REFUNDED: 120.00 ***" })
        assertTrue(part.all { it.length <= 32 })
        // the marks are for the paper printed again: they are not kept with the receipt
        val json = kotlinx.serialization.json.Json { encodeDefaults = false }
        assertFalse(json.encodeToString(ReceiptDoc.serializer(), receipt).contains("reprint"))
    }

    @Test
    fun thePaperOnTheScreenIsThePaperThatPrints() {
        for (cols in listOf(32, 48)) {
            val look = Docs.receiptLook(receipt, store, Paper(cols, 3, true), 2)
            val printed = read(Docs.receipt(receipt, store, Paper(cols, 3, true), 2)).lines
            assertTrue(look.all { it.length <= cols })
            // every line of text that prints is on the screen, in the same order
            val shown = look.map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("||") }
            assertEquals(printed.map { it.trim() }.filter { it.isNotEmpty() }, shown)
            // what the printer centres is centred: the shop's name has as much room before as after, to one space
            val name = look.first { it.contains("CafeTino") }
            val before = name.length - name.trimStart().length
            assertTrue(kotlin.math.abs(before - (cols - "CafeTino".length - before)) <= 1)
            // an amount still sits at the end of its line
            assertTrue(look.any { it.startsWith("TOTAL") && it.endsWith("Rs 423.00") && it.length == cols })
            // where the bars print, the screen shows that there are bars, and no feed is left hanging under them
            assertTrue(look.any { it.trim().startsWith("||") })
            assertEquals("S1-T1-000128", look.last().trim())
        }
    }

    @Test
    fun aKitchenTicketHasNoPrices() {
        val doc = KitchenDoc("ORDER", "Table 4", 1_790_000_000_000, "Priya", "Dine-in", 2, "Birthday", receipt.lines, "Kitchen")
        val p = read(Docs.kitchen(doc, Paper(32, 2, true)))
        val all = p.lines.joinToString("\n")
        assertTrue(p.lines.all { it.length <= 32 })
        assertTrue(all.contains("KITCHEN"))
        assertTrue(all.contains("Table 4"))
        assertTrue(all.contains("2 x Dholl puri"))
        assertTrue(all.contains("+ Achard"))
        assertTrue(all.contains("! No chili"))
        assertTrue(all.contains("REMARK: Birthday"))
        assertFalse(all.contains("120.00"))
        assertFalse(all.contains("Rs"))
        val void = read(Docs.kitchen(doc.copy(title = "VOID"), Paper(32, 2, true))).lines.joinToString("\n")
        assertTrue(void.contains("VOID - KITCHEN"))
    }

    @Test
    fun aCashSlipSaysWhoWhenWhyAndHowMuch() {
        val p = read(Docs.cashSlip(CashSlipDoc("out", 70000, "Bread from the bakery", 1_790_000_000_000, "Priya", "T1"), shop, Paper(32, 3, true), 2))
        val all = p.lines.joinToString("\n")
        assertTrue(p.drawer)
        assertTrue(all.contains("CASH OUT"))
        assertTrue(all.contains("Priya"))
        assertTrue(all.contains("Reason: Bread from the bakery"))
        assertTrue(p.lines.any { it.startsWith("AMOUNT") && it.endsWith("Rs 700.00") })
    }

    @Test
    fun theDayClosingHidesTheBreakdownWhenItIsSwitchedOff() {
        val z = ZDoc(
            7, "T1", null, 1_790_000_000_000, "Priya", 12, 500000, 1, 10000, 2500, 63913,
            listOf(DocAmount("Cash", 300000, 8), DocAmount("Card", 190000, 5)), listOf(DocAmount("Drinks", 120000, 30)),
            listOf(DocTax("VAT", 1500, 63913, true)), 20000, 7000,
            listOf(CashSlipDoc("out", 7000, "Bread", 1_790_000_000_000, "Priya", "T1")), "S1-T1-000100", "S1-T1-000112",
        )
        val on = read(Docs.z(z, shop, Paper(48, 3, true), 2, detailed = true)).lines.joinToString("\n")
        val off = read(Docs.z(z, shop, Paper(48, 3, true), 2, detailed = false)).lines.joinToString("\n")
        assertTrue(on.contains("DAY CLOSING (Z) No. 7"))
        assertTrue(on.contains("BY CATEGORY"))
        assertTrue(on.contains("Drinks (30)"))
        assertFalse(off.contains("BY CATEGORY"))
        assertFalse(off.contains("Drinks"))
        for (t in listOf(on, off)) {
            assertTrue(t.contains("Cash (8)"))
            assertTrue(t.contains("CASH IN AND OUT"))
            assertTrue(t.contains("Out: Bread (Priya)"))
            assertTrue(t.lines().any { it.startsWith("TOTAL") && it.endsWith("Rs 4,900.00") })
        }
    }

    // Closing the day counts the drawer, so the one closing report carries it;
    // a closing made with no day open (a till with no PINs) has no drawer to show.
    @Test
    fun theDayClosingCarriesTheDrawerItWasClosedWith() {
        val z = ZDoc(
            8, "T1", 1_790_000_000_000, 1_790_000_300_000, "Priya", 6, 250000, 0, 0, 0, 32609,
            listOf(DocAmount("Cash", 250000, 6)), emptyList(), emptyList(), 20000, 7000, emptyList(), "S1-T1-000113", "S1-T1-000118",
        )
        val without = read(Docs.z(z, shop, Paper(48, 3, true), 2, detailed = true)).lines
        assertFalse(without.any { it.contains("CASH DRAWER") })
        assertFalse(without.any { it.startsWith("COUNTED") })
        val closed = z.copy(openedAt = 1_790_000_000_000, openedBy = "Asha", float = 100000, cashTaken = 250000, expected = 363000, counted = 362000)
        val all = read(Docs.z(closed, shop, Paper(48, 3, true), 2, detailed = true)).lines
        assertTrue(all.any { it.startsWith("Opened by") && it.endsWith("Asha") })
        assertTrue(all.any { it.contains("CASH DRAWER") })
        assertTrue(all.any { it.startsWith("Opening float") && it.endsWith("1,000.00") })
        assertTrue(all.any { it.startsWith("Expected in drawer") && it.endsWith("3,630.00") })
        assertTrue(all.any { it.startsWith("COUNTED") && it.endsWith("Rs 3,620.00") })
        assertTrue(all.any { it.startsWith("SHORT") && it.endsWith("-10.00") })
        assertTrue(all.any { it.startsWith("Signature") })
    }

    // The day so far, from the drawer's side, is the X report; once the day
    // is closed the same figures are its cash drawer report.
    @Test
    fun theDrawerReportIsTheXReportWhileTheDayIsOpen() {
        val open = ShiftDoc("T1", "Priya", 1_790_000_000_000, null, null, 100000, listOf(DocAmount("Cash", 250000, 6)),
            250000, 20000, 7000, emptyList(), 363000, null, 6, 250000, 0, 0, 0)
        val x = read(Docs.shift(open, shop, Paper(48, 3, true), 2)).lines.joinToString("\n")
        assertTrue(x.contains("X REPORT - DAY SO FAR"))
        assertFalse(x.contains("SALES PERIOD"))
        val closed = read(Docs.shift(open.copy(closedBy = "Priya", closedAt = 1_790_000_300_000, counted = 362000), shop, Paper(48, 3, true), 2)).lines.joinToString("\n")
        assertTrue(closed.contains("CASH DRAWER REPORT"))
    }

    @Test
    fun theShiftReportBalancesTheDrawer() {
        val s = ShiftDoc("T1", "Priya", 1_790_000_000_000, "Priya", 1_790_000_300_000, 100000, listOf(DocAmount("Cash", 250000, 6)),
            250000, 20000, 7000, emptyList(), 363000, 362000, 6, 250000, 0, 0, 0)
        val all = read(Docs.shift(s, shop, Paper(32, 3, true), 2)).lines
        assertTrue(all.any { it.startsWith("Expected in drawer") && it.endsWith("3,630.00") })
        assertTrue(all.any { it.startsWith("SHORT") && it.endsWith("-10.00") })
    }

    @Test
    fun amountsFollowTheDecimalsSetting() {
        assertEquals("1,250.00", Docs.num(125000, 2))
        assertEquals("1,250.0", Docs.num(125000, 1))
        assertEquals("1,250", Docs.num(125000, 0))
        assertEquals("12.3", Docs.num(1234, 1))
        assertEquals("13", Docs.num(1250, 0))
        assertEquals("-5.00", Docs.num(-500, 2))
        Money.decimals = 0
        assertEquals("Rs 1,250", Money.format(125000))
        Money.decimals = 2
        assertEquals("Rs 1,250.00", Money.format(125000))
    }

    @Test
    fun withNoDecimalsATotalIsRoundedToTheRupeeAndTheRoundingIsKept() {
        // Rs 100 less 12.5% = Rs 87.50
        val lines = listOf(Calc.Line(8750, emptyList()))
        assertEquals(8750, Calc.totalsRounded(lines, emptyList()).total)
        Money.decimals = 0
        val t = Calc.totalsRounded(lines, emptyList())
        assertEquals(8800, t.total)
        assertEquals(50, t.rounding)
        val down = Calc.totalsRounded(listOf(Calc.Line(8749, emptyList())), emptyList())
        assertEquals(8700, down.total)
        assertEquals(-49, down.rounding)
        Money.decimals = 1
        assertEquals(8750, Calc.totalsRounded(listOf(Calc.Line(8749, emptyList())), emptyList()).total)
    }

    @Test
    fun settingsThatAreMissingMeanAsBefore() {
        val none = PosSettings.parse(null)
        assertEquals(2, none.decimals)
        assertFalse(none.billReset)
        assertTrue(none.dayCloseDetailed)
        val s = PosSettings.parse("""{"decimals":0,"billNumbering":"reset","dayCloseDetailed":false,"receipt":{"header":"Hi","footer":"","logo":null,"showLogo":false},"company":{"name":"CafeTino","brn":"C1"}}""")
        assertEquals(0, s.decimals)
        assertTrue(s.billReset)
        assertFalse(s.dayCloseDetailed)
        assertEquals("Hi", s.header)
        assertEquals("", s.footer)
        assertFalse(s.showLogo)
        assertEquals("CafeTino", s.shop("Fallback").name)
        assertEquals("Fallback", PosSettings.parse("{}").shop("Fallback").name)
    }
}

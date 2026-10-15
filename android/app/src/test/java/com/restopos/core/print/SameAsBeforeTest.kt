package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Test

// EasyPay's design is the paper as it was before there was a designer: the
// same lines, each with its size, bold and alignment, and the same drawer,
// logo, bars and cut. Kept until the shared examples hold today's paper.
class SameAsBeforeTest {
    private val shop = Shop("CafeTino Royal Road Curepipe Branch", "Royal Road\nCurepipe", "5 123 4567", "C12345678", "VAT27000000", "Open every day, 10:00 to 22:00", "Thank you. See you again soon.")
    private val logo = Raster(2, 2, byteArrayOf(1, 2, 3, 4))
    private val lines = listOf(
        DocLine(2000, "Dholl puri", 10000, listOf("Achard, Chutney coco"), note = "No chili please, the guest is allergic"),
        DocLine(1000, "Briyani poulet with a long name that wraps", 35000, was = 40000, priceNote = "Price changed"),
        DocLine(500, "Fish by weight", 20000, listOf("Mayo", "2 x Lemon"), course = 2, seat = 3),
    )
    private val receipt = ReceiptDoc(
        kind = "receipt", number = "S1-T1-000128", time = 1_790_000_000_000, order = "A-05 · Ravi", dining = "Takeaway", cashier = "Priya", waiter = "Ravi", covers = 2,
        note = "Ring at the gate", lines = lines, subtotal = 65000, discounts = listOf(DocAmount("Staff", 5000)), taxes = listOf(DocTax("VAT", 1500, 7826, true), DocTax("Levy", 125, 75, false)),
        rounding = -2, total = 60073, service = 5000, customer = "Mrs Li",
        payments = listOf(DocPayment("Cash", 50000, tendered = 100000, change = 50000), DocPayment("Card", 10073, reference = "AUTH 77")),
        customerNo = "05",
    )

    private fun count(bytes: ByteArray, vararg seq: Int): Int =
        (0..bytes.size - seq.size).count { i -> seq.indices.all { j -> (bytes[i + j].toInt() and 0xFF) == seq[j] } }

    private fun same(what: String, before: EscPos, now: EscPos) {
        assertEquals("$what: lines", before.styled(), now.styled())
        assertEquals("$what: look", before.look(), now.look())
        val a = before.bytes(); val b = now.bytes()
        for (seq in listOf(intArrayOf(0x1B, 0x70), intArrayOf(0x1D, 0x56), intArrayOf(0x1D, 0x76, 0x30), intArrayOf(0x1D, 0x6B))) {
            assertEquals("$what: ${seq.joinToString { "%02X".format(it) }}", count(a, *seq), count(b, *seq))
        }
    }

    private fun receipts(): List<Pair<String, ReceiptDoc>> = listOf(
        "receipt" to receipt,
        "bill" to receipt.copy(kind = "bill", number = "", payments = emptyList()),
        "refund" to receipt.copy(kind = "refund", number = "S1-T1-R000007", refundOf = "S1-T1-000128", reason = "Cold food, sent back by the guest", customerNo = null, discounts = emptyList(), rounding = 0, service = 0),
        "share" to receipt.copy(share = 1, shares = 3, payments = listOf(DocPayment("Cash", 20025))),
        "reprint" to receipt.copy(reprint = true, refunded = 12345, refundedAll = false),
        "refunded" to receipt.copy(reprint = true, refunded = 60073, refundedAll = true),
        "plain" to ReceiptDoc(number = "S1-T1-000001", time = 1_790_000_000_000, order = "Table 4", lines = lines.take(1), subtotal = 10000, total = 10000),
    )

    @Test
    fun `every receipt prints as before on 80 and 58 mm, with a logo and the drawer`() {
        for ((what, d) in receipts()) for (cols in listOf(48, 32)) {
            val paper = Paper(cols, 3, true)
            same("$what $cols", Docs.pageBefore(d, shop, paper, 2, logo, true), Docs.receiptPage(d, shop, paper, 2, logo, true))
            same("$what $cols no logo", Docs.pageBefore(d, shop, paper, 0, null, false), Docs.receiptPage(d, shop, paper, 0, null, false))
        }
    }

    @Test
    fun `a shop's receipt prints its bars as before, and a bare business no head`() {
        val bars = shop.copy(bars = true)
        for ((what, d) in receipts()) same("shop $what", Docs.pageBefore(d, bars, Paper(32, 0, false), 2, null, false), Docs.receiptPage(d, bars, Paper(32, 0, false), 2))
        same("bare", Docs.pageBefore(receipt, Shop(), Paper(), 2, null, false), Docs.receiptPage(receipt, Shop(), Paper(), 2))
    }

    @Test
    fun `every kitchen ticket prints as before`() {
        val k = KitchenDoc("ORDER", "Ravi", 1_790_000_000_000, "Priya", "Takeaway", 2, "Tel 5 123 4567 · Ring at the gate", lines, "Kitchen", "PICK UP 18:30", "05")
        val tickets = listOf(
            "takeaway" to k,
            "nameless" to k.copy(order = ""),
            "table" to k.copy(order = "Table 4", customerNo = null, pickup = null, dining = null),
            "void" to k.copy(title = "VOID", station = "Bar", note = null, covers = null),
            "courses" to k.copy(lines = lines.mapIndexed { i, l -> l.copy(course = i + 1) }),
            "long table" to k.copy(order = "Terrace by the pool, table 12", customerNo = null),
        )
        for ((what, d) in tickets) for (cols in listOf(48, 32)) {
            same("$what $cols", Docs.kitchenBefore(d, Paper(cols, 2, true)), Docs.kitchenPage(d, Paper(cols, 2, true)))
        }
    }
}

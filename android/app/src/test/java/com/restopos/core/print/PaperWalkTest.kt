package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// What the design's settings do to the paper: how add-ons and prices show,
// Text and its variables, Line and Space.
class PaperWalkTest {
    private val shop = Shop("CafeTino")
    private val burger = DocLine(
        1000, "Burger", 30000, listOf("Cheese, Bacon"),
        addons = listOf(DocAddon("Cheese", 1, 2000), DocAddon("Bacon", 1, 3000)), unit = 25000,
    )
    private fun doc(vararg l: DocLine) = ReceiptDoc(number = "S1-T1-000128", time = 1_790_000_000_000, order = "Table 4", lines = l.toList(), subtotal = 30000, total = 30000)

    private fun items(f: (Block) -> Block) = Design(Papers.RECEIPT.blocks.map { if (it.k == "items") f(it) else it })
    private fun with(vararg more: Block) = Design(Papers.RECEIPT.blocks + more)

    // the lines between the first two rules after the head: the items
    private fun lines(d: ReceiptDoc, design: Design, cols: Int = 48): List<String> {
        val look = Docs.receiptLook(d, shop, Paper(cols, 0, false), 2, design)
        val rules = look.withIndex().filter { it.value.startsWith("----") }.map { it.index }
        return look.subList(rules[1] + 1, rules[2])
    }
    private fun row(l: String, r: String, cols: Int = 48) = l.padEnd(cols - r.length) + r

    @Test
    fun `the four looks of the add-ons`() {
        assertEquals(listOf(row("1 Burger", "300.00"), "  + Cheese, Bacon"), lines(doc(burger), Papers.RECEIPT))
        assertEquals(listOf(row("1 Burger", "250.00"), "  + Cheese 20.00, Bacon 30.00"), lines(doc(burger), items { it.copy(addonPrices = true) }))
        assertEquals(listOf(row("1 Burger", "300.00"), "  + Cheese", "  + Bacon"), lines(doc(burger.copy(mods = listOf("Cheese", "Bacon"))), items { it.copy(addons = "rows") }))
        assertEquals(listOf(row("1 Burger", "250.00"), row("  + Cheese", "20.00"), row("  + Bacon", "30.00")), lines(doc(burger), items { it.copy(addons = "rows", addonPrices = true) }))
    }

    @Test
    fun `a free add-on shows no price, and several of one say how many`() {
        val l = burger.copy(addons = burger.addons + DocAddon("No onion") + DocAddon("Egg", 3, 3000), amount = 33000)
        // on 48 columns the one line fills the paper and its last price wraps under the +
        val one = lines(doc(l), items { it.copy(addonPrices = true) })
        assertEquals(row("1 Burger", "250.00"), one[0])
        assertEquals(listOf("  + Cheese 20.00, Bacon 30.00, No onion, 3 x Egg", "  30.00"), one.drop(1))
        val rows = lines(doc(l), items { it.copy(addons = "rows", addonPrices = true) })
        assertEquals(listOf(row("  + Cheese", "20.00"), row("  + Bacon", "30.00"), "  + No onion", row("  + 3 x Egg", "30.00")), rows.drop(1))
    }

    @Test
    fun `a receipt kept from before has no add-on prices and prints the names with the line's total`() {
        val old = burger.copy(addons = emptyList(), unit = null)
        assertEquals(listOf(row("1 Burger", "300.00"), "  + Cheese, Bacon"), lines(doc(old), items { it.copy(addonPrices = true, unitPrice = true) }))
    }

    @Test
    fun `the price of one, under a line of more than one`() {
        val design = items { it.copy(unitPrice = true) }
        assertEquals(listOf(row("2 Dholl puri", "100.00"), "  2 x 50.00"), lines(doc(DocLine(2000, "Dholl puri", 10000, unit = 5000)), design))
        assertEquals(listOf(row("0.5 Fish", "200.00"), "  0.5 x 400.00"), lines(doc(DocLine(500, "Fish", 20000, unit = 40000)), design))
        assertEquals(listOf(row("1 Alouda", "90.00")), lines(doc(DocLine(1000, "Alouda", 9000, unit = 9000)), design))
        assertEquals(listOf(row("2 Alouda", "180.00")), lines(doc(DocLine(2000, "Alouda", 18000)), design))
    }

    @Test
    fun `notes and the old price can be hidden, and with prices the old price is less the add-ons`() {
        val l = burger.copy(note = "Well done", was = 35000, priceNote = "Price changed")
        assertEquals(listOf(row("1 Burger", "300.00"), "  was 350.00, Price changed", "  + Cheese, Bacon", "  * Well done"), lines(doc(l), Papers.RECEIPT))
        assertEquals(listOf(row("1 Burger", "300.00"), "  + Cheese, Bacon"), lines(doc(l), items { it.copy(notes = false, was = false) }))
        assertEquals("  was 300.00, Price changed", lines(doc(l), items { it.copy(addonPrices = true) })[1])
    }

    @Test
    fun `the kitchen's add-ons all on one line, and the seat hidden`() {
        val k = KitchenDoc("ORDER", "Table 4", 1_790_000_000_000, lines = listOf(DocLine(1000, "Burger", 0, listOf("Mayo, Chili", "Well done"), seat = 2)), station = "Kitchen")
        val design = Design(Papers.KITCHEN.blocks.map { if (it.k == "items") it.copy(addons = "line", seat = false) else it })
        val look = Docs.kitchenPage(k, Paper(48, 0, false), design).look()
        assertTrue(look.contains("   * Mayo, Chili, Well done"))
        assertFalse(look.any { it.contains("Seat") })
        assertTrue(Docs.kitchenPage(k, Paper(48, 0, false)).look().containsAll(listOf("   Seat 2", "   * Mayo, Chili", "   * Well done")))
    }

    @Test
    fun `Text fills its variables, leaves out what has nothing to say and keeps what is not one`() {
        val d = doc(burger).copy(customer = "Mrs Li", customerNo = "05")
        val look = Docs.receiptLook(d, shop, Paper(48, 0, false), 2, with(Block("text", text = "Thank you {customer}!\n{nope} No. {customer_no} total {total}")))
        assertTrue(look.contains("Thank you Mrs Li!"))
        assertTrue(look.contains("{nope} No. 05 total Rs 300.00"))
        val none = Docs.receiptLook(d.copy(customer = null), shop, Paper(48, 0, false), 2, with(Block("text", text = "Thank you {customer}!")))
        assertTrue(none.contains("Thank you !"))
        // a block left with nothing prints nothing, not even its line above
        val plain = Docs.receiptLook(d.copy(customerNo = null), shop, Paper(48, 0, false), 2)
        assertEquals(plain, Docs.receiptLook(d.copy(customerNo = null), shop, Paper(48, 0, false), 2, with(Block("text", text = "{customer_no}\n", above = true))))
    }

    @Test
    fun `the kitchen's variables, a Line of = and a Space`() {
        val k = KitchenDoc("ORDER", "Ravi", 1_790_000_000_000, lines = emptyList(), station = "Bar", pickup = "PICK UP 18:30", customerNo = "05")
        val design = Design(listOf(Block("text", text = "{station} {pickup} {date}"), Block("line", ch = '='), Block("space", n = 3), Block("text", text = "end"), Block("items")))
        assertEquals(listOf("Bar PICK UP 18:30 ${Docs.stamp(k.time).substringBefore(' ')}", "=".repeat(32), "", "", "", "end"), Docs.kitchenPage(k, Paper(32, 0, false), design).look())
    }

    @Test
    fun `a big name wraps at half the width, a tall total keeps it`() {
        val d = doc(burger)
        val big = Docs.receiptPage(d, Shop("The Great Mauritian Curry House"), Paper(32, 0, false), 2).styled()
        assertEquals(listOf("The Great", "Mauritian Curry", "House"), big.takeWhile { it.size == "big" }.map { it.t })
        val total = Docs.receiptPage(d, shop, Paper(32, 0, false), 2, design = Design(Papers.RECEIPT.blocks.map { if (it.k == "total") it.copy(size = "big") else it })).styled()
        assertEquals("TOTAL" + " ".repeat(16 - 5 - 9) + "Rs 300.00", total.first { it.t.startsWith("TOTAL") }.t)
    }
}

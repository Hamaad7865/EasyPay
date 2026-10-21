package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The till's own sheet for an item: what it holds when someone taps Save, and
// what the server's refusal reads as. The server has the last word (it checks
// the same things); this is so that a slip is caught before the tablet asks.
class ItemFormTest {
    private fun read(name: String = "Samosa", price: String = "30", open: Boolean = false, barcode: String = "") = ItemForm.read(name, price, open, barcode)

    // how a shop's product is sold (0131): what the sheet's choice sends
    @Test fun `a new product always says how it is sold`() {
        assertEquals("each", ItemForm.soldBy(ItemForm.Way.FIXED, null))
        assertEquals("weight", ItemForm.soldBy(ItemForm.Way.KILO, null))
        assertEquals("each", ItemForm.soldBy(ItemForm.Way.AT_SALE, null))
    }

    @Test fun `a product being changed says it only when its unit changes`() {
        assertNull(ItemForm.soldBy(ItemForm.Way.KILO, "weight"))
        assertNull(ItemForm.soldBy(ItemForm.Way.FIXED, "each"))
        assertNull(ItemForm.soldBy(ItemForm.Way.AT_SALE, "each"))
        assertEquals("each", ItemForm.soldBy(ItemForm.Way.FIXED, "weight"))
        assertEquals("each", ItemForm.soldBy(ItemForm.Way.AT_SALE, "weight"))
        assertEquals("weight", ItemForm.soldBy(ItemForm.Way.KILO, "each"))
    }

    @Test fun `the way a product is sold, read back from it`() {
        assertEquals(ItemForm.Way.KILO, ItemForm.wayOf(open = false, soldBy = "weight"))
        assertEquals(ItemForm.Way.AT_SALE, ItemForm.wayOf(open = true, soldBy = "each"))
        assertEquals(ItemForm.Way.FIXED, ItemForm.wayOf(open = false, soldBy = "each"))
    }

    @Test fun `by the kilo needs its price for a kilo, and goes in the save`() {
        assertEquals("Type its price for a kilo", ItemForm.read("Ironing", "", false, "", soldBy = "weight").exceptionOrNull()?.message)
        val i = ItemForm.read("Ironing", "110", false, "", soldBy = "weight").getOrThrow()
        assertEquals("weight", i.soldBy)
        assertEquals("weight", OfficePayloads.itemSave("id-1", i, null, true, false, null, null, null)["sold_by"]?.let { (it as kotlinx.serialization.json.JsonPrimitive).content })
        // not said: not sent, and the server leaves the unit as it is
        assertNull(OfficePayloads.itemSave("id-1", read().getOrThrow(), null, true, null, null, null, null)["sold_by"])
        assertEquals("unit-has-stock", ItemForm.refused("unit-has-stock", shop = true).let { if (it.startsWith("It holds stock")) "unit-has-stock" else it })
    }

    @Test fun `a name and a price make an item`() {
        val i = read().getOrThrow()
        assertEquals("Samosa", i.name)
        assertEquals(3000L, i.price)
        assertEquals(false, i.open)
        assertNull(i.barcode)
    }

    @Test fun `the name is taken as typed, less the spaces around it, and has to be there`() {
        assertEquals("Samosa", read(name = "  Samosa  ").getOrThrow().name)
        assertEquals("Give it a name", read(name = "   ").exceptionOrNull()?.message)
        assertEquals(80, read(name = "x".repeat(200)).getOrThrow().name.length)
    }

    @Test fun `a price is rupees, and nothing typed is not a price`() {
        assertEquals(9950L, read(price = "99.50").getOrThrow().price)
        assertEquals(0L, read(price = "0").getOrThrow().price) // something given away is still an item
        assertTrue(read(price = "").exceptionOrNull()!!.message!!.startsWith("Type its price"))
        assertTrue(read(price = "abc").exceptionOrNull()!!.message!!.startsWith("Type its price"))
        assertEquals("Rs 1,000,000 is the most an item can cost", read(price = "1000000.01").exceptionOrNull()?.message)
    }

    @Test fun `one whose price is typed at the sale needs none here`() {
        val i = read(price = "", open = true).getOrThrow()
        assertEquals(true, i.open)
        assertEquals(0L, i.price)
        // whatever was left in the box is not its price
        assertEquals(0L, read(price = "250", open = true).getOrThrow().price)
    }

    @Test fun `a barcode is what the scanner typed, with no spaces, or nothing`() {
        assertEquals("60012345", read(barcode = " 6001 2345 ").getOrThrow().barcode)
        assertNull(read(barcode = "   ").getOrThrow().barcode)
        assertEquals("That barcode is too long", read(barcode = "1".repeat(65)).exceptionOrNull()?.message)
    }

    @Test fun `what the server refuses is said in the till's words`() {
        assertEquals("Another item already has that barcode.", ItemForm.refused("barcode-taken", shop = false))
        assertEquals("Another product already has that barcode.", ItemForm.refused("barcode-taken", shop = true))
        assertEquals("Give it a name", ItemForm.refused("name-required", shop = false))
        assertEquals("That category is no longer there. Pick another.", ItemForm.refused("bad-category", shop = false))
        assertEquals("That item is no longer there.", ItemForm.refused("bad-item", shop = false))
        assertEquals("That product is no longer there.", ItemForm.refused("bad-item", shop = true))
        assertEquals("You are not allowed to change the menu. Ask a manager.", ItemForm.refused("forbidden", shop = false))
        assertEquals("You are not allowed to change the products. Ask a manager.", ItemForm.refused("forbidden", shop = true))
        assertEquals("A product with variants, or sold by weight, has prices of its own: its price cannot be typed at the sale.", ItemForm.refused("open-price-not-here", shop = true))
    }

    @Test fun `a server that does not know how yet says so, and anything else is not hidden`() {
        assertEquals("The server has to be updated before items can be changed from a till.", ItemForm.refused("unknown-op", shop = false))
        assertEquals("The server refused it (bad-payload).", ItemForm.refused("bad-payload", shop = false))
        assertEquals("The server refused it.", ItemForm.refused(null, shop = false))
    }
}

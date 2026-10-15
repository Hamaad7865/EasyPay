package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

// A design is read forgivingly: what cannot be read prints EasyPay's, and a
// later back office cannot stop this till printing.
class PapersTest {
    private fun receipt(blocks: String, shop: Boolean = false) = Papers.receipt("""{"receipt":{"v":1,"blocks":[$blocks]}}""", shop)
    private val locked = """{"k":"title"},{"k":"items"},{"k":"total"}"""

    @Test
    fun `no design is EasyPay's, and EasyPay's is today's order`() {
        assertSame(Papers.RECEIPT, Papers.receipt(null, false))
        assertSame(Papers.RECEIPT, Papers.receipt("{}", true))
        assertSame(Papers.KITCHEN, Papers.kitchen("""{"receipt":{"v":1,"blocks":[]}}"""))
        assertEquals(32, Papers.RECEIPT.blocks.size)
        assertEquals(listOf("station", "heading", "pickup", "time_waiter", "type_guests", "line", "items", "remark", "line"), Papers.KITCHEN.blocks.map { it.k })
    }

    @Test
    fun `what is not a design of this version prints EasyPay's`() {
        assertSame(Papers.RECEIPT, Papers.receipt("not json", false))
        assertSame(Papers.RECEIPT, Papers.receipt("""{"receipt":{"v":2,"blocks":[$locked]}}""", false))
        assertSame(Papers.RECEIPT, Papers.receipt("""{"receipt":{"v":"1","blocks":[$locked]}}""", false))
        assertSame(Papers.RECEIPT, Papers.receipt("""{"receipt":{"v":1,"blocks":{}}}""", false))
    }

    @Test
    fun `a locked block missing or hidden prints EasyPay's, a shop's barcode included`() {
        assertSame(Papers.RECEIPT, receipt("""{"k":"title"},{"k":"items"}"""))
        assertSame(Papers.RECEIPT, receipt("""{"k":"title"},{"k":"items","hide":true},{"k":"total"}"""))
        assertSame(Papers.RECEIPT, receipt(locked, shop = true))
        assertEquals(3, receipt(locked).blocks.size)
        assertEquals(4, receipt("""$locked,{"k":"barcode"}""", shop = true).blocks.size)
        assertSame(Papers.KITCHEN, Papers.kitchen("""{"kitchen":{"v":1,"blocks":[{"k":"station"}]}}"""))
    }

    @Test
    fun `an unknown kind and a second of a kind that is there once are skipped, text and lines repeat`() {
        val d = receipt("""{"k":"hologram"},$locked,{"k":"title","bold":false},{"k":"line"},{"k":"line","ch":"="},{"k":"text","text":"a"},{"k":"text","text":"b"},7,"x",{"size":"big"}""")
        assertEquals(listOf("title", "items", "total", "line", "line", "text", "text"), d.blocks.map { it.k })
        assertEquals(true, d.blocks[0].bold)
        assertEquals('=', d.blocks[4].ch)
    }

    @Test
    fun `a setting not understood takes the kind's own`() {
        val d = receipt("""$locked,{"k":"name","size":"huge","align":"middle","bold":"yes"},{"k":"space","n":9},{"k":"line","ch":"*"},{"k":"items2"},{"k":"text","text":"${"x".repeat(310)}"}""")
        val name = d.blocks.first { it.k == "name" }
        assertEquals("big", name.size); assertEquals("center", name.align); assertEquals(false, name.bold)
        assertEquals(1, d.blocks.first { it.k == "space" }.n)
        assertEquals('-', d.blocks.first { it.k == "line" }.ch)
        assertEquals(300, d.blocks.first { it.k == "text" }.text.length)
    }

    @Test
    fun `a design keeps only what differs, the rest is the kind's own`() {
        val items = receipt("""{"k":"title"},{"k":"items","addons":"rows","addonPrices":true,"unitPrice":true,"notes":false},{"k":"total","size":"big"}""").blocks
        assertEquals(Block("items", addons = "rows", addonPrices = true, unitPrice = true, notes = false), items[1])
        assertEquals(Block("total", bold = true, size = "big"), items[2])
        // the kitchen's add-ons are a line per group or one line, never rows
        val k = Papers.kitchen("""{"kitchen":{"v":1,"blocks":[{"k":"items","addons":"rows","seat":false}]}}""").blocks.single()
        assertEquals("groups", k.addons); assertEquals(false, k.seat)
    }

    @Test
    fun `sixty blocks at most`() {
        val many = (1..70).joinToString(",") { """{"k":"text","text":"$it"}""" }
        assertSame(Papers.RECEIPT, receipt("$many,$locked"))
        assertEquals(60, receipt("$locked,$many").blocks.size)
    }
}

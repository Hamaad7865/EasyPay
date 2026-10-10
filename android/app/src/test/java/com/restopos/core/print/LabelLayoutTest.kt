package com.restopos.core.print

import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelLayoutTest {
    private val ean = "5901234123457"
    private fun words(code: String? = ean, variant: String = "GX11", price: String = "Rs 1,700.00") =
        LabelWords("EasyHome", "S.Mirror Led", variant, price, code)
    private fun place(id: String, w: LabelWords = words(), dpi: Int = 203) = LabelLayout.place(LabelTemplates.byId(id), w, dpi)
    private fun LabelLayout.Placed.texts() = items.filterIsInstance<LabelLayout.Item.Words>().map { it.text }
    private fun LabelLayout.Placed.bars() = items.filterIsInstance<LabelLayout.Item.Bars>()

    @Test fun `a label is as many dots as its millimetres make`() {
        assertEquals(320 to 240, place("40x30-full").let { it.width to it.height })
        assertEquals(400 to 200, place("50x25-shop").let { it.width to it.height })
        assertEquals(200 to 120, place("25x15-price").let { it.width to it.height })
        assertEquals(472 to 354, place("40x30-full", dpi = 300).let { it.width to it.height })
    }

    @Test fun `the 40 x 30 label has the name, the variant, the price and the bars`() {
        val p = place("40x30-full")
        val b = p.bars().single()
        assertEquals(2, b.module)
        assertEquals(113, b.bits.size)
        // 226 dots of symbol, inside the box that starts 2 mm in and is 36 mm wide
        assertTrue(b.x >= 16 && b.x + 226 <= 304)
        assertEquals(listOf("S.Mirror Led", "GX11", "Rs 1,700.00", ean), p.texts())
        assertNull(p.noBars)
    }

    @Test fun `the 50 x 25 label has the shop, and the variant after the name`() {
        val p = place("50x25-shop")
        assertEquals(3, p.bars().single().module)
        assertEquals(listOf("EasyHome", "S.Mirror Led, GX11", "Rs 1,700.00", ean), p.texts())
        // with no variant the name stands alone
        assertTrue("S.Mirror Led" in place("50x25-shop", words(variant = "")).texts())
    }

    @Test fun `a code too wide for the label prints as its characters`() {
        val p = place("25x15-price-bars")
        assertTrue(p.bars().isEmpty())
        assertTrue(ean in p.texts())
        assertEquals(LabelLayout.TOO_WIDE, p.noBars)
        // a short one has its bars
        val short = place("25x15-price-bars", words(code = "1010"))
        assertEquals(2, short.bars().single().module)
        assertNull(short.noBars)
    }

    @Test fun `no code, no bars, and the label says nothing in their place`() {
        val p = place("40x30-full", words(code = null))
        assertTrue(p.bars().isEmpty())
        assertEquals(listOf("S.Mirror Led", "GX11", "Rs 1,700.00"), p.texts())
        assertEquals(LabelLayout.NO_CODE, p.noBars)
        assertEquals(LabelLayout.NO_CODE, place("40x30-full", words(code = "  ")).noBars)
        // a character bars cannot hold
        val odd = place("40x30-full", words(code = "é1"))
        assertTrue(odd.bars().isEmpty())
        assertEquals(LabelLayout.NOT_IN_BARS, odd.noBars)
    }

    @Test fun `words that are blank leave no empty box`() {
        assertEquals(listOf("S.Mirror Led", "Rs 1,700.00", ean), place("40x30-full", words(variant = " ")).texts())
        // a price typed at the sale is not on the label
        assertEquals(listOf("S.Mirror Led", "GX11", ean), place("40x30-full", words(price = "")).texts())
    }

    @Test fun `a label without bars never complains about a code`() {
        assertNull(place("25x15-price", words(code = null)).noBars)
        assertNull(place("25x15-name-price", words(code = null)).noBars)
        assertEquals(listOf("Rs 1,700.00"), place("25x15-price").texts())
        assertEquals(listOf("S.Mirror Led, GX11", "Rs 1,700.00"), place("25x15-name-price").texts())
    }

    @Test fun `everything on every ready-made label lies on the label`() {
        for (t in LabelTemplates.all) for (dpi in listOf(203, 300)) for (code in listOf(ean, "1010", "SML-GX11", null)) {
            val p = LabelLayout.place(t, words(code), dpi)
            for (i in p.items) {
                assertTrue("${t.id} at $dpi with $code: $i", inside(i, p.width, p.height))
            }
        }
    }

    // a thing lies inside a frame so wide and so high; what is turned is asked about its own frame too
    private fun inside(i: LabelLayout.Item, wide: Int, high: Int): Boolean {
        val (x, y, w, h) = when (i) {
            is LabelLayout.Item.Words -> listOf(i.x, i.y, i.w, i.h)
            is LabelLayout.Item.Bars -> listOf(i.x, i.y, i.bits.size * i.module, i.h)
            is LabelLayout.Item.Rect -> listOf(i.x, i.y, i.w, i.h)
            is LabelLayout.Item.Picture -> listOf(i.x, i.y, i.w, i.h)
            is LabelLayout.Item.Turned -> {
                val side = i.turn == 90 || i.turn == 270
                if (!i.items.all { inside(it, if (side) i.h else i.w, if (side) i.w else i.h) }) return false
                listOf(i.x, i.y, i.w, i.h)
            }
        }
        return x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= wide && y + h <= high
    }

    // ---- what the designer added ----

    private fun one(vararg e: LabelElement, w: Float = 40f, h: Float = 30f) = LabelTemplate("own-1", "Mine", w, h, elements = e.toList())

    @Test fun `a label written before the designer is still read`() {
        // as piece 1 wrote one down: no alignment, no turning
        val then = """{"id":"own-1","name":"Mine","widthMm":40.0,"heightMm":30.0,"elements":[
            {"type":"text","x":1.5,"y":1.0,"w":37.0,"h":7.6,"field":"name","size":3.2,"bold":true,"lines":2},
            {"type":"bars","x":2.0,"y":18.5,"w":36.0,"h":10.0},
            {"type":"box","x":0.4,"y":0.4,"w":39.2,"h":29.2}]}"""
        val now = one(
            LabelElement.Text(1.5f, 1f, 37f, 7.6f, field = "name", size = 3.2f, bold = true, lines = 2),
            LabelElement.Bars(2f, 18.5f, 36f, 10f),
            LabelElement.Box(0.4f, 0.4f, 39.2f, 29.2f),
        )
        assertEquals(now, Json { ignoreUnknownKeys = true }.decodeFromString(LabelTemplate.serializer(), then))
    }

    @Test fun `words are set where the label says`() {
        val p = LabelLayout.place(one(LabelElement.Text(2f, 2f, 30f, 4f, field = "name", size = 3f, align = "left"), LabelElement.Text(2f, 8f, 30f, 4f, field = "price", size = 3f, align = "right"), LabelElement.Text(2f, 14f, 30f, 4f, field = "shop", size = 3f, align = "sideways")), words(), 203)
        assertEquals(listOf("left", "right", "center"), p.items.filterIsInstance<LabelLayout.Item.Words>().map { it.align })
    }

    @Test fun `a text turned a quarter is laid out the other way round in its box`() {
        // a box 5 mm wide and 20 mm high, read from top to bottom
        val p = LabelLayout.place(one(LabelElement.Text(30f, 4f, 5f, 20f, field = "price", size = 3.5f, bold = true, turn = 90)), words(), 203)
        val t = p.items.single() as LabelLayout.Item.Turned
        assertEquals(listOf(240, 32, 40, 160, 90), listOf(t.x, t.y, t.w, t.h, t.turn))
        val w = t.items.single() as LabelLayout.Item.Words
        // its own frame is the box's sides swapped: 160 across, 40 down
        assertEquals(listOf(0, 0, 160, 40), listOf(w.x, w.y, w.w, w.h))
        assertEquals("Rs 1,700.00", w.text)
        // upside down keeps the frame as it is; a turn that is no quarter is none
        val over = LabelLayout.place(one(LabelElement.Text(2f, 2f, 30f, 5f, field = "price", size = 3.5f, turn = 180)), words(), 203).items.single() as LabelLayout.Item.Turned
        assertEquals(listOf(240, 40), (over.items.single() as LabelLayout.Item.Words).let { listOf(it.w, it.h) })
        assertTrue(LabelLayout.place(one(LabelElement.Text(2f, 2f, 30f, 5f, field = "price", size = 3.5f, turn = 45)), words(), 203).items.single() is LabelLayout.Item.Words)
        assertEquals(270, (LabelLayout.place(one(LabelElement.Text(2f, 2f, 5f, 20f, field = "price", size = 3.5f, turn = -90)), words(), 203).items.single() as LabelLayout.Item.Turned).turn)
    }

    @Test fun `bars turned a quarter fit by the box's height`() {
        // 12 mm across and 29 mm down: across there is no room for an EAN-13, down there is
        val tall = one(LabelElement.Bars(26f, 0.5f, 12f, 29f, turn = 90))
        val p = LabelLayout.place(tall, words(), 203)
        val t = p.items.single() as LabelLayout.Item.Turned
        val b = t.items.filterIsInstance<LabelLayout.Item.Bars>().single()
        assertEquals(2, b.module)
        assertTrue(b.x >= 0 && b.x + b.bits.size * b.module <= 232)
        assertNull(p.noBars)
        // the same box the right way up has none
        assertEquals(LabelLayout.TOO_WIDE, LabelLayout.place(one(LabelElement.Bars(26f, 0.5f, 12f, 29f)), words(), 203).noBars)
    }

    @Test fun `a line is ink at least a dot thick, and the logo has its box`() {
        val p = LabelLayout.place(one(LabelElement.Line(2f, 10f, 36f, 0.05f), LabelElement.Line(5f, 2f, 0.3f, 20f), LabelElement.Logo(2f, 2f, 10f, 8f)), words(), 203)
        assertEquals(LabelLayout.Item.Rect(16, 80, 288, 1), p.items[0])
        assertEquals(LabelLayout.Item.Rect(40, 16, 2, 160), p.items[1])
        assertEquals(LabelLayout.Item.Picture(16, 16, 80, 64), p.items[2])
        assertNull(p.noBars)
    }

    @Test fun `the SKU, the category and the date are words a label can carry`() {
        val w = LabelWords("EasyHome", "S.Mirror Led", "GX11", "Rs 1,700.00", ean, sku = "SML-GX11", category = "Mirrors", date = "10/10/2026")
        val t = one(LabelElement.Text(1f, 1f, 30f, 3f, field = "sku", size = 2.5f), LabelElement.Text(1f, 5f, 30f, 3f, field = "category", size = 2.5f), LabelElement.Text(1f, 9f, 30f, 3f, field = "date", size = 2.5f), LabelElement.Text(1f, 13f, 30f, 3f, field = "code", size = 2.5f), LabelElement.Text(1f, 17f, 30f, 3f, text = "Made in Mauritius", size = 2.5f))
        assertEquals(listOf("SML-GX11", "Mirrors", "10/10/2026", ean, "Made in Mauritius"), LabelLayout.place(t, w, 203).texts())
        // words a product does not have leave no box
        assertEquals(listOf(ean, "Made in Mauritius"), LabelLayout.place(t, words(), 203).texts())
    }

    @Test fun `the ready-made labels, and what they say of themselves`() {
        assertEquals(listOf("40x30-full", "50x25-shop", "25x15-name-price", "25x15-price", "25x15-price-bars"), LabelTemplates.all.map { it.id })
        assertEquals("40 x 30", LabelTemplates.byId("40x30-full").size)
        assertEquals("40x30-full", LabelTemplates.byId(null).id)
        assertEquals("40x30-full", LabelTemplates.byId("gone").id)
    }

    @Test fun `a template can be written down and read back`() {
        val json = Json { ignoreUnknownKeys = true }
        for (t in LabelTemplates.all) assertEquals(t, json.decodeFromString(LabelTemplate.serializer(), json.encodeToString(LabelTemplate.serializer(), t)))
    }

    @Test fun `the test label has a frame, its words and bars that fit`() {
        for (t in LabelTemplates.all.distinctBy { it.size }) {
            val test = LabelTemplates.test(t)
            assertEquals(t.size, test.size)
            val p = LabelLayout.place(test, LabelWords("", "", "", "", LabelTemplates.testCode(t)), 203)
            assertEquals(4, p.items.filterIsInstance<LabelLayout.Item.Rect>().size)
            assertNotNull(p.bars().singleOrNull())
            assertTrue("EasyPay label test" in p.texts())
            assertTrue("${t.size} mm" in p.texts())
            assertFalse(p.items.any { it is LabelLayout.Item.Words && it.text.isBlank() })
        }
    }
}

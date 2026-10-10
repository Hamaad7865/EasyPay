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
                val (x, y, w, h) = when (i) {
                    is LabelLayout.Item.Words -> listOf(i.x, i.y, i.w, i.h)
                    is LabelLayout.Item.Bars -> listOf(i.x, i.y, i.bits.size * i.module, i.h)
                    is LabelLayout.Item.Rect -> listOf(i.x, i.y, i.w, i.h)
                }
                assertTrue("${t.id} at $dpi with $code: $i", x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= p.width && y + h <= p.height)
            }
        }
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

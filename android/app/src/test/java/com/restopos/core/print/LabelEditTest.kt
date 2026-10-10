package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class LabelEditTest {
    private val text = LabelElement.Text(10f, 10f, 20f, 4f, field = "name", size = 3f)
    private val bars = LabelElement.Bars(2f, 18f, 36f, 10f)
    private val line = LabelElement.Line(2f, 16f, 36f, 0.3f)
    private val frame = LabelElement.Box(0.5f, 0.5f, 39f, 29f)
    private val logo = LabelElement.Logo(30f, 2f, 8f, 6f)
    private fun label(vararg e: LabelElement, w: Float = 40f, h: Float = 30f) = LabelTemplate("own-1", "Mine", w, h, elements = e.toList())
    private fun LabelTemplate.box(at: Int) = LabelEdit.box(elements[at]).let { listOf(it.x, it.y, it.w, it.h) }

    // every box on the label, and no smaller than a thing of its kind may be
    private fun sound(t: LabelTemplate) {
        assertTrue("${t.widthMm} x ${t.heightMm}", t.widthMm in LabelEdit.WIDE && t.heightMm in LabelEdit.HIGH && t.gapMm in LabelEdit.GAP)
        for (e in t.elements) {
            val b = LabelEdit.box(e)
            val (lw, lh) = LabelEdit.least(e)
            assertTrue("$e on ${t.widthMm} x ${t.heightMm}", b.x >= -0.001f && b.y >= -0.001f && b.x + b.w <= t.widthMm + 0.001f && b.y + b.h <= t.heightMm + 0.001f)
            assertTrue("$e is under its least", b.w >= minOf(lw, t.widthMm) - 0.001f && b.h >= minOf(lh, t.heightMm) - 0.001f)
        }
    }

    @Test fun `a new label is empty, and a copy is the same label under another name`() {
        val b = LabelEdit.blank("own-7", "Shelf")
        assertEquals(listOf(40f, 30f, 2f), listOf(b.widthMm, b.heightMm, b.gapMm))
        assertTrue(b.elements.isEmpty())
        val of = LabelTemplates.byId("50x25-shop")
        val c = LabelEdit.copy(of, "own-8", "Mine")
        assertEquals(of.elements, c.elements)
        assertEquals(listOf("own-8", "Mine", "50 x 25"), listOf(c.id, c.name, c.size))
    }

    @Test fun `moving snaps to half a millimetre and stops at the label's edge`() {
        val t = label(text)
        assertEquals(listOf(12.5f, 9f, 20f, 4f), LabelEdit.moveTo(t, 0, 12.6f, 8.9f).box(0))
        assertEquals(listOf(10.5f, 10f, 20f, 4f), LabelEdit.move(t, 0, LabelEdit.STEP, 0f).box(0))
        assertEquals(listOf(0f, 0f, 20f, 4f), LabelEdit.moveTo(t, 0, -5f, -5f).box(0))
        assertEquals(listOf(20f, 26f, 20f, 4f), LabelEdit.moveTo(t, 0, 99f, 99f).box(0))
        // nothing is there to move
        assertSame(t, LabelEdit.move(t, 3, 1f, 1f))
    }

    @Test fun `sizing snaps, keeps a least size and stops at the edge`() {
        val t = label(text, bars, line)
        assertEquals(listOf(10f, 10f, 25.5f, 6f), LabelEdit.sizeTo(t, 0, 25.4f, 6.1f).box(0))
        assertEquals(listOf(10f, 10f, 3f, 1.5f), LabelEdit.sizeTo(t, 0, 0f, 0f).box(0))
        assertEquals(listOf(10f, 10f, 30f, 20f), LabelEdit.sizeTo(t, 0, 99f, 99f).box(0))
        assertEquals(listOf(2f, 18f, 8f, 4f), LabelEdit.sizeTo(t, 1, 1f, 1f).box(1))
        // a line is sized along its length; its thickness is A+ and A-'s
        assertEquals(listOf(2f, 16f, 20f, 0.3f), LabelEdit.sizeTo(t, 2, 20.2f, 5f).box(2))
    }

    @Test fun `a quarter turn swaps the sides about the middle, and four are none`() {
        val t = label(text)
        val once = LabelEdit.turn(t, 0)
        assertEquals(90, (once.elements[0] as LabelElement.Text).turn)
        // 20 x 4 about (20, 12) becomes 4 x 20
        assertEquals(listOf(18f, 2f, 4f, 20f), once.box(0))
        var back = t
        repeat(4) { back = LabelEdit.turn(back, 0) }
        assertEquals(t, back)
        // bars turn as words do; a line swaps its sides; the logo stays as it is
        assertEquals(90, (LabelEdit.turn(label(bars), 0).elements[0] as LabelElement.Bars).turn)
        assertEquals(listOf(19.85f, 0f, 0.3f, 30f), LabelEdit.turn(label(line), 0).box(0).mapIndexed { i, v -> if (i == 3) v else Math.round(v * 100) / 100f })
        val l = label(logo)
        assertSame(l, LabelEdit.turn(l, 0))
        // turned at the edge, it is kept on the label
        sound(LabelEdit.turn(label(LabelElement.Text(0f, 0f, 38f, 3f, field = "name", size = 2.5f)), 0))
    }

    @Test fun `A plus and A minus change the letters, or how thick a line is`() {
        val t = label(text, line, frame, bars)
        assertEquals(3.3f, (LabelEdit.bigger(t, 0, 1).elements[0] as LabelElement.Text).size, 0.001f)
        assertEquals(2.7f, (LabelEdit.bigger(t, 0, -1).elements[0] as LabelElement.Text).size, 0.001f)
        var small = t
        repeat(40) { small = LabelEdit.bigger(small, 0, -1) }
        assertEquals(LabelEdit.LETTERS.start, (small.elements[0] as LabelElement.Text).size, 0.001f)
        assertEquals(0.4f, LabelEdit.bigger(t, 1, 1).box(1)[3], 0.001f)
        assertEquals(0.4f, (LabelEdit.bigger(t, 2, 1).elements[2] as LabelElement.Box).thick, 0.001f)
        var thick = t
        repeat(60) { thick = LabelEdit.bigger(thick, 1, 1) }
        assertEquals(LabelEdit.THICK.endInclusive, thick.box(1)[3], 0.001f)
        // bars have no letters to size here
        assertSame(t, LabelEdit.bigger(t, 3, 1))
    }

    @Test fun `each thing that can be added lands on the label`() {
        var t = LabelEdit.blank("own-1", "Mine", 50f, 25f)
        for (kind in LabelEdit.KINDS.map { it.first }) {
            val n = t.elements.size
            t = LabelEdit.add(t, kind)
            assertEquals(kind, n + 1, t.elements.size)
            sound(t)
        }
        assertEquals(LabelEdit.KINDS.map { it.second }.dropLast(5) + listOf("Text: Text", "Barcode", "Line", "Box", "Logo"), t.elements.map { LabelEdit.says(it) })
        // on the smallest label too
        var tiny = LabelEdit.blank("own-2", "Tiny", 15f, 10f)
        for (kind in LabelEdit.KINDS.map { it.first }) { tiny = LabelEdit.add(tiny, kind); sound(tiny) }
        // an unknown kind adds nothing
        assertSame(t, LabelEdit.add(t, "hologram"))
        assertEquals(t.elements.drop(1), LabelEdit.remove(t, 0).elements)
        assertSame(t, LabelEdit.remove(t, 99))
    }

    @Test fun `what the panel changes is kept on the label`() {
        val t = label(text)
        val wild = LabelEdit.with(t, 0, text.copy(x = 35f, w = 30f, bold = true, align = "right", lines = 3))
        sound(wild)
        val e = wild.elements[0] as LabelElement.Text
        assertEquals(listOf(true, "right", 3), listOf(e.bold, e.align, e.lines))
    }

    @Test fun `a label's own size has limits, and what would be left outside comes back in`() {
        val t = label(text, bars, line, frame, logo)
        val small = LabelEdit.resize(t, 25f, 15f, 2f)
        assertEquals(listOf(25f, 15f), listOf(small.widthMm, small.heightMm))
        sound(small)
        val limits = LabelEdit.resize(t, 500f, 1f, 99f)
        assertEquals(listOf(110f, 10f, 10f), listOf(limits.widthMm, limits.heightMm, limits.gapMm))
        sound(limits)
        assertEquals(listOf(15f, 150f, 0f), LabelEdit.resize(t, 0f, 999f, -3f).let { listOf(it.widthMm, it.heightMm, it.gapMm) })
        // half millimetres are kept, anything finer is not
        assertEquals(listOf(37.5f, 22.5f), LabelEdit.resize(t, 37.6f, 22.4f, 2f).let { listOf(it.widthMm, it.heightMm) })
    }

    @Test fun `a finger finds the smallest thing under it, and a thin line too`() {
        val t = label(frame, text, line)
        assertEquals(1, LabelEdit.hit(t, 15f, 12f)) // the text, though the frame is under it too
        assertEquals(0, LabelEdit.hit(t, 5f, 25f)) // only the frame
        assertEquals(2, LabelEdit.hit(t, 20f, 17f)) // a millimetre off a line 0.3 mm thick
        assertNull(LabelEdit.hit(label(text), 1f, 1f))
        // of two as small, the one on top
        assertEquals(1, LabelEdit.hit(label(text, text), 15f, 12f))
    }

    @Test fun `a label needs a name and something on it`() {
        assertEquals("Give the label a name", LabelEdit.problem(label(text).copy(name = "  ")))
        assertEquals("Put something on the label first", LabelEdit.problem(label()))
        assertNull(LabelEdit.problem(label(text)))
    }

    @Test fun `three thousand changes at random and everything is still on the label`() {
        val r = Random(20261010)
        val kinds = LabelEdit.KINDS.map { it.first }
        var t = LabelEdit.blank("own-1", "Mine")
        fun wild() = r.nextFloat() * 400f - 150f
        repeat(3000) { step ->
            val at = if (t.elements.isEmpty()) 0 else r.nextInt(t.elements.size + 1) // sometimes one past the end
            t = when (r.nextInt(9)) {
                0 -> if (t.elements.size < 12) LabelEdit.add(t, kinds[r.nextInt(kinds.size)]) else LabelEdit.remove(t, at)
                1 -> LabelEdit.moveTo(t, at, wild(), wild())
                2 -> LabelEdit.move(t, at, wild() / 20f, wild() / 20f)
                3 -> LabelEdit.sizeTo(t, at, wild(), wild())
                4 -> LabelEdit.turn(t, at)
                5 -> LabelEdit.bigger(t, at, r.nextInt(-3, 4))
                6 -> LabelEdit.resize(t, wild(), wild(), wild() / 20f)
                7 -> t.elements.getOrNull(at)?.let { e -> LabelEdit.with(t, at, if (e is LabelElement.Text) e.copy(x = wild(), w = wild(), lines = r.nextInt(1, 4)) else e) } ?: t
                else -> LabelEdit.remove(t, at)
            }
            sound(t)
            // and it can still be laid out for a printer of either kind
            if (step % 50 == 0) for (dpi in listOf(203, 300)) LabelLayout.place(t, LabelWords("Shop", "Name", "Variant", "Rs 1.00", "5901234123457", "SKU", "Cat", "10/10/2026"), dpi)
        }
    }
}

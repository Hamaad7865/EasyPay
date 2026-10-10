package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelBookTest {
    private fun own(n: Int, name: String = "Mine $n") = LabelTemplate(
        "own-$n", name, 50f, 30f, 3f,
        listOf(
            LabelElement.Text(1f, 1f, 30f, 4f, text = "EasyHome", size = 3f, bold = true, align = "left"),
            LabelElement.Text(40f, 2f, 5f, 20f, field = "price", size = 4f, turn = 90),
            LabelElement.Bars(2f, 12f, 36f, 10f, digits = 0f, turn = 180),
            LabelElement.Line(1f, 11f, 48f, 0.3f),
            LabelElement.Box(0.5f, 0.5f, 49f, 29f, 0.4f),
            LabelElement.Logo(40f, 22f, 8f, 6f),
        ),
    )

    @Test fun `the shop's own labels are written down and read back as they were`() {
        val list = listOf(own(1), own(2))
        assertEquals(list, LabelBook.read(LabelBook.write(list)))
        assertEquals(emptyList<LabelTemplate>(), LabelBook.read(LabelBook.write(emptyList())))
    }

    @Test fun `what cannot be read is no label, and the rest are kept`() {
        assertEquals(emptyList<LabelTemplate>(), LabelBook.read(null))
        assertEquals(emptyList<LabelTemplate>(), LabelBook.read(""))
        assertEquals(emptyList<LabelTemplate>(), LabelBook.read("{"))
        assertEquals(emptyList<LabelTemplate>(), LabelBook.read("""{"id":"own-1"}"""))
        // one label a later build wrote with something this one does not know, between two it does
        val odd = """{"id":"own-9","name":"Later","widthMm":40.0,"heightMm":30.0,"elements":[{"type":"hologram","x":1.0}]}"""
        val text = "[" + LabelBook.write(listOf(own(1))).trim('[', ']') + "," + odd + "," + LabelBook.write(listOf(own(2))).trim('[', ']') + "]"
        assertEquals(listOf(own(1), own(2)), LabelBook.read(text))
        // a ready-made label's id is never one of the shop's own
        assertEquals(emptyList<LabelTemplate>(), LabelBook.read(LabelBook.write(listOf(LabelTemplates.byId("40x30-full")))))
    }

    @Test fun `a label saved again takes the place it had`() {
        val list = listOf(own(1), own(2), own(3))
        assertEquals(listOf("Mine 1", "Renamed", "Mine 3"), LabelBook.with(list, own(2, "Renamed")).map { it.name })
        assertEquals(listOf("own-1", "own-2", "own-3", "own-4"), LabelBook.with(list, own(4)).map { it.id })
        assertEquals(listOf("own-1", "own-3"), LabelBook.without(list, "own-2").map { it.id })
        assertEquals(list, LabelBook.without(list, "own-9"))
    }

    @Test fun `the book holds the ready-made labels, then the shop's own`() {
        val all = LabelBook.all(listOf(own(1)))
        assertEquals(LabelTemplates.all.map { it.id } + "own-1", all.map { it.id })
        assertEquals("Mine 1", LabelBook.find(listOf(own(1)), "own-1")?.name)
        assertEquals("50x25-shop", LabelBook.find(emptyList(), "50x25-shop")?.id)
        // a label that was deleted is not quietly another one
        assertNull(LabelBook.find(listOf(own(1)), "own-2"))
        assertNull(LabelBook.find(emptyList(), null))
        assertTrue(LabelBook.isOwn("own-1"))
        assertFalse(LabelBook.isOwn("40x30-full"))
    }
}

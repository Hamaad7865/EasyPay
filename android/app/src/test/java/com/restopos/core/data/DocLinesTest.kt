package com.restopos.core.data

import com.restopos.core.data.DocLines.Line
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import org.junit.Assert.assertEquals
import org.junit.Test

// The lines of an order or a delivery: thousandths and cents, one line a
// product, and which lines the server would refuse.
class DocLinesTest {
    @Test fun `two lines of one product are one, quantities added and the cost averaged by quantity`() {
        assertEquals(listOf(Line("a", "", 4000, 4600)), DocLines.merged(listOf(Line("a", "", 3000, 4500), Line("a", "", 1000, 4900))))
        // a variant is its own line, and the order things were first met in is kept
        assertEquals(
            listOf(Line("b", "m", 2000, 100), Line("a", "", 1000, 50), Line("b", "s", 1000, 100)),
            DocLines.merged(listOf(Line("b", "m", 1000, 100), Line("a", "", 1000, 50), Line("b", "s", 1000, 100), Line("b", "m", 1000, 100))),
        )
        // a line of nothing is not a line
        assertEquals(emptyList<Line>(), DocLines.merged(listOf(Line("a", "", 0, 100))))
    }

    @Test fun `a tap adds to the line that is there, or makes one that goes last`() {
        val one = DocLines.add(emptyList(), "a", "", 1000, 4500)
        assertEquals(listOf(Line("a", "", 1000, 4500)), one)
        // the line keeps the cost it has: a second tap is not a second price
        assertEquals(listOf(Line("a", "", 2000, 4500)), DocLines.add(one, "a", "", 1000, 9999))
        assertEquals(listOf(Line("a", "", 1000, 4500), Line("a", "m", 1000, 0)), DocLines.add(one, "a", "m", 1000, -5))
    }

    @Test fun `a quantity typed is the quantity, and nothing takes the line away`() {
        val lines = listOf(Line("a", "", 1000, 4500), Line("b", "", 2000, 100))
        assertEquals(listOf(Line("a", "", 7500, 4500), Line("b", "", 2000, 100)), DocLines.setQty(lines, "a", "", 7500))
        assertEquals(listOf(Line("b", "", 2000, 100)), DocLines.setQty(lines, "a", "", 0))
        assertEquals(listOf(Line("a", "", 1000, 4500), Line("b", "", 2000, 250)), DocLines.setCost(lines, "b", "", 250))
        assertEquals(0L, DocLines.setCost(lines, "b", "", -1)[1].cost)
    }

    @Test fun `what the lines come to`() {
        val lines = listOf(Line("a", "", 12000, 4500), Line("b", "", 1500, 333))
        assertEquals(13500, DocLines.units(lines))
        // 1.5 at 3.33 is 4.995: a cent is rounded line by line, half up
        assertEquals(500L, DocLines.value(lines[1]))
        assertEquals(54000L + 500L, DocLines.value(lines))
    }

    private fun item(id: String, gone: Boolean = false, track: Boolean = true) = ItemEntity(id, "t", null, id, 1000, track_stock = track, deleted_at = if (gone) "2026-10-10" else null)
    private fun variant(id: String, item: String) = ItemVariantEntity(id, "t", item, id, 1000)

    @Test fun `the lines the server would refuse are found before it is asked`() {
        val items = listOf(item("plain"), item("sized"), item("removed", gone = true), item("fee", track = false)).associateBy { it.id }
        val variants = mapOf("sized" to listOf(variant("s", "sized"), variant("m", "sized")))
        val gone = { lines: List<Line> -> DocLines.gone(lines, items, { it.track_stock }, { variants[it].orEmpty() }) }
        val sound = listOf(Line("plain", "", 1000, 1), Line("sized", "s", 1000, 1))
        assertEquals(emptyList<Line>(), gone(sound))
        // a product that is gone, one nobody knows, one whose stock is not counted,
        // one that comes in variants and names none, one that names a variant that is gone
        val bad = listOf(Line("removed", "", 1000, 1), Line("nobody", "", 1000, 1), Line("fee", "", 1000, 1), Line("sized", "", 1000, 1), Line("sized", "xl", 1000, 1), Line("plain", "s", 1000, 1))
        assertEquals(bad, gone(sound + bad))
    }

    @Test fun `a quantity is said in units`() {
        assertEquals("3", DocLines.shown(3000))
        assertEquals("1.5", DocLines.shown(1500))
        assertEquals("0.35", DocLines.shown(350))
        assertEquals("0.350 kg", DocLines.shown(350, weighed = true))
    }

    @Test fun `what is typed on the keys is read as a quantity, and as a cost`() {
        assertEquals(3000, DocLines.typed("3"))
        assertEquals(1500, DocLines.typed(" 1.5 "))
        assertEquals(350, DocLines.typed("0.35"))
        assertEquals(0, DocLines.typed("0"))
        // a fourth decimal is rounded away, half up
        assertEquals(1235, DocLines.typed("1.2345"))
        assertEquals(null, DocLines.typed(""))
        assertEquals(null, DocLines.typed("."))
        assertEquals(null, DocLines.typed("-1"))
        assertEquals(null, DocLines.typed("2000000"))
        assertEquals(4500L, DocLines.typedCost("45"))
        assertEquals(4550L, DocLines.typedCost("45.5"))
        assertEquals(4534L, DocLines.typedCost("45.336"))
        assertEquals(0L, DocLines.typedCost("0"))
        assertEquals(null, DocLines.typedCost(""))
        assertEquals(null, DocLines.typedCost("-4"))
    }
}

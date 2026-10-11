package com.restopos.core.data

import com.restopos.core.data.CountBook.Line
import com.restopos.core.data.CountBook.Stock
import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// A count of the shelves on the tablet: what it is of, what a tap, a typed
// figure and a second thought do to it, what the review shows, and what is
// sent when it is completed.
class CountBookTest {
    private fun item(id: String, cat: String? = null, supplier: String? = null, brand: String? = null, track: Boolean = true, gone: Boolean = false) =
        ItemEntity(id, "t", cat, id, 1000, track_stock = track, supplier_id = supplier, brand = brand, deleted_at = if (gone) "2026-10-10" else null)
    private fun variant(id: String, item: String, gone: Boolean = false) = ItemVariantEntity(id, "t", item, id, 1000, deleted_at = if (gone) "2026-10-10" else null)

    private val items = listOf(
        item("soap", cat = "c1", supplier = "s1", brand = "Nike"), item("shirt", cat = "c1", brand = " nike "), item("rice", cat = "c2", supplier = "s1"),
        item("fee", cat = "c1", track = false), item("old", cat = "c1", gone = true),
    )
    private val variants = listOf(variant("s", "shirt"), variant("m", "shirt"), variant("xl", "shirt", gone = true))
    private fun scope(kind: String, id: String? = null, brand: String? = null) = CountBook.scope(kind, id, brand, items, { it.track_stock }, variants)

    @Test fun `a count begins with the lines of stock of what it is of`() {
        // a product with variants gives a line a variant and none for itself; what is not counted, or gone, gives none
        assertEquals(listOf(Stock("rice"), Stock("shirt", "s"), Stock("shirt", "m"), Stock("soap")), scope("all"))
        assertEquals(listOf(Stock("shirt", "s"), Stock("shirt", "m"), Stock("soap")), scope("category", "c1"))
        assertEquals(listOf(Stock("rice"), Stock("soap")), scope("supplier", "s1"))
        // a brand, whatever its capitals and the spaces round it
        assertEquals(listOf(Stock("shirt", "s"), Stock("shirt", "m"), Stock("soap")), scope("brand", brand = "NIKE "))
        assertEquals(emptyList<Stock>(), scope("brand", brand = " "))
        assertEquals(emptyList<Stock>(), scope("category"))
        assertEquals(emptyList<Stock>(), scope("shelf", "c1"))
    }

    @Test fun `it is called what the server calls it`() {
        assertEquals("The whole shop", CountBook.title("all", null, null, null))
        assertEquals("Clothing", CountBook.title("category", "Clothing", null, null))
        assertEquals("Maison Ltd", CountBook.title("supplier", null, "Maison Ltd", null))
        assertEquals("Nike", CountBook.title("brand", null, null, " Nike "))
        assertNull(CountBook.title("brand", null, null, "  "))
        assertNull(CountBook.title("category", null, null, null))
    }

    private val begun = listOf(Line("soap"), Line("shirt", "s"), Line("shirt", "m"))

    @Test fun `a tap is one more, a typed figure is that figure, and each keeps what the tablet held then`() {
        var lines = CountBook.add(begun, Stock("soap"), 1000, now = 100, level = 9000)
        lines = CountBook.add(lines, Stock("soap"), 1000, now = 200, level = 8000)
        assertEquals(Line("soap", "", 2000, 200, 8000), lines[0])
        // a product outside the count joins it
        lines = CountBook.add(lines, Stock("rice"), 1000, now = 300, level = 500)
        assertEquals(Line("rice", "", 1000, 300, 500), lines.last())
        // nothing is a figure too
        lines = CountBook.set(lines, Stock("shirt", "s"), 0, now = 400, level = 3000)
        assertEquals(Line("shirt", "s", 0, 400, 3000), lines[1])
        lines = CountBook.set(lines, Stock("soap"), 9000, now = 500, level = 10000)
        assertEquals(Line("soap", "", 9000, 500, 10000), lines[0])
        // back to not counted
        assertEquals(Line("soap"), CountBook.clear(lines, Stock("soap"))[0])
        // counted of those in it
        assertEquals(3 to 4, CountBook.progress(lines))
        val out = CountBook.leaveOut(lines, Stock("shirt", "m"), true)
        assertEquals(3 to 3, CountBook.progress(out))
        assertEquals(lines, CountBook.leaveOut(out, Stock("shirt", "m"), false))
        // counting what was left out puts it back in
        assertEquals(false, CountBook.add(out, Stock("shirt", "m"), 1000, 600, 0)[2].leftOut)
    }

    @Test fun `the review is of the shelf as it was when each line was counted`() {
        val lines = listOf(Line("soap", "", 9000, 500, 10000), Line("shirt", "s"), Line("shirt", "m", leftOut = true), Line("rice", "", 2000, 600, 1500), Line("tea", "", 4000, 700, 4000))
        // one soap was sold after it was counted: the tablet holds 9000 now, and the count was still one short
        val now = mapOf(Stock("soap") to 9000, Stock("shirt", "s") to 3000, Stock("rice") to 1500, Stock("tea") to 4000)
        val rows = CountBook.review(lines) { now[it] ?: 0 }
        assertEquals(listOf("soap" to -1000, "shirt" to null, "rice" to 500, "tea" to 0), rows.map { it.line.item to it.diff })
        assertEquals(listOf(10000, 3000, 1500, 4000), rows.map { it.expected })
        // two lines differ: half a unit over and one short; a line that matches is none of them
        assertEquals(Triple(2, 500, 1000), CountBook.totals(rows))
    }

    @Test fun `the lines a count would be refused for are found, and can be left out together`() {
        val byId = items.associateBy { it.id }
        val gone = { lines: List<Line> -> CountBook.gone(lines, byId, { it.track_stock }) { item -> variants.filter { it.item_id == item && it.deleted_at == null } } }
        val sound = listOf(Line("soap"), Line("shirt", "s"))
        assertEquals(emptyList<Line>(), gone(sound))
        val bad = listOf(Line("old"), Line("nobody"), Line("fee"), Line("shirt"), Line("shirt", "xl"), Line("soap", "s"))
        assertEquals(bad, gone(sound + bad))
        // one that is already left out is not named again
        assertEquals(emptyList<Line>(), gone(listOf(Line("old", leftOut = true))))
        val left = CountBook.leaveOutAll(sound + bad, bad)
        assertEquals(listOf(false, false, true, true, true, true, true, true), left.map { it.leftOut })
        assertEquals(emptyList<Line>(), gone(left))
    }

    @Test fun `every refusal has its own sentence`() {
        val codes = listOf("nothing-to-count", "bad-scope", "bad-uncounted", "bad-quantity", "unknown-store", "count-closed", "unknown-item", "not-counted", "pick-variant", "unknown-line", "forbidden", "conflict", "unknown-op", null, "something-new")
        val said = codes.map { CountBook.refused(it) }
        assertEquals(said.size, said.toSet().size)
        assertTrue(said.last().contains("something-new"))
    }

    @Test fun `what is sent is the server's example`() {
        // 2026-10-10T08:00:00Z and five minutes later
        val started = 1_791_619_200_000L
        val lines = listOf(Line("item-plain", "", 9000, started + 300_000, 10000), Line("item-sized", "variant-s"), Line("item-sized", "variant-m", leftOut = true))
        assertEquals(StockFixtures.payload("count-complete"), StockPayloads.countComplete("count-1", "store-1", "all", null, null, started, 0, "leave", lines, null))
        // who gave their word goes with it
        assertEquals("\"m-1\"", StockPayloads.countComplete("count-1", "store-1", "all", null, null, started, 0, "leave", lines, "m-1")["approved_by"].toString())
    }
}

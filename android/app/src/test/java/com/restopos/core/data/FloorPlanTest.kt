package com.restopos.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// A room's plan while it is being changed on the tablet: where a table may be
// put and how small it may be made, how tables added at once are numbered and
// placed, why a room cannot be saved yet, and what is sent. What is sent is
// held against the examples the server's own suite sends
// (db/tests/till-floor.test.cjs swaps their stand-in ids for real ones).
class FloorPlanTest {
    // unit tests run in android/app
    private val dir = File("../../db/tests/fixtures/till-floor")
    private fun payload(name: String): JsonElement = Json.parseToJsonElement(File(dir, "$name.json").readText()).jsonObject["payload"]!!
    private fun t(id: String, name: String, x: Int = 2, y: Int = 2, w: Int = 12, h: Int = 12, seats: Int = 4, shape: String = "square") =
        FloorPlan.Table(id, name, seats, shape, x, y, w, h)

    @Test fun `what is sent is what the server was tested with`() {
        val tables = listOf(t("table-1", "1"), t("table-2", " 2 ", x = 20, y = 4, w = 16, h = 14, seats = 6, shape = "round"))
        assertEquals(payload("floor-save"), FloorPlan.save("store-1", "Main", tables, listOf("table-3"), null))
        assertEquals(payload("room-rename"), FloorPlan.rename("store-1", "Main", " Dining room ", null))
        assertEquals(payload("room-remove"), FloorPlan.remove("store-1", "Terrace", null))
        // with the word of someone who may, it says whose
        assertEquals("\"m-1\"", FloorPlan.save("store-1", "Main", tables, emptyList(), "m-1")["approved_by"].toString())
        assertNull(FloorPlan.save("store-1", "Main", tables, emptyList(), null)["approved_by"])
    }

    @Test fun `a table is moved as far as the plan goes and no further`() {
        val a = t("a", "1")
        assertEquals(30 to 20, FloorPlan.moved(a, 30, 20).let { it.x to it.y })
        assertEquals(0 to 0, FloorPlan.moved(a, -5, -9).let { it.x to it.y })
        // the whole of it stays on the 100 by 60 plan
        assertEquals(88 to 48, FloorPlan.moved(a, 500, 500).let { it.x to it.y })
        assertEquals(12 to 12, FloorPlan.moved(a, 500, 500).let { it.w to it.h })
    }

    @Test fun `a table is sized between the least and the edge of the plan`() {
        val a = t("a", "1", x = 80, y = 40)
        assertEquals(20 to 20, FloorPlan.sized(a, 60, 60).let { it.w to it.h })
        assertEquals(FloorPlan.MIN to FloorPlan.MIN, FloorPlan.sized(a, 1, 1).let { it.w to it.h })
        assertEquals(15 to 9, FloorPlan.sized(a, 15, 9).let { it.w to it.h })
        // one the back office left smaller than the least here is not made bigger by being touched
        val small = t("s", "2", x = 96, y = 56, w = 4, h = 4)
        assertEquals(4 to 4, FloorPlan.sized(small, 1, 1).let { it.w to it.h })
        assertEquals(4 to 4, FloorPlan.sized(small, 50, 50).let { it.w to it.h })
    }

    @Test fun `tables added at once are numbered on and stand clear of one another`() {
        var n = 0
        val ids = { "new-" + (++n) }
        val room = listOf(t("a", "1"), t("b", "2", x = 17))
        val made = FloorPlan.add(room, setOf("1", "2", "4"), 3, 6, "round", "3", ids)
        // 4 is in another room: it is skipped
        assertEquals(listOf("3", "5", "6"), made.map { it.name })
        assertTrue(made.all { it.seats == 6 && it.shape == "round" && it.w == FloorPlan.NEW && it.h == FloorPlan.NEW })
        val all = room + made
        for (i in all.indices) for (j in 0 until i) {
            val p = all[i]; val q = all[j]
            assertTrue("${p.name} on ${q.name}", !(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h))
        }
        assertTrue(made.all { it.x >= 0 && it.y >= 0 && it.x + it.w <= FloorPlan.W && it.y + it.h <= FloorPlan.H })
        // a name with letters keeps them: T7 gives T7, T8
        assertEquals(listOf("T7", "T8"), FloorPlan.add(emptyList(), emptySet(), 2, 4, "square", "T7", ids).map { it.name })
        // a name with no number is numbered from one
        assertEquals(listOf("Bar 1", "Bar 2"), FloorPlan.add(emptyList(), emptySet(), 2, 4, "square", "Bar", ids).map { it.name })
        // never fewer than one, never more than fifty at once
        assertEquals(1, FloorPlan.add(emptyList(), emptySet(), 0, 4, "square", "1", ids).size)
        assertEquals(50, FloorPlan.add(emptyList(), emptySet(), 500, 4, "square", "1", ids).size)
    }

    @Test fun `the next number is the lowest no table has`() {
        assertEquals("1", FloorPlan.nextNumber(emptySet()))
        assertEquals("3", FloorPlan.nextNumber(setOf("1", "2", "4", "t3")))
    }

    @Test fun `why a room cannot be saved yet`() {
        assertNull(FloorPlan.problem(listOf(t("a", "1"), t("b", "2")), setOf("5"), 2))
        assertEquals("Every table needs a number.", FloorPlan.problem(listOf(t("a", "  ")), emptySet(), 0))
        assertTrue(FloorPlan.problem(listOf(t("a", "T1"), t("b", "t1")), emptySet(), 0)!!.startsWith("Two tables are called"))
        assertTrue(FloorPlan.problem(listOf(t("a", "5")), setOf("5"), 1)!!.contains("another room"))
        assertEquals("A store holds 300 tables at most.", FloorPlan.problem(listOf(t("a", "1")), emptySet(), 300))
    }
}

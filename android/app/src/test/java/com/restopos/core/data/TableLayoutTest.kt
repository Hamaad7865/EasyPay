package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

// The first-run set-up asks how many tables a room has and lays them out
// itself: numbered on from the store's last table, in rows on the 100 by 60
// plan the back office draws on. The owner moves them about there afterwards.
class TableLayoutTest {
    private fun room(n: Int, name: String = "Main", seats: Int = 4) = TableLayout.Room(name, n, seats)

    @Test fun `twelve tables are five across and three down`() {
        val t = TableLayout.grid(room(12), 1)
        assertEquals(12, t.size)
        assertEquals((1..12).map { it.toString() }, t.map { it.name })
        assertTrue(t.all { it.w == 12 && it.h == 12 && it.area == "Main" && it.seats == 4 })
        assertEquals(4 to 4, t[0].x to t[0].y)
        assertEquals(84 to 4, t[4].x to t[4].y) // the last of the first row
        assertEquals(4 to 24, t[5].x to t[5].y) // the first of the second
        assertEquals(24 to 44, t[11].x to t[11].y)
    }

    @Test fun `sixty are small and one is not huge`() {
        assertTrue(TableLayout.grid(room(60), 1).all { it.w == 6 && it.h == 6 })
        val one = TableLayout.grid(room(1), 1).single()
        assertEquals(12, one.w)
        assertEquals(19 to 24, one.x to one.y)
    }

    @Test fun `whatever the number, every table is on the plan and none is on another`() {
        for (n in 1..TableLayout.MOST) {
            val t = TableLayout.grid(room(n), 1)
            assertEquals(n, t.size)
            t.forEach {
                assertTrue("$n: ${it.name} is off the plan", it.x >= 0 && it.y >= 0 && it.x + it.w <= 100 && it.y + it.h <= 60)
                assertTrue("$n: ${it.name} is the wrong size", it.w == it.h && it.w in 4..12)
            }
            for (a in t.indices) for (b in a + 1 until t.size) {
                val p = t[a]; val q = t[b]
                val apart = p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y
                assertTrue("$n: ${p.name} is on ${q.name}", apart)
            }
        }
    }

    @Test fun `the next number is one more than the highest the store uses`() {
        assertEquals(1, TableLayout.next(emptyList()))
        assertEquals(8, TableLayout.next(listOf("1", "2", "Bar", "12a", " 7 ")))
        assertEquals(1, TableLayout.next(listOf("Terrace A", "Window")))
    }

    @Test fun `rooms are numbered on from one another and from the store's last table`() {
        val rooms = listOf(room(12), room(6, "Terrace"))
        val plan = TableLayout.plan(rooms, emptyList())
        assertEquals("1", plan[0].first().name)
        assertEquals((13..18).map { it.toString() }, plan[1].map { it.name })
        assertTrue(plan[1].all { it.area == "Terrace" })
        assertEquals("21", TableLayout.plan(rooms, (1..20).map { it.toString() })[0].first().name)
    }

    private fun read(vararg lines: Triple<String, String, String>, existing: List<String> = emptyList()) =
        TableLayout.read(lines.toList(), existing)
    private fun why(vararg lines: Triple<String, String, String>, existing: List<String> = emptyList()) =
        read(*lines, existing = existing).exceptionOrNull()?.message

    @Test fun `the form's lines are read as rooms`() {
        val r = read(Triple("  Main ", "12", ""), Triple("Terrace", " 6 ", "2")).getOrThrow()
        assertEquals(listOf("Main", "Terrace"), r.map { it.name })
        assertEquals(listOf(12, 6), r.map { it.count })
        assertEquals(listOf(4, 2), r.map { it.seats }) // seats left empty are four
        assertEquals(30, read(Triple("x".repeat(50), "1", "")).getOrThrow().single().name.length)
    }

    @Test fun `and what is wrong with them is said`() {
        assertEquals("Add a room", why())
        assertEquals("Give the room a name", why(Triple("  ", "12", "")))
        assertEquals("Type how many tables", why(Triple("Main", "", "")))
        assertEquals("Type how many tables", why(Triple("Main", "0", "")))
        assertEquals("Type how many tables", why(Triple("Main", "abc", "")))
        assertEquals("60 tables is the most for one room here. Add a second room, or lay it out in the back office.", why(Triple("Main", "61", "")))
        assertEquals("Seats are between 1 and 99", why(Triple("Main", "12", "0")))
        assertEquals("Seats are between 1 and 99", why(Triple("Main", "12", "100")))
        assertEquals("Two rooms are called Main", why(Triple("Main", "12", ""), Triple("main ", "4", "")))
        assertEquals(
            "There is already a room called Main. Its tables are changed in the back office.",
            why(Triple("MAIN", "12", ""), existing = listOf("Main", "Terrace")),
        )
    }
}

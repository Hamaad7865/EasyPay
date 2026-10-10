package com.restopos.core.data

import com.restopos.core.data.LabelList.Row
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class LabelListTest {
    @Test fun `a product tapped is one label, tapped again one more`() {
        val one = LabelList.add(emptyList(), "a")
        assertEquals(listOf(Row("a", 1)), one)
        val two = LabelList.add(LabelList.add(one, "b"), "a")
        // it stays where it was put: the list is in the order things were added
        assertEquals(listOf(Row("a", 2), Row("b", 1)), two)
        assertEquals(3, LabelList.total(two))
        assertEquals(listOf(Row("a", 2), Row("b", 6)), LabelList.add(two, "b", 5))
    }

    @Test fun `never more than 99 of one`() {
        val full = listOf(Row("a", 98))
        assertEquals(listOf(Row("a", 99)), LabelList.add(full, "a", 5))
        val at = listOf(Row("a", 99))
        assertSame(at, LabelList.add(at, "a"))
        assertEquals(listOf(Row("a", 99)), LabelList.set(emptyList(), "a", 500))
    }

    @Test fun `never more than 240 in one run`() {
        val rows = listOf(Row("a", 99), Row("b", 99), Row("c", 40))
        // two are left: a row is cut to them
        assertEquals(Row("d", 2), LabelList.add(rows, "d", 5).last())
        val full = LabelList.add(rows, "d", 5)
        assertEquals(240, LabelList.total(full))
        // and at the limit nothing is added, not even an empty row
        assertSame(full, LabelList.add(full, "e"))
        assertSame(full, LabelList.add(full, "c"))
        // typing a count is held to what the others leave
        assertEquals(Row("c", 42), LabelList.set(rows, "c", 99)[2])
    }

    @Test fun `a count typed replaces the count, and none takes the row off`() {
        val rows = listOf(Row("a", 2), Row("b", 1), Row("c", 4))
        assertEquals(listOf(Row("a", 2), Row("b", 12), Row("c", 4)), LabelList.set(rows, "b", 12))
        assertEquals(listOf(Row("a", 2), Row("c", 4)), LabelList.set(rows, "b", 0))
        assertEquals(listOf(Row("a", 2), Row("c", 4)), LabelList.set(rows, "b", -3))
        assertEquals(rows, LabelList.set(rows, "z", 0))
    }

    @Test fun `the bars stand for the barcode, else the SKU, else nothing`() {
        assertEquals("5901234123457", LabelList.code("5901234123457", "SML-1"))
        assertEquals("SML-1", LabelList.code(null, "SML-1"))
        assertEquals("SML-1", LabelList.code("  ", " SML-1 "))
        assertNull(LabelList.code(null, null))
        assertNull(LabelList.code("", " "))
    }
}

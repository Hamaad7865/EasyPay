package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The till's own sheet for a category: its name and one of the swatches. The
// server checks the same things and has the last word.
class CategoryFormTest {
    @Test fun `a name makes a category, less the spaces around it`() {
        val c = CategoryForm.read("  Grill  ", null).getOrThrow()
        assertEquals("Grill", c.name)
        assertNull(c.color)
    }

    @Test fun `a name has to be there, and is cut at sixty`() {
        assertEquals("Give it a name", CategoryForm.read("   ", null).exceptionOrNull()?.message)
        assertEquals(60, CategoryForm.read("x".repeat(90), null).getOrThrow().name.length)
    }

    @Test fun `a colour is sent as the back office writes it, and none is none`() {
        assertEquals("#b9521c", CategoryForm.read("Grill", "#B9521C").getOrThrow().color)
        assertNull(CategoryForm.read("Grill", "").getOrThrow().color)
        assertTrue(CategoryForm.read("Grill", "red").isFailure)
    }

    @Test fun `there are twelve swatches, each a colour and no two the same`() {
        assertEquals(12, CategoryForm.SWATCHES.size)
        assertEquals(12, CategoryForm.SWATCHES.map { it.lowercase() }.toSet().size)
        assertTrue(CategoryForm.SWATCHES.all { Regex("#[0-9A-Fa-f]{6}").matches(it) })
    }

    @Test fun `a colour chosen in the back office is shown beside the swatches, and kept`() {
        val shown = CategoryForm.shown("#123456")
        assertEquals(13, shown.size)
        assertEquals("#123456", shown.last())
        assertEquals(12, CategoryForm.shown(CategoryForm.SWATCHES[2].lowercase()).size)
        assertEquals(12, CategoryForm.shown("nonsense").size)
        assertEquals(12, CategoryForm.shown(null).size)
    }

    @Test fun `the same colour, however it is written, is the same swatch`() {
        assertTrue(CategoryForm.same("#B9521C", "#b9521c"))
        assertTrue(CategoryForm.same(null, ""))
        assertTrue(!CategoryForm.same("#B9521C", null))
    }

    @Test fun `what the server refuses is said in words`() {
        assertTrue(CategoryForm.refused("has-items").contains("items"))
        assertTrue(CategoryForm.refused("unknown-op").contains("updated"))
        assertNotEquals(CategoryForm.refused("forbidden"), CategoryForm.refused("bad-category"))
        assertTrue(CategoryForm.refused("something-new").contains("something-new"))
    }
}

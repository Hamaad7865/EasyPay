package com.restopos.core.data

import com.restopos.core.database.CategoryEntity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Sub categories, one level deep: the list of categories shows the top ones,
// and the one picked opens to "All Shirt" and its subs. In the DAO's order.
class CategoryTreeTest {
    private fun c(id: String, name: String, parent: String? = null, sort: Int = 0) = CategoryEntity(id, "t", name, sort_order = sort, parent_id = parent)
    private val cats = listOf(
        c("shirt", "Shirt", sort = 1),
        c("long", "Long Sleeve", "shirt", 1),
        c("short", "Short Sleeve", "shirt", 1),
        c("shoes", "Shoes", sort = 2),
    )
    // each row as "label" with its depth and whether it is on: "  *All Shirt"
    private fun shown(rows: List<CatRow>) = rows.map { "  ".repeat(it.depth) + (if (it.on) "*" else "") + it.label }

    @Test fun `nothing picked shows the top ones only`() {
        assertEquals(listOf("Shirt", "Shoes"), shown(CategoryTree.rows(cats, null)))
    }

    @Test fun `picking Shirt opens it, All Shirt on, then its subs under it`() {
        val rows = CategoryTree.rows(cats, "shirt")
        assertEquals(listOf("Shirt", "  *All Shirt", "  Long Sleeve", "  Short Sleeve", "Shoes"), shown(rows))
        // All Shirt is the top one's own id: tapping it shows Shirt and its subs
        assertEquals("shirt", rows[1].id)
    }

    @Test fun `picking Long Sleeve shows it on, under Shirt`() {
        assertEquals(listOf("Shirt", "  All Shirt", "  *Long Sleeve", "  Short Sleeve", "Shoes"), shown(CategoryTree.rows(cats, "long")))
    }

    @Test fun `a top one with no subs is only itself, lit`() {
        assertEquals(listOf("Shirt", "*Shoes"), shown(CategoryTree.rows(cats, "shoes")))
    }

    @Test fun `in a line of chips a sub follows a mark, All Shirt does not`() {
        assertEquals(listOf("Shirt", "All Shirt", "› Long Sleeve", "› Short Sleeve", "Shoes"), CategoryTree.chips(cats, "shirt").map { it.label })
    }

    @Test fun `a top one's count holds its subs' products, a sub's only its own`() {
        val n = CategoryTree.counts(cats, mapOf("shirt" to 2, "long" to 5, "short" to 3, "shoes" to 4))
        assertEquals(10, n["shirt"])
        assertEquals(5, n["long"])
        assertEquals(4, n["shoes"])
        // a top one holding nothing itself still counts what its subs hold; one with none has no number
        assertEquals(5, CategoryTree.counts(cats, mapOf("long" to 5))["shirt"])
        assertNull(CategoryTree.counts(cats, emptyMap())["shoes"])
        assertEquals(listOf(10, 10, 5, 3, 4), CategoryTree.rows(cats, "shirt", mapOf("shirt" to 2, "long" to 5, "short" to 3, "shoes" to 4)).map { it.count })
    }

    @Test fun `what a pick covers - a top one with its subs, a sub alone, All everything`() {
        assertEquals(setOf("shirt", "long", "short"), CategoryTree.covers(cats, "shirt"))
        assertEquals(setOf("long"), CategoryTree.covers(cats, "long"))
        assertEquals(setOf("shoes"), CategoryTree.covers(cats, "shoes"))
        assertNull(CategoryTree.covers(cats, null))
    }

    @Test fun `a sub whose parent is not here shows as a top one`() {
        val orphan = listOf(c("long", "Long Sleeve", "gone", 1), c("shoes", "Shoes", sort = 2))
        assertEquals(listOf("*Long Sleeve", "Shoes"), shown(CategoryTree.rows(orphan, "long")))
        assertEquals(setOf("long"), CategoryTree.covers(orphan, "long"))
    }

    @Test fun `a removed sub is not shown`() {
        val removed = cats.map { if (it.id == "short") it.copy(deleted_at = "2026-10-29T08:00:00Z") else it }
        assertEquals(listOf("Shirt", "  *All Shirt", "  Long Sleeve", "Shoes"), shown(CategoryTree.rows(removed, "shirt")))
    }

    @Test fun `a sub takes its parent's place for its colour, and moves no other`() {
        assertEquals(mapOf("shirt" to 0, "long" to 0, "short" to 0, "shoes" to 1), CategoryTree.places(cats))
    }
}

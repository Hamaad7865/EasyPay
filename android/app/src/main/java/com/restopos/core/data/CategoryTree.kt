package com.restopos.core.data

import com.restopos.core.database.CategoryEntity

// One row of a list of categories. depth 1 is under a top one: its "All
// Shirt" row (the top one's own id) or one of its subs. on: the row whose
// products are on show. count: how many products it holds, a top one's subs'
// included; null when it holds none.
data class CatRow(val id: String, val label: String, val depth: Int, val on: Boolean, val count: Int?)

// Sub categories, one level deep (server 0145): Shirt › Long Sleeve. A list
// of categories shows the top ones; the one picked, or the one whose sub is
// picked, opens under itself to "All Shirt" and then each of its subs. The
// categories come as the DAO lists them (by place, then name) and keep that
// order. A sub whose parent is not here (removed, or not pulled yet) stands
// at the top, so its products can still be found.
object CategoryTree {
    // the top ones in their order, and each one's subs in theirs
    private class Tree(val tops: List<CategoryEntity>, val subs: Map<String, List<CategoryEntity>>)

    private fun tree(cats: List<CategoryEntity>): Tree {
        val live = cats.filter { it.deleted_at == null }
        val byId = live.associateBy { it.id }
        // the one it sits under; one under a sub stands at the top too (the server never makes one)
        fun parentOf(c: CategoryEntity): String? = c.parent_id?.let { byId[it] }
            ?.takeIf { p -> p.id != c.id && p.parent_id?.let { byId[it] } == null }?.id
        val (subs, tops) = live.partition { parentOf(it) != null }
        return Tree(tops, subs.groupBy { parentOf(it)!! })
    }

    // The rows of a list of categories. picked: the category on show, null
    // for All. direct: how many products each holds itself, as the DAO counts
    // them, for the numbers beside the names.
    fun rows(cats: List<CategoryEntity>, picked: String?, direct: Map<String, Int> = emptyMap()): List<CatRow> {
        val t = tree(cats)
        val n = counts(cats, direct)
        return t.tops.flatMap { top ->
            val under = t.subs[top.id].orEmpty()
            val open = under.isNotEmpty() && (picked == top.id || under.any { it.id == picked })
            if (!open) listOf(CatRow(top.id, top.name, 0, top.id == picked, n[top.id]))
            else listOf(CatRow(top.id, top.name, 0, false, n[top.id]), CatRow(top.id, "All ${top.name}", 1, top.id == picked, n[top.id])) +
                under.map { CatRow(it.id, it.name, 1, it.id == picked, n[it.id]) }
        }
    }

    // The same for a line of chips, where nothing is indented: a sub's name
    // follows a "›", as it follows its top one. "All Shirt" stays as it is.
    fun chips(cats: List<CategoryEntity>, picked: String?): List<CatRow> {
        val tops = tree(cats).tops.map { it.id }.toSet()
        return rows(cats, picked).map { if (it.depth > 0 && it.id !in tops) it.copy(label = "› ${it.label}") else it }
    }

    // How many products each category holds, a top one's subs' added to its
    // own. direct: each one's own; one that holds none is left out, as there.
    fun counts(cats: List<CategoryEntity>, direct: Map<String, Int>): Map<String, Int> {
        val out = direct.filterValues { it > 0 }.toMutableMap()
        tree(cats).subs.forEach { (top, under) ->
            val theirs = under.sumOf { direct[it.id] ?: 0 }
            if (theirs > 0) out[top] = (direct[top] ?: 0) + theirs
        }
        return out
    }

    // The categories whose products show when one is picked: null for All,
    // a top one with its subs, a sub on its own.
    fun covers(cats: List<CategoryEntity>, picked: String?): Set<String>? {
        if (picked == null) return null
        return setOf(picked) + tree(cats).subs[picked].orEmpty().map { it.id }
    }

    // Each category's place, for the colour it is painted in when it has none
    // of its own (catColor): a top one's among the top ones, so a sub does not
    // move the colours of those after it; a sub's is its parent's.
    fun places(cats: List<CategoryEntity>): Map<String, Int> {
        val t = tree(cats)
        val at = t.tops.mapIndexed { i, c -> c.id to i }.toMap()
        return at + t.subs.flatMap { (top, under) -> under.map { it.id to at.getValue(top) } }
    }
}

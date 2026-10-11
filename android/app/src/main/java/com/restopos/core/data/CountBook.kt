package com.restopos.core.data

import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity

// A count of the shelves, kept on the tablet until it is completed: which
// lines of stock it is of, what was counted of each and when, and what the
// tablet held of each at that moment. Quantities are thousandths (one unit is
// 1000), "no variant" is "", and a moment is the tablet's clock in
// milliseconds, as everywhere on the till.
//
// What the tablet held of a line when it was counted is kept with the figure
// (`expected`), so that a sale made after the line was counted does not show
// as a difference: the count is of the shelf as it was when someone looked at
// it. The server works the same thing out its own way when the count is sent
// (count_complete, 0074 and 0092), and has the last word for a linked till.
object CountBook {
    // a line of stock: a product, or one variant of it
    data class Stock(val item: String, val variant: String = "")

    // counted null: nobody counted it. expected: what the tablet held of it when it was last counted.
    data class Line(val item: String, val variant: String = "", val counted: Int? = null, val countedAt: Long? = null, val expected: Int? = null, val leftOut: Boolean = false) {
        val stock: Stock get() = Stock(item, variant)
    }

    private fun same(l: Line, s: Stock) = l.item == s.item && l.variant == s.variant

    // The lines of stock a count begins with: every product whose stock is
    // counted, one line for a product without variants and one for each of
    // its variants for one with; of the whole shop ("all"), one category, one
    // supplier, or one brand (whatever its capitals and the spaces round it).
    fun scope(kind: String, scopeId: String?, brand: String?, items: List<ItemEntity>, counted: (ItemEntity) -> Boolean, variants: List<ItemVariantEntity>): List<Stock> {
        val live = variants.filter { it.deleted_at == null }.groupBy { it.item_id }
        val wanted = brand?.trim()?.lowercase().orEmpty()
        return items.filter { it.deleted_at == null && counted(it) }.filter { item ->
            when (kind) {
                "all" -> true
                "category" -> scopeId != null && item.category_id == scopeId
                "supplier" -> scopeId != null && item.supplier_id == scopeId
                "brand" -> wanted.isNotEmpty() && item.brand?.trim()?.lowercase() == wanted
                else -> false
            }
        }.sortedBy { it.name.lowercase() }.flatMap { item -> live[item.id]?.map { Stock(item.id, it.id) } ?: listOf(Stock(item.id)) }
    }

    // What the count is called, as the server calls it; null when there is nothing to count by.
    fun title(kind: String, category: String?, supplier: String?, brand: String?): String? = when (kind) {
        "all" -> "The whole shop"
        "category" -> category
        "supplier" -> supplier
        "brand" -> brand?.trim()?.take(120)?.ifEmpty { null }
        else -> null
    }

    // A scan or a tap: `by` more of it. A line of stock that was not in the
    // count joins it. level: what the tablet holds of it at this moment.
    fun add(lines: List<Line>, s: Stock, by: Int, now: Long, level: Int): List<Line> =
        if (lines.any { same(it, s) }) lines.map { if (same(it, s)) it.copy(counted = (it.counted ?: 0) + by, countedAt = now, expected = level, leftOut = false) else it }
        else lines + Line(s.item, s.variant, by.coerceAtLeast(0), now, level)

    // A figure typed: this many, and nothing is a figure too.
    fun set(lines: List<Line>, s: Stock, units: Int, now: Long, level: Int): List<Line> =
        if (lines.any { same(it, s) }) lines.map { if (same(it, s)) it.copy(counted = units.coerceAtLeast(0), countedAt = now, expected = level, leftOut = false) else it }
        else lines + Line(s.item, s.variant, units.coerceAtLeast(0), now, level)

    // Back to not counted.
    fun clear(lines: List<Line>, s: Stock): List<Line> = lines.map { if (same(it, s)) it.copy(counted = null, countedAt = null, expected = null) else it }

    // Left out of this count: it is neither counted nor set to anything.
    fun leaveOut(lines: List<Line>, s: Stock, out: Boolean): List<Line> = lines.map { if (same(it, s)) it.copy(leftOut = out) else it }
    fun leaveOutAll(lines: List<Line>, these: List<Line>): List<Line> {
        val keys = these.map { it.stock }.toSet()
        return lines.map { if (it.stock in keys) it.copy(leftOut = true) else it }
    }

    // How many are counted, of those not left out.
    fun progress(lines: List<Line>): Pair<Int, Int> = lines.filter { !it.leftOut }.let { live -> live.count { it.counted != null } to live.size }

    // A line as the review shows it. diff null: nobody counted it.
    data class Row(val line: Line, val expected: Int, val diff: Int?)

    // Counted: against what the tablet held when it was counted. Not counted:
    // what it holds now, and no difference. Lines that were left out are not in it.
    fun review(lines: List<Line>, levelNow: (Stock) -> Int): List<Row> = lines.filter { !it.leftOut }.map { l ->
        val counted = l.counted
        if (counted == null) Row(l, levelNow(l.stock), null)
        else (l.expected ?: levelNow(l.stock)).let { was -> Row(l, was, counted - was) }
    }

    // Lines that differ, units over, units short.
    fun totals(rows: List<Row>): Triple<Int, Int, Int> {
        val diffs = rows.mapNotNull { it.diff }.filter { it != 0 }
        return Triple(diffs.size, diffs.filter { it > 0 }.sum(), -diffs.filter { it < 0 }.sum())
    }

    // The lines a count would be refused for (not left out, and the product
    // is gone, its stock is no longer counted, it has variants and the line
    // names none, or names one that is gone), so that the review can name
    // them and offer to leave them out.
    fun gone(lines: List<Line>, items: Map<String, ItemEntity>, counted: (ItemEntity) -> Boolean, variantsOf: (String) -> List<ItemVariantEntity>): List<Line> =
        lines.filter { !it.leftOut }.filter { l ->
            val item = items[l.item]?.takeIf { it.deleted_at == null } ?: return@filter true
            if (!counted(item)) return@filter true
            val variants = variantsOf(l.item)
            if (l.variant.isEmpty()) variants.isNotEmpty() else variants.none { it.id == l.variant }
        }

    fun refused(code: String?): String = lineRefused(code) ?: when (code) {
        "nothing-to-count" -> "There is nothing in this count. Count something, or throw the count away."
        "bad-scope" -> "What this count was of is no longer there. Throw it away and start another."
        "bad-uncounted" -> "Say what happens to what was not counted: left as it is, or set to nothing."
        "bad-quantity" -> "A figure in this count cannot be read. Count that line again."
        "unknown-store" -> "This till's store is no longer there. Set the till up again."
        "count-closed" -> "This count was completed already."
        "forbidden" -> "You are not allowed to count stock. Ask a manager."
        "conflict" -> "That did not work. Close this and try again."
        "unknown-op" -> "The server has to be updated before a count can be completed on a till."
        null -> "The count was refused."
        else -> "The count was refused ($code)."
    }
}

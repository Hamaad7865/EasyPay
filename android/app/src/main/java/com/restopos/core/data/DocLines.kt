package com.restopos.core.data

import com.restopos.core.database.ItemEntity
import com.restopos.core.database.ItemVariantEntity

// The lines of an order to a supplier, or of a delivery: a product (or one
// variant of it), how much, and what one costs. Quantities are thousandths
// (one unit is 1000), costs are cents, and "no variant" is "", as everywhere
// on the till. The server checks all of it again (doc_lines, stock_line_ok in
// migration 0074) and has the last word; this is what the screen works with
// before it asks.
object DocLines {
    data class Line(val item: String, val variant: String = "", val qty: Int, val cost: Long)

    private fun same(l: Line, item: String, variant: String) = l.item == item && l.variant == variant

    // One line a product: quantities added, the cost averaged by quantity and
    // rounded, as the server does it, in the order each product was first met.
    fun merged(lines: List<Line>): List<Line> =
        lines.filter { it.qty > 0 }.groupBy { it.item to it.variant }.map { (key, group) ->
            val qty = group.sumOf { it.qty.toLong() }
            val worth = group.sumOf { it.qty.toLong() * it.cost }
            Line(key.first, key.second, qty.toInt(), (worth + qty / 2) / qty)
        }

    // A tap or a scan: `by` more of it. A product that is not there yet goes last, at `cost`.
    fun add(lines: List<Line>, item: String, variant: String, by: Int, cost: Long): List<Line> =
        if (lines.any { same(it, item, variant) }) lines.map { if (same(it, item, variant)) it.copy(qty = it.qty + by) else it }
        else lines + Line(item, variant, by, cost.coerceAtLeast(0))

    // The quantity as typed. Nothing, or less, takes the line away.
    fun setQty(lines: List<Line>, item: String, variant: String, qty: Int): List<Line> =
        if (qty <= 0) lines.filterNot { same(it, item, variant) }
        else lines.map { if (same(it, item, variant)) it.copy(qty = qty) else it }

    fun setCost(lines: List<Line>, item: String, variant: String, cost: Long): List<Line> =
        lines.map { if (same(it, item, variant)) it.copy(cost = cost.coerceAtLeast(0)) else it }

    fun units(lines: List<Line>): Int = lines.sumOf { it.qty }

    // What a line is worth, and what they all are: the quantity at its cost,
    // rounded to the cent line by line, as the back office adds it up.
    fun value(line: Line): Long = Math.round(line.qty * line.cost / 1000.0)
    fun value(lines: List<Line>): Long = lines.sumOf { value(it) }

    // The lines the server would refuse, so that the screen can name them: the
    // product is gone, its stock is not counted, it comes in variants and the
    // line names none, or the variant it names is gone.
    // variantsOf: a product's variants that are still there.
    fun gone(lines: List<Line>, items: Map<String, ItemEntity>, counted: (ItemEntity) -> Boolean, variantsOf: (String) -> List<ItemVariantEntity>): List<Line> =
        lines.filter { l ->
            val item = items[l.item]?.takeIf { it.deleted_at == null } ?: return@filter true
            if (!counted(item)) return@filter true
            val variants = variantsOf(l.item)
            if (l.variant.isEmpty()) variants.isNotEmpty() else variants.none { it.id == l.variant }
        }

    // A quantity as someone says it: 3, 1.5, or 0.350 kg for what is weighed.
    fun shown(qty: Int, weighed: Boolean = false): String = LinePrice.qty(qty, weighed)

    // A quantity as it was typed on the till's keys, in thousandths: "3" is
    // 3000, "1.5" is 1500. Nothing typed, or something that is no number, is
    // none; more than a million units is not a quantity anyone ordered.
    fun typed(text: String): Int? {
        val n = text.trim().toBigDecimalOrNull() ?: return null
        if (n.signum() < 0 || n > java.math.BigDecimal(1_000_000)) return null
        return n.movePointRight(3).setScale(0, java.math.RoundingMode.HALF_UP).toInt()
    }
    // the same for what one costs, in cents: "45" is 4500, "45.5" is 4550
    fun typedCost(text: String): Long? {
        val n = text.trim().toBigDecimalOrNull() ?: return null
        if (n.signum() < 0 || n > java.math.BigDecimal(10_000_000)) return null
        return n.movePointRight(2).setScale(0, java.math.RoundingMode.HALF_UP).toLong()
    }
}

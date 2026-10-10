package com.restopos.core.data

// The lines of a run of labels: which, and how many of each. The limits are
// the back office's own (its Barcode labels page): enough for a delivery, and
// low enough that one slip of the finger cannot spool a whole roll.
object LabelList {
    const val MOST_EACH = 99
    const val MOST_RUN = 240

    data class Row(val key: String, val copies: Int)

    fun total(rows: List<Row>): Int = rows.sumOf { it.copies }

    // `by` more of it: a new row at the end, or more on the row it has. Never
    // past either limit; when nothing can be added the list comes back as it
    // was, the same object, which is how the screen knows to say so.
    fun add(rows: List<Row>, key: String, by: Int = 1): List<Row> {
        val had = rows.firstOrNull { it.key == key }?.copies ?: 0
        val more = minOf(by, MOST_RUN - total(rows), MOST_EACH - had)
        if (more <= 0) return rows
        return if (had > 0) rows.map { if (it.key == key) it.copy(copies = had + more) else it } else rows + Row(key, more)
    }

    // The count as typed, held to both limits. None takes the row off.
    fun set(rows: List<Row>, key: String, copies: Int): List<Row> {
        val others = total(rows.filter { it.key != key })
        val n = copies.coerceIn(0, minOf(MOST_EACH, MOST_RUN - others).coerceAtLeast(0))
        if (n == 0) return rows.filter { it.key != key }
        return if (rows.any { it.key == key }) rows.map { if (it.key == key) it.copy(copies = n) else it } else rows + Row(key, n)
    }

    // What a line's bars stand for: its barcode; without one its SKU, which
    // the till finds a product by just the same; with neither, nothing.
    fun code(barcode: String?, sku: String?): String? =
        barcode?.trim()?.takeIf { it.isNotEmpty() } ?: sku?.trim()?.takeIf { it.isNotEmpty() }
}

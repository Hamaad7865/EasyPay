package com.restopos.core.print

// A template and one product's words, as what is drawn and where, in the
// printer's own dots. Everything that can be decided without drawing is
// decided here and tested: which words are left out, whether the code gets
// bars and how wide they are, and what is said when it does not. The drawing
// itself is LabelPaint's.
object LabelLayout {
    fun dots(mm: Float, dpi: Int): Int = Math.round(mm * dpi / 25.4f)

    sealed class Item {
        // words centred in a box, `px` dots high, on at most `lines` lines
        data class Words(val x: Int, val y: Int, val w: Int, val h: Int, val text: String, val px: Int, val bold: Boolean, val lines: Int) : Item()
        // a symbol from `x` (where its clear space starts), each module `module` dots wide
        class Bars(val x: Int, val y: Int, val h: Int, val module: Int, val bits: BooleanArray) : Item()
        // a black rectangle
        data class Rect(val x: Int, val y: Int, val w: Int, val h: Int) : Item()
    }

    // `noBars`: why a label that should carry bars does not, for the screen
    // to say before anything is printed; null when it has them or wants none.
    class Placed(val width: Int, val height: Int, val items: List<Item>, val noBars: String?)

    const val NO_CODE = "No barcode or SKU, so this label has no bars."
    const val TOO_WIDE = "This code is too wide for bars on a label this size, so it prints as characters."
    const val NOT_IN_BARS = "This code has a character that bars cannot hold, so it prints as characters."

    fun place(t: LabelTemplate, w: LabelWords, dpi: Int): Placed {
        fun d(mm: Float) = dots(mm, dpi)
        val items = ArrayList<Item>()
        var noBars: String? = null
        // a template with no place for the variant says it after the name
        val ownVariant = t.elements.any { it is LabelElement.Text && it.field == "variant" }
        val code = w.code?.trim().orEmpty()
        for (e in t.elements) when (e) {
            is LabelElement.Text -> {
                val said = when (e.field) {
                    "shop" -> w.shop
                    "name" -> if (!ownVariant && w.variant.isNotBlank()) "${w.name.trim()}, ${w.variant.trim()}" else w.name
                    "variant" -> w.variant
                    "price" -> w.price
                    "code" -> code
                    else -> e.text
                }.trim()
                if (said.isNotEmpty()) items += Item.Words(d(e.x), d(e.y), d(e.w), d(e.h), said, d(e.size).coerceAtLeast(1), e.bold, e.lines.coerceAtLeast(1))
            }
            is LabelElement.Bars -> {
                val x = d(e.x)
                val y = d(e.y)
                val bw = d(e.w)
                val bh = d(e.h)
                if (code.isEmpty()) { noBars = NO_CODE; continue }
                val symbol = LabelBars.symbol(code)
                val module = symbol?.let { LabelBars.module(it.bits.size, bw, dpi) }
                if (symbol == null || module == null) {
                    // no bars rather than bars too thin to scan: the code is still on the label, to be typed
                    noBars = if (symbol == null) NOT_IN_BARS else TOO_WIDE
                    items += Item.Words(x, y, bw, bh, code, d(minOf(3f, e.h * 0.45f)).coerceAtLeast(1), true, 1)
                } else {
                    val digits = if (e.digits > 0f) d(e.digits) else 0
                    val gap = if (digits > 0) d(0.4f) else 0
                    val high = (bh - digits - gap).coerceAtLeast(1)
                    items += Item.Bars(x + (bw - symbol.bits.size * module) / 2, y, high, module, symbol.bits)
                    if (digits > 0) items += Item.Words(x, y + high + gap, bw, digits, code, digits, false, 1)
                }
            }
            is LabelElement.Box -> {
                val x = d(e.x)
                val y = d(e.y)
                val bw = d(e.w)
                val bh = d(e.h)
                val k = d(e.thick).coerceAtLeast(1)
                items += Item.Rect(x, y, bw, k)
                items += Item.Rect(x, y + bh - k, bw, k)
                items += Item.Rect(x, y, k, bh)
                items += Item.Rect(x + bw - k, y, k, bh)
            }
        }
        return Placed(d(t.widthMm), d(t.heightMm), items, noBars)
    }
}

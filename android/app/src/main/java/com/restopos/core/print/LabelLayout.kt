package com.restopos.core.print

// A template and one product's words, as what is drawn and where, in the
// printer's own dots. Everything that can be decided without drawing is
// decided here and tested: which words are left out, whether the code gets
// bars and how wide they are, and what is said when it does not. The drawing
// itself is LabelPaint's.
object LabelLayout {
    fun dots(mm: Float, dpi: Int): Int = Math.round(mm * dpi / 25.4f)

    sealed class Item {
        // words in a box, `px` dots high, on at most `lines` lines, set left, center or right
        data class Words(
            val x: Int, val y: Int, val w: Int, val h: Int, val text: String, val px: Int, val bold: Boolean, val lines: Int,
            val align: String = "center",
        ) : Item()
        // a symbol from `x` (where its clear space starts), each module `module` dots wide
        class Bars(val x: Int, val y: Int, val h: Int, val module: Int, val bits: BooleanArray) : Item()
        // a black rectangle
        data class Rect(val x: Int, val y: Int, val w: Int, val h: Int) : Item()
        // the shop's logo, fitted into this box
        data class Picture(val x: Int, val y: Int, val w: Int, val h: Int) : Item()
        // Things turned by 90, 180 or 270 degrees in the box x, y, w, h on the
        // label. `items` are placed in a frame of their own that starts at 0,0:
        // as wide and as high as the box, or for a quarter turn as wide as the
        // box is high. The painter turns that frame into the box.
        class Turned(val x: Int, val y: Int, val w: Int, val h: Int, val turn: Int, val items: List<Item>) : Item()
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
                    "sku" -> w.sku
                    "category" -> w.category
                    "date" -> w.date
                    else -> e.text
                }.trim()
                val align = if (e.align == "left" || e.align == "right") e.align else "center"
                if (said.isNotEmpty()) {
                    items += turned(d(e.x), d(e.y), d(e.w), d(e.h), e.turn) { wide, high ->
                        listOf(Item.Words(0, 0, wide, high, said, d(e.size).coerceAtLeast(1), e.bold, e.lines.coerceAtLeast(1), align))
                    }
                }
            }
            is LabelElement.Bars -> {
                if (code.isEmpty()) { noBars = NO_CODE; continue }
                items += turned(d(e.x), d(e.y), d(e.w), d(e.h), e.turn) { wide, high ->
                    val (drawn, why) = bars(code, wide, high, e, dpi)
                    noBars = why
                    drawn
                }
            }
            is LabelElement.Line -> items += Item.Rect(d(e.x), d(e.y), d(e.w).coerceAtLeast(1), d(e.h).coerceAtLeast(1))
            is LabelElement.Logo -> items += Item.Picture(d(e.x), d(e.y), d(e.w).coerceAtLeast(1), d(e.h).coerceAtLeast(1))
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

    // A quarter turn there is, and no other: anything else is no turn.
    fun quarter(turn: Int): Int = (((turn % 360) + 360) % 360).let { if (it % 90 == 0) it else 0 }

    // What `make` places in a frame `wide` by `high` that starts at 0,0, put
    // into the box on the label: moved there as it is, or turned into it.
    private fun turned(x: Int, y: Int, w: Int, h: Int, turn: Int, make: (wide: Int, high: Int) -> List<Item>): List<Item> {
        val q = quarter(turn)
        if (q == 0) return make(w, h).map { it.at(x, y) }
        val side = q == 90 || q == 270
        return listOf(Item.Turned(x, y, w, h, q, make(if (side) h else w, if (side) w else h)))
    }

    private fun Item.at(dx: Int, dy: Int): Item = when (this) {
        is Item.Words -> copy(x = x + dx, y = y + dy)
        is Item.Bars -> Item.Bars(x + dx, y + dy, h, module, bits)
        is Item.Rect -> copy(x = x + dx, y = y + dy)
        is Item.Picture -> copy(x = x + dx, y = y + dy)
        is Item.Turned -> Item.Turned(x + dx, y + dy, w, h, turn, items)
    }

    // The code in a frame `wide` by `high`: its bars, centred, with the code in
    // letters under them; or, when no bars of a width that scans fit, the code
    // alone and why.
    private fun bars(code: String, wide: Int, high: Int, e: LabelElement.Bars, dpi: Int): Pair<List<Item>, String?> {
        val symbol = LabelBars.symbol(code)
        val module = symbol?.let { LabelBars.module(it.bits.size, wide, dpi) }
        if (symbol == null || module == null) {
            // no bars rather than bars too thin to scan: the code is still on the label, to be typed
            val px = minOf(dots(3f, dpi), (high * 0.45f).toInt()).coerceAtLeast(1)
            return listOf<Item>(Item.Words(0, 0, wide, high, code, px, true, 1)) to (if (symbol == null) NOT_IN_BARS else TOO_WIDE)
        }
        val digits = if (e.digits > 0f) dots(e.digits, dpi) else 0
        val gap = if (digits > 0) dots(0.4f, dpi) else 0
        val tall = (high - digits - gap).coerceAtLeast(1)
        val out = ArrayList<Item>()
        out += Item.Bars((wide - symbol.bits.size * module) / 2, 0, tall, module, symbol.bits)
        if (digits > 0) out += Item.Words(0, tall + gap, wide, digits, code, digits, false, 1)
        return out to null
    }
}

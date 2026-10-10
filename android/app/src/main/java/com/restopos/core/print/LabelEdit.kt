package com.restopos.core.print

// Every change the label designer makes to a label, as a plain function of
// the label: the screen only says what was tapped or dragged, and what comes
// back is a label that can be printed. Nothing is ever moved, sized or turned
// off the label, nothing shrinks to where it could not be seen or picked up
// again, and a change asked of something that is not there changes nothing.
object LabelEdit {
    // a nudge, and the grid things are dropped on
    const val STEP = 0.5f
    // a label, in millimetres: from the smallest price sticker to the widest
    // roll a four-inch printer takes
    val WIDE = 15f..110f
    val HIGH = 10f..150f
    val GAP = 0f..10f
    // the height of letters, and how thick a line or a box's edge is
    val LETTERS = 1.2f..20f
    val THICK = 0.2f..3f

    // What can be put on a label: its kind, and what it is called. The first
    // eight are words a label carries for each product; the others are the
    // shop's own text, the bars, a line, a box and the logo.
    val KINDS: List<Pair<String, String>> = listOf(
        "shop" to "Shop name", "name" to "Product name", "variant" to "Variant", "price" to "Price",
        "category" to "Category", "sku" to "SKU", "date" to "Today's date", "code" to "Code in digits",
        "text" to "Text", "bars" to "Barcode", "line" to "Line", "box" to "Box", "logo" to "Logo",
    )
    private val FIELDS: Map<String, String> = KINDS.take(8).toMap()

    class Box(val x: Float, val y: Float, val w: Float, val h: Float)

    fun box(e: LabelElement): Box = when (e) {
        is LabelElement.Text -> Box(e.x, e.y, e.w, e.h)
        is LabelElement.Bars -> Box(e.x, e.y, e.w, e.h)
        is LabelElement.Line -> Box(e.x, e.y, e.w, e.h)
        is LabelElement.Box -> Box(e.x, e.y, e.w, e.h)
        is LabelElement.Logo -> Box(e.x, e.y, e.w, e.h)
    }

    private fun LabelElement.boxed(x: Float, y: Float, w: Float, h: Float): LabelElement = when (this) {
        is LabelElement.Text -> copy(x = x, y = y, w = w, h = h)
        is LabelElement.Bars -> copy(x = x, y = y, w = w, h = h)
        is LabelElement.Line -> copy(x = x, y = y, w = w, h = h)
        is LabelElement.Box -> copy(x = x, y = y, w = w, h = h)
        is LabelElement.Logo -> copy(x = x, y = y, w = w, h = h)
    }

    private fun sideways(turn: Int): Boolean = LabelLayout.quarter(turn).let { it == 90 || it == 270 }

    // The least a thing may be, across and down: under it, it could not be
    // read, scanned or picked up with a finger again.
    fun least(e: LabelElement): Pair<Float, Float> = when (e) {
        is LabelElement.Text -> if (sideways(e.turn)) 1.5f to 3f else 3f to 1.5f
        is LabelElement.Bars -> if (sideways(e.turn)) 4f to 8f else 8f to 4f
        is LabelElement.Line -> THICK.start to THICK.start
        is LabelElement.Box -> 2f to 2f
        is LabelElement.Logo -> 4f to 4f
    }

    private fun snap(v: Float): Float = Math.round(v / STEP) * STEP
    private fun tenth(v: Float): Float = Math.round(v * 10f) / 10f
    private fun halfUp(v: Float): Float = Math.ceil(v / STEP.toDouble()).toFloat() * STEP

    // The thing with that box, as near to it as the label allows: no smaller
    // than its least, no bigger than the label, and wholly on it.
    private fun fit(t: LabelTemplate, e: LabelElement, x: Float, y: Float, w: Float, h: Float): LabelElement {
        val (lw, lh) = least(e)
        val wide = w.coerceIn(minOf(lw, t.widthMm), t.widthMm)
        val high = h.coerceIn(minOf(lh, t.heightMm), t.heightMm)
        return e.boxed(x.coerceIn(0f, t.widthMm - wide), y.coerceIn(0f, t.heightMm - high), wide, high)
    }

    private fun put(t: LabelTemplate, at: Int, e: LabelElement): LabelTemplate =
        t.copy(elements = t.elements.mapIndexed { i, was -> if (i == at) e else was })

    // ---- a label ----
    fun blank(id: String, name: String, widthMm: Float = 40f, heightMm: Float = 30f): LabelTemplate =
        LabelTemplate(id, name, snap(widthMm).coerceIn(WIDE), snap(heightMm).coerceIn(HIGH), 2f, emptyList())

    fun copy(of: LabelTemplate, id: String, name: String): LabelTemplate = of.copy(id = id, name = name)

    // Its size and the gap to the next one, within the limits; what would be
    // left outside the new size is brought back in.
    fun resize(t: LabelTemplate, widthMm: Float, heightMm: Float, gapMm: Float): LabelTemplate {
        val sized = t.copy(widthMm = snap(widthMm).coerceIn(WIDE), heightMm = snap(heightMm).coerceIn(HIGH), gapMm = snap(gapMm).coerceIn(GAP))
        return sized.copy(elements = t.elements.map { e -> box(e).let { b -> fit(sized, e, b.x, b.y, b.w, b.h) } })
    }

    // why it cannot be saved yet
    fun problem(t: LabelTemplate): String? = when {
        t.name.isBlank() -> "Give the label a name"
        t.elements.isEmpty() -> "Put something on the label first"
        else -> null
    }

    // ---- what is on it ----
    // One more thing, last (on top): under what is there already when there is room, at the top otherwise.
    fun add(t: LabelTemplate, kind: String): LabelTemplate {
        val wide = t.widthMm
        val high = t.heightMm
        val edge = if (wide < 25f || high < 15f) 0.5f else 1.5f
        val across = wide - 2 * edge
        val under = t.elements.maxOfOrNull { box(it).let { b -> b.y + b.h } }
        fun top(h: Float): Float = (if (under == null) edge else snap(under + STEP)).let { if (it + h > high) edge else it }
        fun letters(size: Float): Float = tenth(size.coerceAtMost(high * 0.3f).coerceIn(LETTERS))
        val e: LabelElement = when (kind) {
            in FIELDS, "text" -> {
                val size = letters(when (kind) { "price" -> 4.5f; "name" -> 3.2f; else -> 2.8f })
                val h = halfUp(size * 1.25f)
                LabelElement.Text(
                    edge, top(h), across, h, field = if (kind == "text") "" else kind, text = if (kind == "text") "Text" else "",
                    size = size, bold = kind == "price" || kind == "name" || kind == "shop",
                )
            }
            "bars" -> {
                val h = minOf(10f, snap(high * 0.4f)).coerceAtLeast(4f)
                LabelElement.Bars(edge, top(h), minOf(across, 40f), h, digits = if (h >= 7f) 2.4f else 0f)
            }
            "line" -> LabelElement.Line(edge, top(0.3f), across, 0.3f)
            "box" -> LabelElement.Box(0.5f, 0.5f, wide - 1f, high - 1f)
            "logo" -> minOf(10f, minOf(wide, high) - 2 * edge).coerceAtLeast(4f).let { s -> LabelElement.Logo(edge, top(s), s, s) }
            else -> return t
        }
        val b = box(e)
        return t.copy(elements = t.elements + fit(t, e, b.x, b.y, b.w, b.h))
    }

    fun remove(t: LabelTemplate, at: Int): LabelTemplate =
        if (at !in t.elements.indices) t else t.copy(elements = t.elements.filterIndexed { i, _ -> i != at })

    // dropped on the half-millimetre grid, and never off the label
    fun moveTo(t: LabelTemplate, at: Int, x: Float, y: Float): LabelTemplate {
        val e = t.elements.getOrNull(at) ?: return t
        val b = box(e)
        return put(t, at, fit(t, e, snap(x), snap(y), b.w, b.h))
    }

    fun move(t: LabelTemplate, at: Int, dx: Float, dy: Float): LabelTemplate {
        val b = t.elements.getOrNull(at)?.let { box(it) } ?: return t
        return moveTo(t, at, b.x + dx, b.y + dy)
    }

    // Sized from where it is: on the grid, never under its least, never past
    // the label's edge. A line is sized along its length only; how thick it
    // is, is `bigger`'s.
    fun sizeTo(t: LabelTemplate, at: Int, w: Float, h: Float): LabelTemplate {
        val e = t.elements.getOrNull(at) ?: return t
        val b = box(e)
        val (wide, high) = when {
            e !is LabelElement.Line -> snap(w) to snap(h)
            b.w >= b.h -> snap(w).coerceAtLeast(1f) to b.h
            else -> b.w to snap(h).coerceAtLeast(1f)
        }
        return put(t, at, fit(t, e, b.x, b.y, minOf(wide, t.widthMm - b.x), minOf(high, t.heightMm - b.y)))
    }

    // A quarter turn about its middle: words and bars are turned, and so is
    // their box; a line or a box only swaps its sides. The logo is not turned.
    fun turn(t: LabelTemplate, at: Int): LabelTemplate {
        val e = t.elements.getOrNull(at) ?: return t
        val turned = when (e) {
            is LabelElement.Text -> e.copy(turn = (LabelLayout.quarter(e.turn) + 90) % 360)
            is LabelElement.Bars -> e.copy(turn = (LabelLayout.quarter(e.turn) + 90) % 360)
            is LabelElement.Logo -> return t
            else -> e
        }
        val b = box(e)
        return put(t, at, fit(t, turned, b.x + (b.w - b.h) / 2f, b.y + (b.h - b.w) / 2f, b.h, b.w))
    }

    // A+ and A-: a text's letters by 0.3 mm a step, its box growing with them;
    // a line's thickness, or a box's edge, by a tenth. Bars and the logo have
    // nothing of the kind.
    fun bigger(t: LabelTemplate, at: Int, by: Int): LabelTemplate {
        val e = t.elements.getOrNull(at) ?: return t
        val b = box(e)
        return when (e) {
            is LabelElement.Text -> {
                val sized = e.copy(size = tenth((e.size + by * 0.3f).coerceIn(LETTERS)))
                // room for its lines, across the way they run
                val room = halfUp(sized.size * 1.25f * sized.lines.coerceAtLeast(1))
                put(t, at, if (sideways(e.turn)) fit(t, sized, b.x, b.y, maxOf(b.w, room), b.h) else fit(t, sized, b.x, b.y, b.w, maxOf(b.h, room)))
            }
            is LabelElement.Line ->
                if (b.w >= b.h) put(t, at, fit(t, e, b.x, b.y, b.w, tenth((b.h + by * 0.1f).coerceIn(THICK))))
                else put(t, at, fit(t, e, b.x, b.y, tenth((b.w + by * 0.1f).coerceIn(THICK)), b.h))
            is LabelElement.Box -> put(t, at, e.copy(thick = tenth((e.thick + by * 0.1f).coerceIn(THICK))))
            else -> t
        }
    }

    // the thing as the panel changed it (bold, where it is set, its words, its box), kept on the label
    fun with(t: LabelTemplate, at: Int, e: LabelElement): LabelTemplate {
        if (at !in t.elements.indices) return t
        val b = box(e)
        return put(t, at, fit(t, e, b.x, b.y, b.w, b.h))
    }

    // ---- for the screen ----
    // What is under a finger at x, y: the smallest thing there, so that words
    // inside a frame can be picked; of two as small, the one on top. Something
    // thinner than three millimetres takes a millimetre and a half round it.
    fun hit(t: LabelTemplate, x: Float, y: Float): Int? {
        var best: Int? = null
        var least = Float.MAX_VALUE
        t.elements.forEachIndexed { i, e ->
            val b = box(e)
            val px = if (b.w < 3f) 1.5f else 0f
            val py = if (b.h < 3f) 1.5f else 0f
            if (x >= b.x - px && x <= b.x + b.w + px && y >= b.y - py && y <= b.y + b.h + py && b.w * b.h <= least) {
                best = i
                least = b.w * b.h
            }
        }
        return best
    }

    // what a thing is called in the list of what is on the label
    fun says(e: LabelElement): String = when (e) {
        is LabelElement.Text -> FIELDS[e.field] ?: ("Text: " + e.text.trim().take(24))
        is LabelElement.Bars -> "Barcode"
        is LabelElement.Line -> "Line"
        is LabelElement.Box -> "Box"
        is LabelElement.Logo -> "Logo"
    }
}

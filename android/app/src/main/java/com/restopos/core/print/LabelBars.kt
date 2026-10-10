package com.restopos.core.print

import com.google.zxing.oned.Code128Writer
import com.google.zxing.oned.EAN13Writer
import kotlin.math.ceil

// The bars on a label. Which bars stand for a code is ZXing's to work out
// (the library every scanning app reads them back with); how wide they are
// drawn is decided here, because a label printer prints whole dots: a bar a
// dot and a half wide comes out as one or as two, and the code no longer
// scans. Nothing here knows about Android.
object LabelBars {
    // The bars with the clear space a scanner needs on both sides of them,
    // one entry for each module (the width of the thinnest bar).
    class Symbol(val bits: BooleanArray, val ean: Boolean)

    // Thirteen digits, the last of them the check the other twelve give.
    fun isEan13(code: String): Boolean {
        if (code.length != 13 || code.any { it !in '0'..'9' }) return false
        val sum = code.take(12).mapIndexed { i, c -> (c - '0') * if (i % 2 == 0) 1 else 3 }.sum()
        return (10 - sum % 10) % 10 == code[12] - '0'
    }

    // EAN-13 for a code that is one, as on a maker's packet; Code 128 for
    // anything else a scanner can read back as the same characters (a short
    // code, a SKU). Null for what cannot be put in bars: nothing, more than
    // forty characters, or a character outside plain ASCII.
    fun symbol(code: String): Symbol? {
        val c = code.trim()
        if (c.isEmpty() || c.length > 40 || c.any { it.code !in 32..126 }) return null
        return runCatching {
            if (isEan13(c)) Symbol(BooleanArray(11) + EAN13Writer().encode(c) + BooleanArray(7), true)
            else Symbol(BooleanArray(10) + Code128Writer().encode(c) + BooleanArray(10), false)
        }.getOrNull()
    }

    // How many dots the thinnest bar is, for a symbol of `modules` in a box
    // `boxDots` across: as many as fit, never under a quarter of a millimetre
    // (thinner does not scan off thermal paper) and never over half of one.
    // Null when even the thinnest does not fit.
    fun module(modules: Int, boxDots: Int, dpi: Int): Int? {
        if (modules <= 0) return null
        val least = ceil(0.25 * dpi / 25.4).toInt().coerceAtLeast(1)
        val most = ceil(0.5 * dpi / 25.4).toInt()
        val fits = boxDots / modules
        return if (fits < least) null else minOf(fits, most)
    }
}

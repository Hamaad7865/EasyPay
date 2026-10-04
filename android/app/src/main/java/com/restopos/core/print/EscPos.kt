package com.restopos.core.print

import java.io.ByteArrayOutputStream
import java.nio.charset.Charset

// The bytes a thermal printer understands (ESC/POS, the language of Epson
// and of nearly every 58 mm and 80 mm receipt printer). Nothing here knows
// about Android or about receipts: it lays text out in a fixed number of
// columns and adds the commands for bold, size, alignment, feed, cut and the
// cash drawer.
class EscPos(val columns: Int) {
    private val out = ByteArrayOutputStream()
    // Western European, so "Crevettes sautées à l'ail" prints as written. A
    // character the page lacks is printed without its accent, or as "?".
    private val charset: Charset = Charset.forName("windows-1252")
    private val encoder = charset.newEncoder()

    init {
        raw(0x1B, 0x40) // reset
        raw(0x1B, 0x74, 16) // code page WPC1252
    }

    private fun raw(vararg b: Int) = apply { b.forEach { out.write(it) } }

    fun align(a: Align) = raw(0x1B, 0x61, a.ordinal)
    fun bold(on: Boolean) = raw(0x1B, 0x45, if (on) 1 else 0)
    // wide and tall: twice the size, half the columns
    fun big(on: Boolean) = raw(0x1D, 0x21, if (on) 0x11 else 0x00)
    fun tall(on: Boolean) = raw(0x1D, 0x21, if (on) 0x01 else 0x00)

    fun text(s: String) = apply { out.write(encode(s)) }
    fun line(s: String = "") = text(s).raw(0x0A)

    // A long line is wrapped at spaces, never cut in the middle of a word
    // unless the word alone is wider than the paper.
    fun wrapped(s: String, width: Int = columns, indent: String = "") = apply {
        wrap(s, width - indent.length).forEach { line(indent + it) }
    }

    fun center(s: String) = align(Align.Center).apply { wrap(s, columns).forEach { line(it) } }.align(Align.Left)

    fun rule(ch: Char = '-') = line(ch.toString().repeat(columns))

    // "2 Dholl puri            100.00": the left text wraps, the right text
    // sits at the end of its first line.
    fun row(left: String, right: String, width: Int = columns) = apply {
        val room = (width - right.length - 1).coerceAtLeast(4)
        val parts = wrap(left, room)
        parts.forEachIndexed { i, p ->
            if (i == 0) line(p.padEnd(width - right.length) + right) else line(p)
        }
        if (parts.isEmpty()) line(right.padStart(width))
    }

    fun feed(lines: Int) = apply { repeat(lines.coerceIn(0, 20)) { raw(0x0A) } }
    fun cut() = raw(0x1D, 0x56, 0x42, 0x00)
    // pin 2, the usual wiring of a drawer plugged into the printer
    fun drawer() = raw(0x1B, 0x70, 0x00, 0x19, 0xFA)

    // A black and white picture: one bit per dot, rows of `widthBytes` bytes.
    fun raster(widthBytes: Int, height: Int, bits: ByteArray) = apply {
        raw(0x1D, 0x76, 0x30, 0x00, widthBytes and 0xFF, (widthBytes shr 8) and 0xFF, height and 0xFF, (height shr 8) and 0xFF)
        out.write(bits, 0, minOf(bits.size, widthBytes * height))
    }

    fun bytes(): ByteArray = out.toByteArray()

    private fun encode(s: String): ByteArray {
        val sb = StringBuilder(s.length)
        for (ch in s) {
            sb.append(
                when {
                    ch == '’' || ch == '‘' -> '\''
                    ch == ' ' -> ' '
                    encoder.canEncode(ch) -> ch
                    else -> java.text.Normalizer.normalize(ch.toString(), java.text.Normalizer.Form.NFD).firstOrNull { encoder.canEncode(it) } ?: '?'
                },
            )
        }
        return sb.toString().toByteArray(charset)
    }

    enum class Align { Left, Center, Right }

    companion object {
        // characters per line in the standard font
        fun columnsFor(paperMm: Int): Int = if (paperMm <= 58) 32 else 48
        // dots across the printable width
        fun dotsFor(paperMm: Int): Int = if (paperMm <= 58) 384 else 576

        fun wrap(s: String, width: Int): List<String> {
            val w = width.coerceAtLeast(1)
            val lines = ArrayList<String>()
            for (para in s.split('\n')) {
                var cur = StringBuilder()
                for (word in para.trim().split(' ').filter { it.isNotEmpty() }) {
                    var rest = word
                    while (rest.length > w) { // a word wider than the paper
                        if (cur.isNotEmpty()) { lines.add(cur.toString()); cur = StringBuilder() }
                        lines.add(rest.take(w)); rest = rest.drop(w)
                    }
                    if (cur.isEmpty()) cur.append(rest)
                    else if (cur.length + 1 + rest.length <= w) cur.append(' ').append(rest)
                    else { lines.add(cur.toString()); cur = StringBuilder(rest) }
                }
                if (cur.isNotEmpty()) lines.add(cur.toString())
            }
            return lines
        }
    }
}

package com.restopos.core.display

import com.restopos.core.common.Money
import java.text.Normalizer

// What a 2-line customer pole display (a VFD of 2 lines of 20 characters on
// a stand, plugged into the till by USB) shows, and the bytes that put it
// there. Plain rules, tested on their own; core/display/PoleDisplay writes
// them to the display.
//
//   during a sale   the last line rung up and its amount / TOTAL and what is left to pay
//   after Pay       TOTAL and the total / CHANGE and the change
//   between sales   the display's message, or the business's name
//
// Such displays know ASCII alone: French and Kreol accents are taken off.
object PoleText {
    const val WIDTH = 20

    // The two kinds of command these displays take, set by a switch on most:
    // Epson's (ESC/POS for customer displays) and CD5220's.
    const val EPSON = "epson"
    const val CD5220 = "cd5220"

    data class Words(val total: String = "TOTAL", val change: String = "CHANGE", val balance: String = "BALANCE", val welcome: String = "WELCOME")

    fun words(lang: String): Words = when (lang) {
        "fr" -> Words("TOTAL", "MONNAIE", "RESTE", "BIENVENUE")
        "mfe" -> Words("TOTAL", "LAMONNEN", "RESTE", "BYENVENI")
        else -> Words()
    }

    fun lines(p: Picture, w: Words = words(p.lang)): Pair<String, String> {
        fun rs(c: Long) = "Rs " + Money.plain(c, p.decimals)
        return when (p.state) {
            Picture.SALE -> {
                val last = p.lines.lastOrNull()
                val top = if (last == null) "" else pair(last.name, Money.plain(last.amount, p.decimals))
                top to pair(if (p.paid > 0) w.balance else w.total, rs(p.left))
            }
            Picture.PAID -> pair(w.total, rs(p.total)) to pair(w.change, rs(p.change))
            else -> {
                val message = p.message.lines().map { it.trim() }.filter { it.isNotEmpty() }
                when {
                    message.size >= 2 -> fit(message[0]) to fit(message[1])
                    message.size == 1 -> fit(p.business.ifBlank { w.welcome }) to fit(message[0])
                    else -> fit(p.business.ifBlank { w.welcome }) to fit(if (p.business.isBlank()) "" else w.welcome)
                }
            }
        }
    }

    // a label on the left and a figure on the right, in 20 characters: the label gives way
    fun pair(left: String, right: String): String {
        val r = ascii(right).take(WIDTH)
        val room = WIDTH - r.length - 1
        val l = if (room <= 0) "" else ascii(left).take(room)
        return l + " ".repeat(WIDTH - l.length - r.length) + r
    }

    // text in 20 characters, centred
    fun fit(text: String): String {
        val t = ascii(text).take(WIDTH)
        val before = (WIDTH - t.length) / 2
        return " ".repeat(before) + t + " ".repeat(WIDTH - t.length - before)
    }

    // accents off; anything else that is not printable ASCII becomes a space
    fun ascii(text: String): String =
        Normalizer.normalize(text, Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")
            .map { if (it in ' '..'~') it else ' ' }.joinToString("")

    // The bytes that show two lines, in the display's kind of command.
    fun bytes(lines: Pair<String, String>, commands: String): ByteArray {
        val (top, bottom) = pad(lines.first) to pad(lines.second)
        val out = java.io.ByteArrayOutputStream()
        if (commands == CD5220) {
            // ESC Q A: the upper line, ESC Q B: the lower line, each ended by CR
            out.write(byteArrayOf(0x0C))
            out.write(byteArrayOf(0x1B, 'Q'.code.toByte(), 'A'.code.toByte())); out.write(top.toByteArray(Charsets.US_ASCII)); out.write(0x0D)
            out.write(byteArrayOf(0x1B, 'Q'.code.toByte(), 'B'.code.toByte())); out.write(bottom.toByteArray(Charsets.US_ASCII)); out.write(0x0D)
        } else {
            // ESC @ start afresh, FF clear, US $ x y put the cursor (1-based), then the text
            out.write(byteArrayOf(0x1B, 0x40, 0x0C))
            out.write(byteArrayOf(0x1F, 0x24, 0x01, 0x01)); out.write(top.toByteArray(Charsets.US_ASCII))
            out.write(byteArrayOf(0x1F, 0x24, 0x01, 0x02)); out.write(bottom.toByteArray(Charsets.US_ASCII))
        }
        return out.toByteArray()
    }

    private fun pad(line: String): String = ascii(line).take(WIDTH).padEnd(WIDTH)
}

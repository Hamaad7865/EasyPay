package com.restopos.core.data

// The cash counted in the drawer, as it is typed on the cash drawer screen.
// The field starts on what the drawer should hold, so a drawer that is right
// is confirmed without typing it out. Someone who may not see that figure
// starts on nothing: their count has to be their own. What is typed is in
// rupees ("1250", "1250.5"), and null means no key has been pressed yet.
object DrawerCount {
    const val DIGITS = 7 // up to Rs 9,999,999

    // what the field starts on, in cents: nothing for someone who may not see it
    fun start(expected: Long?, figures: Boolean): Long? = if (figures && expected != null) expected.coerceAtLeast(0) else null

    // The amount counted, in cents: what was typed, or else what the field
    // started on. Null means there is no amount yet, and nothing to record.
    fun counted(typed: String?, expected: Long?, figures: Boolean): Long? = if (typed != null) cents(typed) else start(expected, figures)

    // what was typed, in cents; null when it is empty
    fun cents(typed: String): Long? {
        if (typed.isEmpty()) return null
        val whole = typed.substringBefore('.').toLongOrNull() ?: return null
        val part = typed.substringAfter('.', "").take(2).padEnd(2, '0').toLongOrNull() ?: return null
        return whole * 100 + part
    }

    // an amount as it would have been typed: Rs 1,250.50 is "1250.5"
    fun text(cents: Long, places: Int): String {
        val v = cents.coerceAtLeast(0)
        if (places <= 0) return ((v + 50) / 100).toString()
        val part = (v % 100).toString().padStart(2, '0').take(places).trimEnd('0')
        return (v / 100).toString() + if (part.isEmpty()) "" else ".$part"
    }

    // what was typed, grouped for reading: "1250.5" is "1,250.5"
    fun shown(typed: String): String {
        val whole = typed.substringBefore('.')
        return whole.reversed().chunked(3).joinToString(",").reversed() + typed.substring(whole.length)
    }

    // One key of the pad: a digit ("7", "00"), ".", "del" or "clear". The
    // first digit replaces what the field started on; the delete key edits it.
    fun key(typed: String?, k: String, start: Long?, places: Int): String? = when (k) {
        "clear" -> ""
        "del" -> (typed ?: start?.let { text(it, places) } ?: "").dropLast(1)
        "." -> {
            val base = typed ?: ""
            when {
                places <= 0 -> typed
                base.contains('.') -> base
                base.isEmpty() -> "0."
                else -> "$base."
            }
        }
        else -> if (k.isEmpty() || k.any { !it.isDigit() }) typed else {
            var out = typed ?: ""
            for (ch in k) {
                val dot = out.indexOf('.')
                val full = if (dot >= 0) out.length - dot - 1 >= places else out.length >= DIGITS
                if (!full) out = if (out == "0") ch.toString() else out + ch
            }
            out
        }
    }
}

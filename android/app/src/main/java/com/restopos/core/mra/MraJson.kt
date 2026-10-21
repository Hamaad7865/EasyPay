package com.restopos.core.mra

// JSON as mra/invoice.cjs writes it with JSON.stringify: keys in the order
// given, nothing spaced, strings escaped the same way. The MRA accepted those
// bytes in its sandbox (2026-10-21); the till sends the same.
object MraJson {
    sealed interface J
    data class Str(val v: String) : J
    data class Obj(val fields: List<Pair<String, J>>) : J
    data class Arr(val items: List<J>) : J

    fun obj(vararg f: Pair<String, Any>) = Obj(f.map { (k, v) -> k to (if (v is J) v else Str(v as String)) })
    fun arr(items: List<J>) = Arr(items)
    fun encode(j: J): String = StringBuilder().also { write(it, j) }.toString()

    private fun write(sb: StringBuilder, j: J) {
        when (j) {
            is Str -> quote(sb, j.v)
            is Obj -> {
                sb.append('{')
                j.fields.forEachIndexed { i, (k, v) -> if (i > 0) sb.append(','); quote(sb, k); sb.append(':'); write(sb, v) }
                sb.append('}')
            }
            is Arr -> {
                sb.append('[')
                j.items.forEachIndexed { i, v -> if (i > 0) sb.append(','); write(sb, v) }
                sb.append(']')
            }
        }
    }

    // " and \ escaped, \b \f \n \r \t by name, the other control characters as
    // \u00xx, a surrogate without its pair as \udxxx (as JSON.stringify since
    // ES2019), everything else as it is
    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (i in s.indices) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> hex(sb, c)
                c.isHighSurrogate() && (i + 1 >= s.length || !s[i + 1].isLowSurrogate()) -> hex(sb, c)
                c.isLowSurrogate() && (i == 0 || !s[i - 1].isHighSurrogate()) -> hex(sb, c)
                else -> sb.append(c)
            }
        }
        sb.append('"')
    }

    private fun hex(sb: StringBuilder, c: Char) {
        sb.append("\\u").append(c.code.toString(16).padStart(4, '0'))
    }
}

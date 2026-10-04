package com.restopos.core.common

import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

// Category and tile colours arrive from the back office as CSS text: either
// "#rrggbb" or "oklch(L C H)". Returns opaque ARGB, or null when the text is
// missing or not one of those two forms (the screen then uses its own grey).
object CssColor {
    fun argb(css: String?): Int? {
        val s = css?.trim()?.lowercase() ?: return null
        if (s.startsWith("#")) return hex(s.drop(1))
        if (s.startsWith("oklch(") && s.endsWith(")")) {
            val parts = s.substring(6, s.length - 1).substringBefore('/').trim().split(Regex("[\\s,]+"))
            if (parts.size < 3) return null
            val l = if (parts[0].endsWith("%")) parts[0].dropLast(1).toDoubleOrNull()?.div(100) else parts[0].toDoubleOrNull()
            val c = parts[1].toDoubleOrNull()
            val h = parts[2].removeSuffix("deg").toDoubleOrNull()
            if (l == null || c == null || h == null) return null
            return oklch(l, c, h)
        }
        return null
    }

    private fun hex(h: String): Int? {
        val full = when (h.length) {
            3 -> h.map { "$it$it" }.joinToString("")
            6 -> h
            else -> return null
        }
        val rgb = full.toIntOrNull(16) ?: return null
        return (0xFF shl 24) or rgb
    }

    // OKLCH -> OKLab -> linear sRGB -> gamma sRGB (Ottosson's matrices).
    private fun oklch(l: Double, c: Double, hDeg: Double): Int {
        val h = Math.toRadians(hDeg)
        val a = c * cos(h)
        val b = c * sin(h)
        val l3 = (l + 0.3963377774 * a + 0.2158037573 * b).pow(3)
        val m3 = (l - 0.1055613458 * a - 0.0638541728 * b).pow(3)
        val s3 = (l - 0.0894841775 * a - 1.2914855480 * b).pow(3)
        val r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3
        val g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3
        val bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3
        return (0xFF shl 24) or (channel(r) shl 16) or (channel(g) shl 8) or channel(bl)
    }

    private fun channel(linear: Double): Int {
        val x = linear.coerceIn(0.0, 1.0)
        val srgb = if (x <= 0.0031308) 12.92 * x else 1.055 * x.pow(1 / 2.4) - 0.055
        return (srgb * 255).roundToInt().coerceIn(0, 255)
    }
}

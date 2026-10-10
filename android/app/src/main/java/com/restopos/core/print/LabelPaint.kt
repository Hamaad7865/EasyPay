package com.restopos.core.print

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils

// A label as a picture, dot for dot what the printer will print: the screen
// shows this same picture as the preview. Where things go was decided by
// LabelLayout; here they are only drawn.
object LabelPaint {
    fun bitmap(p: LabelLayout.Placed): Bitmap {
        val b = Bitmap.createBitmap(p.width.coerceAtLeast(1), p.height.coerceAtLeast(1), Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        c.drawColor(Color.WHITE)
        // no smoothing anywhere: a printer's dot is black or it is not, and a
        // grey edge would come out as a bar one dot wider or narrower
        val ink = Paint().apply { color = Color.BLACK; isAntiAlias = false; style = Paint.Style.FILL }
        for (i in p.items) when (i) {
            is LabelLayout.Item.Rect -> c.drawRect(i.x.toFloat(), i.y.toFloat(), (i.x + i.w).toFloat(), (i.y + i.h).toFloat(), ink)
            is LabelLayout.Item.Bars -> {
                var at = 0
                while (at < i.bits.size) {
                    if (!i.bits[at]) { at++; continue }
                    var end = at
                    while (end < i.bits.size && i.bits[end]) end++
                    c.drawRect((i.x + at * i.module).toFloat(), i.y.toFloat(), (i.x + end * i.module).toFloat(), (i.y + i.h).toFloat(), ink)
                    at = end
                }
            }
            is LabelLayout.Item.Words -> {
                val paint = TextPaint().apply {
                    color = Color.BLACK
                    isAntiAlias = false
                    textSize = i.px.toFloat()
                    typeface = Typeface.create(Typeface.SANS_SERIF, if (i.bold) Typeface.BOLD else Typeface.NORMAL)
                }
                // One line of words too wide for its box is drawn smaller, down to
                // half its size, rather than cut: a price must not lose its end.
                if (i.lines == 1) {
                    val wide = paint.measureText(i.text)
                    if (wide > i.w) paint.textSize = maxOf(i.px * 0.5f, kotlin.math.floor(i.px * i.w / wide))
                }
                // centred across its box; a name too long for its lines is cut with an ellipsis
                val layout = StaticLayout.Builder.obtain(i.text, 0, i.text.length, paint, i.w.coerceAtLeast(1))
                    .setAlignment(Layout.Alignment.ALIGN_CENTER)
                    .setMaxLines(i.lines)
                    .setEllipsize(TextUtils.TruncateAt.END)
                    .setIncludePad(false)
                    .build()
                c.save()
                c.clipRect(0, 0, p.width, p.height)
                c.translate(i.x.toFloat(), (i.y + (i.h - layout.height) / 2).toFloat())
                layout.draw(c)
                c.restore()
            }
        }
        return b
    }

    // One bit a dot, a set bit black, as the logo's raster is: a dot is black
    // when the picture is darker than half way there.
    fun raster(b: Bitmap): Raster {
        val w = b.width
        val h = b.height
        val widthBytes = (w + 7) / 8
        val px = IntArray(w * h)
        b.getPixels(px, 0, w, 0, 0, w, h)
        val bits = ByteArray(widthBytes * h)
        for (y in 0 until h) for (x in 0 until w) {
            val c = px[y * w + x]
            val lum = 0.299f * Color.red(c) + 0.587f * Color.green(c) + 0.114f * Color.blue(c)
            if (lum < 128f) bits[y * widthBytes + x / 8] = (bits[y * widthBytes + x / 8].toInt() or (0x80 shr (x % 8))).toByte()
        }
        return Raster(widthBytes, h, bits)
    }

    fun raster(p: LabelLayout.Placed): Raster = bitmap(p).let { b -> raster(b).also { b.recycle() } }
}

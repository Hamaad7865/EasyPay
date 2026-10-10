package com.restopos.core.print

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.Locale

// What a label looks like: its size, the gap to the next one on the roll, and
// what is on it and where, all in millimetres from the label's top left
// corner. A shop's own labels are kept on the tablet as this, written down as
// JSON (LabelBook), so whatever is added here has a default: a label written
// by an earlier build must still be read. The ready-made ones are below.
@Serializable
data class LabelTemplate(
    val id: String,
    val name: String,
    val widthMm: Float,
    val heightMm: Float,
    val gapMm: Float = 2f,
    val elements: List<LabelElement>,
) {
    // "40 x 30", as a roll of stickers is sold
    val size: String get() = "${mm(widthMm)} x ${mm(heightMm)}"

    companion object {
        // a whole number of millimetres without a decimal, another with one
        fun mm(v: Float): String = if (v % 1f == 0f) v.toInt().toString() else String.format(Locale.US, "%.1f", v)
    }
}

@Serializable
sealed class LabelElement {
    // Words in a box. `field` says which of the label's words (shop, name,
    // variant, price, code, sku, category, date); empty, the box holds `text`
    // as written. `size` is the height of the letters; `lines` how many the
    // box may take; `align` where they are set (left, center, right).
    // `turn` is 0, 90, 180 or 270: the box is where the words sit on the label
    // as it is seen, and turned a quarter they run down it or up it.
    @Serializable @SerialName("text")
    data class Text(
        val x: Float, val y: Float, val w: Float, val h: Float,
        val field: String = "", val text: String = "", val size: Float, val bold: Boolean = false, val lines: Int = 1,
        val align: String = "center", val turn: Int = 0,
    ) : LabelElement()

    // The bars of the label's code, with the code in letters `digits` high
    // under them (0: bars alone). Turned, as a text is.
    @Serializable @SerialName("bars")
    data class Bars(val x: Float, val y: Float, val w: Float, val h: Float, val digits: Float = 2.4f, val turn: Int = 0) : LabelElement()

    // A line: a bar of ink, as long and as thick as its box.
    @Serializable @SerialName("line")
    data class Line(val x: Float, val y: Float, val w: Float, val h: Float) : LabelElement()

    // The shop's logo, as the back office holds it, fitted into the box.
    @Serializable @SerialName("logo")
    data class Logo(val x: Float, val y: Float, val w: Float, val h: Float) : LabelElement()

    // A frame, its line `thick`.
    @Serializable @SerialName("box")
    data class Box(val x: Float, val y: Float, val w: Float, val h: Float, val thick: Float = 0.3f) : LabelElement()
}

// One label's words. The code is what the bars stand for: null when the
// product has neither a barcode nor a SKU.
class LabelWords(
    val shop: String, val name: String, val variant: String, val price: String, val code: String?,
    val sku: String = "", val category: String = "", val date: String = "",
)

// The labels a shop can print without designing one, in the sizes stickers
// are commonly sold in.
object LabelTemplates {
    const val DEFAULT = "40x30-full"

    private fun text(field: String, x: Float, y: Float, w: Float, h: Float, size: Float, bold: Boolean = false, lines: Int = 1) =
        LabelElement.Text(x, y, w, h, field = field, size = size, bold = bold, lines = lines)

    val all: List<LabelTemplate> = listOf(
        LabelTemplate(
            DEFAULT, "Name, price, barcode", 40f, 30f,
            elements = listOf(
                text("name", 1.5f, 1f, 37f, 7.6f, 3.2f, bold = true, lines = 2),
                text("variant", 1.5f, 8.8f, 37f, 3.1f, 2.6f),
                text("price", 1.5f, 12.4f, 37f, 5.2f, 4.6f, bold = true),
                LabelElement.Bars(2f, 18.5f, 36f, 10f),
            ),
        ),
        LabelTemplate(
            "50x25-shop", "Shop, name, price, barcode", 50f, 25f,
            elements = listOf(
                text("shop", 1.5f, 1f, 47f, 3.4f, 2.8f, bold = true),
                text("name", 1.5f, 4.5f, 47f, 3.6f, 3f),
                text("price", 1.5f, 8.2f, 47f, 5.4f, 4.6f, bold = true),
                LabelElement.Bars(3f, 14f, 44f, 10f),
            ),
        ),
        LabelTemplate(
            "25x15-name-price", "Name and price", 25f, 15f,
            elements = listOf(
                text("name", 1f, 1f, 23f, 6.2f, 2.6f, bold = true, lines = 2),
                text("price", 1f, 8.2f, 23f, 5.6f, 4.4f, bold = true),
            ),
        ),
        LabelTemplate("25x15-price", "Price only", 25f, 15f, elements = listOf(text("price", 1f, 3.5f, 23f, 8f, 6.5f, bold = true))),
        LabelTemplate(
            "25x15-price-bars", "Price and barcode", 25f, 15f,
            elements = listOf(
                text("price", 1f, 0.8f, 23f, 4.4f, 3.6f, bold = true),
                LabelElement.Bars(0.5f, 5.6f, 24f, 8.6f, digits = 2.2f),
            ),
        ),
    )

    // the label of that id; the first one for an id this build does not know
    fun byId(id: String?): LabelTemplate = all.firstOrNull { it.id == id } ?: all.first()

    // A label that proves a printer, in the size of `of`: a frame just inside
    // the edge (a label that is shifted or cut off loses a side of it), two
    // lines of words and bars. Black for white, or nothing at all, shows too.
    fun test(of: LabelTemplate): LabelTemplate {
        val w = of.widthMm
        val h = of.heightMm
        return LabelTemplate(
            "test", "Test label", w, h, of.gapMm,
            listOf(
                LabelElement.Box(0.4f, 0.4f, w - 0.8f, h - 0.8f),
                LabelElement.Text(1.5f, h * 0.08f, w - 3f, h * 0.20f, text = "EasyPay label test", size = minOf(3.2f, h * 0.17f, w * 0.08f), bold = true),
                LabelElement.Text(1.5f, h * 0.29f, w - 3f, h * 0.17f, text = "${of.size} mm", size = minOf(2.6f, h * 0.14f)),
                LabelElement.Bars(1.5f, h * 0.52f, w - 3f, h * 0.40f, digits = if (h < 20f) 0f else 2.2f),
            ),
        )
    }

    // The code on the test label: an EAN-13 where one fits at a width that
    // scans (113 modules of a quarter millimetre), a short code elsewhere.
    fun testCode(of: LabelTemplate): String = if (of.widthMm - 3f >= 29f) "2000000000008" else "1234"
}

package com.restopos.core.print

import java.io.ByteArrayOutputStream

// A run of labels as the bytes a printer takes. The label is already a
// picture (LabelPaint); here it is only wrapped, for one of two languages:
// TSPL, which sticker printers speak (TSC, Xprinter, Gprinter and the many
// like them), or ESC/POS for a receipt-type printer loaded with stickers.
// Nothing here knows about Android.
object LabelJob {
    // one label's picture, and how many of it
    class Label(val raster: Raster, val copies: Int)

    const val WIDER = "This label is wider than the printer's paper. Pick a smaller label, or a sticker printer."

    // A sticker printer has to be told the label's size and the gap to the
    // next one, or it cannot find where a label starts. The copies of one
    // label are the printer's to repeat, so they cost one picture.
    fun tspl(labels: List<Label>, widthMm: Float, heightMm: Float, gapMm: Float): ByteArray {
        val run = labels.filter { it.copies > 0 }
        if (run.isEmpty()) return ByteArray(0)
        val out = ByteArrayOutputStream()
        fun say(line: String) = out.write("$line\r\n".toByteArray(Charsets.US_ASCII))
        say("SIZE ${LabelTemplate.mm(widthMm)} mm,${LabelTemplate.mm(heightMm)} mm")
        say("GAP ${LabelTemplate.mm(gapMm)} mm,0 mm")
        say("DIRECTION 1")
        for (l in run) {
            say("CLS")
            val r = l.raster
            out.write("BITMAP 0,0,${r.widthBytes},${r.height},0,".toByteArray(Charsets.US_ASCII))
            // In TSPL a set bit leaves the dot white; in the raster it is a
            // black dot. Turned over byte by byte, which also leaves the
            // unused bits at the end of a row white.
            val n = minOf(r.bits.size, r.widthBytes * r.height)
            for (i in 0 until n) out.write(r.bits[i].toInt().inv() and 0xFF)
            say("")
            say("PRINT 1,${l.copies}")
        }
        return out.toByteArray()
    }

    // A receipt printer knows nothing of labels: it prints the picture, feeds
    // and cuts, once for each copy.
    fun escpos(labels: List<Label>, paperMm: Int): Result<ByteArray> = runCatching {
        val run = labels.filter { it.copies > 0 }
        if (run.isEmpty()) return@runCatching ByteArray(0)
        if (run.any { it.raster.widthBytes * 8 > EscPos.dotsFor(paperMm) }) throw PrintError(WIDER)
        val page = EscPos(EscPos.columnsFor(paperMm)).align(EscPos.Align.Center)
        for (l in run) repeat(l.copies) {
            page.raster(l.raster.widthBytes, l.raster.height, l.raster.bits).feed(3).cut()
        }
        page.bytes()
    }
}

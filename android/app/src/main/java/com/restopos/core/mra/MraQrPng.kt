package com.restopos.core.mra

import android.graphics.BitmapFactory
import android.graphics.Color
import com.restopos.core.database.MraInvoiceEntity
import com.restopos.core.print.Fiscal
import java.util.Base64

// What a receipt says of the MRA when it prints: its QR code (the PNG the MRA
// sent, base64, read with Android's BitmapFactory and made 2 x 2 cm), or "Not
// Yet Fiscalised" in its place; nothing for a receipt that never went to it.
object MraQrPng {
    // the MRA's PNG as it came, for the screen; null when there is none or it cannot be read
    fun bitmap(e: MraInvoiceEntity?): android.graphics.Bitmap? {
        val qr = e?.qr?.takeIf { it.isNotBlank() && e.status == "fiscalised" } ?: return null
        return runCatching { Base64.getDecoder().decode(qr).let { BitmapFactory.decodeByteArray(it, 0, it.size) } }.getOrNull()
    }

    fun fiscal(e: MraInvoiceEntity?): Fiscal? {
        e ?: return null
        val training = e.type == "TRN"
        if (e.status != "fiscalised" || e.qr.isNullOrBlank()) return Fiscal.NotYet(training)
        val raster = runCatching {
            val png = Base64.getDecoder().decode(e.qr)
            val b = BitmapFactory.decodeByteArray(png, 0, png.size) ?: return@runCatching null
            MraQr.raster(b.width, b.height) { x, y ->
                val c = b.getPixel(x, y)
                Color.alpha(c) > 127 && (Color.red(c) * 299 + Color.green(c) * 587 + Color.blue(c) * 114) / 1000 < 128
            }.also { b.recycle() }
        }.getOrNull() ?: return Fiscal.NotYet(training)
        return Fiscal.Qr(raster, training)
    }
}

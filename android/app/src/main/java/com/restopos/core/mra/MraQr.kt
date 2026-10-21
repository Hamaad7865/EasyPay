package com.restopos.core.mra

import com.restopos.core.print.Raster

// The QR code the MRA sends back (a 350 x 350 one-bit PNG), printed 2 x 2 cm
// as its guide asks: 160 dots at 8 a millimetre, each dot the pixel at the
// middle of its part of the picture. The PNG is read by the caller (Android's
// BitmapFactory), so this stays testable without Android.
object MraQr {
    const val DOTS = 160

    fun raster(w: Int, h: Int, dots: Int = DOTS, dark: (Int, Int) -> Boolean): Raster {
        val wb = (dots + 7) / 8
        val bits = ByteArray(wb * dots)
        for (y in 0 until dots) {
            val sy = ((2 * y + 1) * h) / (2 * dots)
            for (x in 0 until dots) {
                val sx = ((2 * x + 1) * w) / (2 * dots)
                if (dark(sx, sy)) bits[y * wb + x / 8] = (bits[y * wb + x / 8].toInt() or (0x80 ushr (x % 8))).toByte()
            }
        }
        return Raster(wb, dots, bits)
    }
}

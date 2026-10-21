package com.restopos.core.mra

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.google.zxing.qrcode.QRCodeWriter
import com.restopos.core.print.Raster
import org.junit.Assert.assertEquals
import org.junit.Test

// The MRA's QR code, made 2 cm wide for the printer, still reads.
class MraQrTest {
    private fun read(r: Raster): String {
        val n = r.height
        val pixels = IntArray(n * n) { i ->
            val x = i % n; val y = i / n
            if ((r.bits[y * r.widthBytes + x / 8].toInt() shr (7 - x % 8)) and 1 == 1) 0xFF000000.toInt() else -1
        }
        return QRCodeReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(n, n, pixels)))).text
    }

    @Test fun theQrStillReadsAtTwoCentimetres() {
        // as long as an IRN and the invoice's details would make it
        val text = "MRA|EPTSTD000001|IRN0123456789ABCDEF0123456789ABCDEF|20261021 17:26:00|792.50|72944371"
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 350, 350)
        val r = MraQr.raster(350, 350) { x, y -> m.get(x, y) }
        assertEquals(160, r.height)
        assertEquals(20, r.widthBytes)
        assertEquals(text, read(r))
    }

    // a longer one, more modules in the same 2 cm
    @Test fun aLongerQrStillReads() {
        val text = "https://vfisc.mra.mu/verify?irn=" + "0123456789ABCDEF".repeat(6)
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 350, 350)
        assertEquals(text, read(MraQr.raster(350, 350) { x, y -> m.get(x, y) }))
    }

    @Test fun aWhitePictureIsWhite() {
        val r = MraQr.raster(350, 350) { _, _ -> false }
        assertEquals(0, r.bits.count { it.toInt() != 0 })
    }
}

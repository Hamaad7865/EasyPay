package com.restopos.core.print

import com.restopos.core.mra.MraQr
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// A Premium MRA client's paper (the MRA's guide 8.1.13 and 8.1.14): the QR
// code the MRA sent back, 2 x 2 cm, at the top of what the customer gets,
// just before the title every design has; "Not Yet Fiscalised" in its place
// until the MRA has answered. The IRN is never printed.
class MraPaperTest {
    private val shop = Shop("CafeTino", "Royal Road")
    private val qr = MraQr.raster(350, 350) { x, y -> (x / 10 + y / 10) % 2 == 0 }
    private fun doc(f: Fiscal?) = ReceiptDoc(number = "S1-T1-000128", time = 1_790_000_000_000, order = "Table 4", subtotal = 30000, total = 30000, fiscal = f)
    private val title = Papers.RECEIPT.blocks.first { it.k == "title" }

    @Test fun theQrComesFirstInTheTitle() {
        val outs = PaperWalk.receipt(title, doc(Fiscal.Qr(qr, training = false)), shop, 2, null)
        assertTrue(outs.first() is Out.Picture)
        assertEquals(160, (outs.first() as Out.Picture).r.height)
        assertTrue(outs.any { it is Out.Line && it.s == "RECEIPT" })
    }

    @Test fun notYetFiscalisedWhereTheQrGoes() {
        val look = Docs.receiptLook(doc(Fiscal.NotYet(training = false)), shop, Paper(48, 0, false), 2)
        val at = look.indexOfFirst { it.trim() == "Not Yet Fiscalised" }
        assertTrue(look.toString(), at >= 0)
        assertEquals("RECEIPT", look[at + 1].trim())
    }

    @Test fun aTrainingPaperSaysSo() {
        val look = Docs.receiptLook(doc(Fiscal.NotYet(training = true)), shop, Paper(48, 0, false), 2)
        assertTrue(look.any { it.trim() == "TRAINING" })
        val outs = PaperWalk.receipt(title, doc(Fiscal.Qr(qr, training = true)), shop, 2, null)
        assertTrue(outs.any { it is Out.Line && it.s == "TRAINING" })
    }

    @Test fun aBusinessNotOnTheMraPrintsAsBefore() {
        val look = Docs.receiptLook(doc(null), shop, Paper(48, 0, false), 2)
        assertFalse(look.any { it.contains("Fiscalised") || it.contains("TRAINING") })
        assertEquals(Docs.receiptLook(ReceiptDoc(number = "S1-T1-000128", time = 1_790_000_000_000, order = "Table 4", subtotal = 30000, total = 30000), shop, Paper(48, 0, false), 2), look)
    }

    // the picture is in the bytes, before the title's words
    @Test fun thePictureIsPrinted() {
        val bytes = Docs.receipt(doc(Fiscal.Qr(qr, training = false)), shop, Paper(48, 0, false), 2, null, false, Papers.RECEIPT)
        val raster = (0 until bytes.size - 2).first { bytes[it] == 0x1D.toByte() && bytes[it + 1] == 0x76.toByte() && bytes[it + 2] == 0x30.toByte() }
        val words = String(bytes, Charsets.ISO_8859_1).indexOf("RECEIPT")
        assertTrue(raster in 0 until words)
    }

    // never kept with the receipt: it is read again each time the paper prints
    @Test fun theMarkIsNotKept() {
        val kept = kotlinx.serialization.json.Json { encodeDefaults = false }.encodeToString(ReceiptDoc.serializer(), doc(Fiscal.NotYet(false)))
        assertFalse(kept, kept.contains("fiscal") || kept.contains("Fiscalised"))
    }
}

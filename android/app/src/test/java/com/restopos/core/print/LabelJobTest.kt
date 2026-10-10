package com.restopos.core.print

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelJobTest {
    private fun bytes(vararg b: Int) = ByteArray(b.size) { b[it].toByte() }
    // twelve dots across, two down: four black dots, eight white, then the other way round
    private val small = Raster(2, 2, bytes(0xF0, 0x00, 0x0F, 0xF0))
    private fun count(hay: ByteArray, needle: ByteArray): Int = (0..hay.size - needle.size).count { i -> needle.indices.all { hay[i + it] == needle[it] } }

    @Test fun `a sticker printer is told the label's size, its gap, the picture and how many`() {
        val head = "SIZE 40 mm,30 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 1\r\nCLS\r\nBITMAP 0,0,2,2,0,".toByteArray(Charsets.US_ASCII)
        // in TSPL a set bit is white: every bit of the raster is turned over
        val picture = bytes(0x0F, 0xFF, 0xF0, 0x0F)
        val tail = "\r\nPRINT 1,3\r\n".toByteArray(Charsets.US_ASCII)
        assertArrayEquals(head + picture + tail, LabelJob.tspl(listOf(LabelJob.Label(small, 3)), 40f, 30f, 2f))
    }

    @Test fun `each different label of a run is cleared and drawn, the size said once`() {
        val job = LabelJob.tspl(listOf(LabelJob.Label(small, 1), LabelJob.Label(small, 2)), 37.5f, 25f, 3f)
        val text = String(job, Charsets.ISO_8859_1)
        assertTrue(text.startsWith("SIZE 37.5 mm,25 mm\r\nGAP 3 mm,0 mm\r\n"))
        assertEquals(1, count(job, "SIZE ".toByteArray()))
        assertEquals(2, count(job, "CLS\r\n".toByteArray()))
        assertTrue(text.endsWith("\r\nPRINT 1,2\r\n"))
        assertEquals(1, count(job, "PRINT 1,1\r\n".toByteArray()))
    }

    @Test fun `a receipt printer is sent the picture once for each copy, with a cut`() {
        val job = LabelJob.escpos(listOf(LabelJob.Label(small, 2)), 80).getOrThrow()
        assertArrayEquals(bytes(0x1B, 0x40), job.copyOf(2))
        // a set bit is black there, so the raster goes as it is
        assertEquals(2, count(job, bytes(0x1D, 0x76, 0x30, 0x00, 0x02, 0x00, 0x02, 0x00, 0xF0, 0x00, 0x0F, 0xF0)))
        assertEquals(2, count(job, bytes(0x1D, 0x56, 0x42, 0x00)))
    }

    @Test fun `a label wider than the paper is refused in words`() {
        val wide = Raster(50, 1, ByteArray(50))
        assertEquals(LabelJob.WIDER, LabelJob.escpos(listOf(LabelJob.Label(wide, 1)), 58).exceptionOrNull()?.message)
        assertTrue(LabelJob.escpos(listOf(LabelJob.Label(wide, 1)), 80).isSuccess)
    }

    @Test fun `a run is wrapped in the language its printer speaks`() {
        val t = LabelTemplates.byId("50x25-shop")
        val run = listOf(LabelJob.Label(small, 1))
        val sticker = LabelJob.bytes(LabelPrinter("Stickers", "usb"), run, t).getOrThrow()
        assertTrue(String(sticker, Charsets.ISO_8859_1).startsWith("SIZE 50 mm,25 mm\r\nGAP 2 mm,0 mm\r\n"))
        val receipt = LabelJob.bytes(LabelPrinter("Receipts", "network", "192.168.1.9", language = LabelPrinter.ESCPOS, paper = 58), run, t).getOrThrow()
        assertArrayEquals(bytes(0x1B, 0x40), receipt.copyOf(2))
        val wide = Raster(50, 1, ByteArray(50))
        assertEquals(LabelJob.WIDER, LabelJob.bytes(LabelPrinter("Receipts", "usb", language = LabelPrinter.ESCPOS, paper = 58), listOf(LabelJob.Label(wide, 1)), t).exceptionOrNull()?.message)
    }

    @Test fun `nothing to print is nothing sent`() {
        assertEquals(0, LabelJob.tspl(emptyList(), 40f, 30f, 2f).size)
        assertEquals(0, LabelJob.tspl(listOf(LabelJob.Label(small, 0)), 40f, 30f, 2f).size)
        assertEquals(0, LabelJob.escpos(emptyList(), 80).getOrThrow().size)
    }
}

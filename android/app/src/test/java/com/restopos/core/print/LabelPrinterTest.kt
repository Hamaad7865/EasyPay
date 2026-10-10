package com.restopos.core.print

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LabelPrinterTest {
    private val net = LabelPrinter("Stickers", "network", "192.168.1.50:9100")
    private fun seen(vendor: Int, product: Int, name: String? = null, serial: String? = null) = UsbPick.Seen(vendor, product, name, serial)
    private fun usb(s: UsbPick.Seen) = LabelPrinter("Stickers", "usb", usbVendor = s.vendor, usbProduct = s.product, usbName = s.name, usbSerial = s.serial)
    private fun form(name: String = "Stickers", kind: String = "network", address: String = "192.168.1.50", language: String = "tspl", dpi: Int = 203, paper: Int = 80, usb: UsbPick.Seen? = null) =
        LabelPrinters.form(name, kind, address, language, dpi, paper, usb)

    @Test fun `the tablet keeps it as text and reads it back`() {
        assertEquals(net, LabelPrinters.read(LabelPrinters.write(net)))
        val cable = usb(seen(0x1FC9, 0x2016, "XP-365B", "A1"))
        assertEquals(cable, LabelPrinters.read(LabelPrinters.write(cable)))
    }

    @Test fun `what cannot be read is no printer`() {
        assertNull(LabelPrinters.read(null))
        assertNull(LabelPrinters.read(""))
        assertNull(LabelPrinters.read("{"))
        assertNull(LabelPrinters.read("""{"name":"","kind":"network"}"""))
    }

    @Test fun `the form refuses what could not print`() {
        assertEquals("Give the printer a name", form(name = " ").exceptionOrNull()?.message)
        assertTrue(form(address = "abc").isFailure)
        assertTrue(form(kind = "bluetooth", address = "").isFailure)
        assertEquals(LabelPrinters.PICK_USB, form(kind = "usb").exceptionOrNull()?.message)
    }

    @Test fun `the form reads a printer as it was typed`() {
        val p = form(name = " Stickers ", address = "192.168.1.50:9100").getOrThrow()
        assertEquals(net, p)
        val bt = form(kind = "bluetooth", address = "00:11:22:AA:BB:CC").getOrThrow()
        assertEquals("bluetooth" to "00:11:22:AA:BB:CC", bt.kind to bt.address)
        val cable = form(kind = "usb", address = "left over", usb = seen(1, 2, "XP", null)).getOrThrow()
        assertNull(cable.address)
        assertEquals(listOf(1, 2), listOf(cable.usbVendor, cable.usbProduct))
        // a receipt-type printer keeps its paper; anything odd falls back to what is usual
        assertEquals(58, form(language = "escpos", paper = 58).getOrThrow().paper)
        assertEquals("tspl", form(language = "zpl").getOrThrow().language)
        assertEquals(203, form(dpi = 600).getOrThrow().dpi)
        assertEquals(300, form(dpi = 300).getOrThrow().dpi)
    }

    @Test fun `the label printer is found among what is plugged in`() {
        val a = seen(0x1FC9, 0x2016, "XP-365B", "A1")
        val b = seen(0x1FC9, 0x2016, "XP-365B", "B2")
        val receipt = seen(0x0416, 0x5011, "POS80", null)
        assertEquals(b, UsbPick.match(usb(b), listOf(receipt, a, b)))
        assertEquals(a, UsbPick.match(usb(a), listOf(receipt, a, b)))
        // unplugged, or never a USB printer
        assertNull(UsbPick.match(usb(a), listOf(receipt)))
        assertNull(UsbPick.match(net, listOf(receipt, a)))
        // saved before the tablet would tell its serial number: found by its numbers
        assertEquals(a, UsbPick.match(usb(seen(0x1FC9, 0x2016, "XP-365B", null)), listOf(receipt, a)))
    }

    @Test fun `two printers the tablet cannot tell apart`() {
        val one = seen(0x0416, 0x5011, "POS80", null)
        val other = seen(0x0416, 0x5011, "POS80", null)
        assertTrue(UsbPick.twins(one, listOf(one, other)))
        assertFalse(UsbPick.twins(one, listOf(one)))
        assertFalse(UsbPick.twins(seen(1, 2, "A", "S1"), listOf(seen(1, 2, "A", "S1"), seen(1, 2, "A", "S2"))))
        assertFalse(UsbPick.twins(one, listOf(one, seen(0x1FC9, 0x2016, "XP-365B", null))))
    }

    @Test fun `receipts never go to the label printer`() {
        val label = seen(0x1FC9, 0x2016, "XP-365B", null)
        val receipt = seen(0x0416, 0x5011, "POS80", null)
        assertEquals(receipt, UsbPick.receipt(listOf(label, receipt), usb(label)))
        assertEquals(label, UsbPick.receipt(listOf(label, receipt), null))
        assertEquals(label, UsbPick.receipt(listOf(label, receipt), net))
        assertNull(UsbPick.receipt(listOf(label), usb(label)))
        assertNull(UsbPick.receipt(emptyList(), null))
    }
}
